/**
 * Doors
 *
 * Handles door initialization, toggling, and player interaction.
 *
 * How doors work:
 * - Visual animation: The renderer smoothly animates the door's face walls and
 *   ceiling surfaces between open and closed positions.
 * - State tracking: A Map (state.doorState) tracks each door by sector index,
 *   storing whether it is open/closed and its auto-close timer.
 * - Physics/collision: The door's closedHeight and openHeight are used elsewhere
 *   for collision detection. The `open` boolean lets movement code know whether
 *   the doorway is passable.
 * - Door types: DOOM doors are upper-texture walls that slide up into the ceiling.
 *   The "face walls" are the textured front faces that move, while "track walls"
 *   are the static side jambs that frame the doorway opening.
 * - Auto-close: After opening, a timer schedules automatic closing. If the player
 *   activates an already-open door, the timer resets.
 *
 * Access gating (`getDoorControlMode()` from `services.js`, server-owned):
 * - `standard`: keys only; open immediately.
 * - `sgnl`: `evaluateAccess` (SGNL); deny when not allowed.
 * - `player`: if a human possesses the door entity, operator approve/deny; else
 *   same as standard.
 */

import { USE_RANGE, DOOR_CLOSE_DELAY, DOOR_CONTROL_MODE, DOOR_CLOSE_TRAVEL_MS } from '../constants.js';

import { state } from '../state.js';
import { mapData } from '../../data/maps.js';
import { getSectorAt } from '../physics/queries.js';
import { playSound } from '../../audio/audio.js';
import * as renderer from '../../renderer/index.js';
import { markEntityDirty, evaluateAccess, getDoorControlMode } from '../services.js';

/** Canonical runtime / SGNL asset id for a door (no map qualifier). */
function doorAssetId(sectorIndex) {
    return `door:${sectorIndex}`;
}
import {
    getControlled,
    getSessionIdControlling,
    isHumanControlled,
    describeInteractor,
    onPossessionChange,
} from '../possession.js';

const OPERATOR_REQUEST_TIMEOUT_MS = 15_000;
let nextRequestId = 1;

// When a door loses its operator (release, disconnect, swap away), drain
// any queued use-attempts so interactors don't hang waiting for a decision.
onPossessionChange(() => {
    if (!state.doorState) return;
    for (const doorEntry of state.doorState.values()) {
        const doorEntity = doorEntry.doorEntity;
        if (!doorEntity) continue;
        if (doorEntity.pendingRequests.length === 0) continue;
        if (!isHumanControlled(doorEntity)) {
            drainDoorRequestsFor(doorEntity);
        }
    }
});

const DOOR_PASSABLE_DELAY = 0.8; // seconds — slightly before fully open to allow ducking under

/**
 * Identify the controller requesting the open, so the services host can map
 * it to a principal. `ai` bodies carry no session id; we tag them as such so
 * the server skips evaluation.
 */
function getRequestingController(controller) {
    if (!controller) return null;
    return getSessionIdControlling(controller) || 'local';
}

/**
 * Returns the door entry for a door wall, or null if not a door.
 */
export function getDoorEntry(wall) {
    if (!wall.isUpperWall) return null;
    return state.doorState.get(wall.frontSectorIndex) || state.doorState.get(wall.backSectorIndex) || null;
}

/**
 * Returns true if the given wall is a door that is currently closed.
 */
export function isDoorClosed(wall) {
    const doorEntry = getDoorEntry(wall);
    return doorEntry ? !doorEntry.open : false;
}

/**
 * Initialize all doors from map data.
 * Creates container elements for door animation, moves relevant ceiling and
 * face-wall elements into each container, and builds static track side walls.
 */
export function initDoors() {
    state.doorState = new Map();
    if (!mapData.doors) return;

    for (const door of mapData.doors) {
        // Identify face walls — any upper wall bordering the door sector
        const faceWalls = [];
        for (const wall of mapData.walls) {
            if (!wall.isUpperWall) continue;
            if (wall.frontSectorIndex !== door.sectorIndex && wall.backSectorIndex !== door.sectorIndex) continue;
            faceWalls.push(wall);
        }

        // Identify track walls — solid walls adjacent to face walls that form the door jambs
        const trackWalls = [];
        for (const wall of mapData.walls) {
            if (!wall.isSolid || wall.isDoor) continue;
            if (wall.bottomHeight !== door.floorHeight || wall.topHeight !== door.closedHeight) continue;
            if (!wall.texture || wall.texture === '-') continue;
            const isAdjacent = faceWalls.some(fw =>
                (wall.start.x === fw.start.x && wall.start.y === fw.start.y) ||
                (wall.start.x === fw.end.x && wall.start.y === fw.end.y) ||
                (wall.end.x === fw.start.x && wall.end.y === fw.start.y) ||
                (wall.end.x === fw.end.x && wall.end.y === fw.end.y)
            );
            if (isAdjacent) trackWalls.push(wall);
        }

        // Build the visual representation via the renderer
        renderer.buildDoor(door, trackWalls);

        const doorEntity = buildDoorEntity(door);
        state.doorState.set(door.sectorIndex, {
            open: false,
            sectorIndex: door.sectorIndex,
            passable: false,
            closingUntil: 0,
            timer: null,
            passableTimer: null,
            evaluating: false,
            keyRequired: door.keyRequired || null,
            doorEntity,
        });
    }
}

/**
 * Build a possessable "entity" stub for a door. The entity has no `ai`
 * and no sprite, but looks enough like a thing that the possession /
 * camera code can treat it uniformly (see `src/game/possession.js`).
 *
 * Camera placement: centroid of the door sector's wall endpoints, at
 * the ceiling height of an adjacent corridor (the door sector's own
 * ceiling is the animated one and is of no use to a fixed camera).
 */
function buildDoorEntity(door) {
    const { centerX, centerY, cameraZ, adjacentSectorIndex } = computeDoorCamera(door);
    return {
        __isDoorEntity: true,
        sectorIndex: door.sectorIndex,
        adjacentSectorIndex,
        kind: 'door',
        x: centerX,
        y: centerY,
        z: cameraZ,
        floorHeight: cameraZ,
        viewAngle: 0,
        facing: Math.PI / 2,
        radius: 0,
        pendingRequests: [],
        keyRequired: door.keyRequired || null,
    };
}

/**
 * Compute a security-camera pose for a door. Falls back to the door's
 * own floor/closed height if no adjacent sector can be found (pathological
 * map data).
 */
function computeDoorCamera(door) {
    const sectorIndex = door.sectorIndex;
    let sumX = 0;
    let sumY = 0;
    let points = 0;
    let adjacentSectorIndex = -1;

    for (const wall of mapData.walls) {
        const touches =
            wall.sectorIndex === sectorIndex ||
            wall.frontSectorIndex === sectorIndex ||
            wall.backSectorIndex === sectorIndex;
        if (!touches) continue;

        sumX += wall.start.x + wall.end.x;
        sumY += wall.start.y + wall.end.y;
        points += 2;

        if (adjacentSectorIndex < 0) {
            if (wall.frontSectorIndex !== undefined && wall.frontSectorIndex !== sectorIndex) {
                adjacentSectorIndex = wall.frontSectorIndex;
            } else if (wall.backSectorIndex !== undefined && wall.backSectorIndex !== sectorIndex) {
                adjacentSectorIndex = wall.backSectorIndex;
            }
        }
    }

    const centerX = points > 0 ? sumX / points : 0;
    const centerY = points > 0 ? sumY / points : 0;

    const sectors = mapData.sectors || [];
    const adj = adjacentSectorIndex >= 0 ? sectors[adjacentSectorIndex] : null;
    const ceilingZ = adj?.ceilingHeight ?? door.openHeight ?? door.closedHeight ?? 0;
    // Park the camera just below the adjacent ceiling so it doesn't
    // clip through it. If ceiling is very low, fall back to a modest
    // height above the door top.
    const minZ = (door.openHeight ?? door.closedHeight ?? 0) + 16;
    const cameraZ = Math.max(minZ, ceilingZ - 4);

    return { centerX, centerY, cameraZ, adjacentSectorIndex };
}

/**
 * Walk every live hazard-susceptible actor and report whether any of them is
 * standing in the door sector. Used by `closeDoor` to defer auto-close so the
 * door doesn't crush an actor it would damage.
 */
function anyHazardActorInSector(sectorIndex) {
    for (let i = 0, len = state.actors.length; i < len; i++) {
        const actor = state.actors[i];
        if (!actor) continue;
        if (actor.collected || (actor.hp ?? 0) <= 0) continue;
        if (!actor.movement?.hazardSusceptible) continue;
        const sector = getSectorAt(actor.x, actor.y);
        if (sector && sector.sectorIndex === sectorIndex) return true;
    }
    return false;
}

/**
 * Toggle a door open. If already open, reset the auto-close timer.
 * The renderer handles the open/close animation.
 */
export async function toggleDoor(sectorIndex, requestedBy) {
    const doorEntry = state.doorState.get(sectorIndex);
    if (!doorEntry) return;

    // Check key requirement — block if the requester doesn't have the required key.
    // Read from the requester's own inventory; possessed monsters carry no
    // `collectedKeys` set today, so they will be denied unless they pick keys
    // up themselves once Slice E gives monsters a key-bearing capability.
    // Based on: linuxdoom-1.10/p_doors.c:EV_VerticalDoor()
    if (doorEntry.keyRequired && !doorEntry.open) {
        const keys = requestedBy?.collectedKeys;
        if (!keys || !keys.has(doorEntry.keyRequired)) {
            playSound('DSOOF');
            return;
        }
    }

    if (doorEntry.open) {
        // Already open -- reset the auto-close timer so it stays open longer
        clearTimeout(doorEntry.timer);
        doorEntry.timer = setTimeout(() => closeDoor(sectorIndex), DOOR_CLOSE_DELAY);
        markEntityDirty('door', doorAssetId(sectorIndex));
        return;
    }

    if (doorEntry.evaluating) return;

    // Wrap the whole evaluation+commit in try/finally so `evaluating` is
    // always cleared when the access check short-circuits or the operator
    // path rejects. Without this, the flag stays true forever after the first
    // open and the door never toggles again.
    doorEntry.evaluating = true;
    try {
        const controller = requestedBy || getControlled();
        const mode = getDoorControlMode();

        switch (mode) {
            case DOOR_CONTROL_MODE.SGNL: {
                const evaluation = await evaluateAccess(
                    getRequestingController(controller),
                    doorAssetId(sectorIndex),
                    'open',
                );
                if (!evaluation.allowed) {
                    playSound('DSOOF');
                    const denyMessage = evaluation.reasons?.[0] || 'Access denied';
                    renderer.showHudMessage(denyMessage);
                    return;
                }
                break;
            }
            case DOOR_CONTROL_MODE.PLAYER:
                if (isHumanControlled(doorEntry.doorEntity)) {
                    const decision = await enqueueOperatorRequest(doorEntry, controller);
                    if (decision !== 'open') {
                        playSound('DSOOF');
                        renderer.showHudMessage('Access denied');
                        return;
                    }
                }
                break;
            case DOOR_CONTROL_MODE.STANDARD:
            default:
                break;
        }

        doorEntry.open = true;
        doorEntry.passable = false;
        doorEntry.closingUntil = 0;
        clearTimeout(doorEntry.passableTimer);
        doorEntry.passableTimer = setTimeout(() => {
            doorEntry.passable = true;
            markEntityDirty('door', doorAssetId(sectorIndex));
        }, DOOR_PASSABLE_DELAY * 1000);
        renderer.setDoorState(sectorIndex, 'open');
        playSound('DSDOROPN');
        doorEntry.timer = setTimeout(() => closeDoor(sectorIndex), DOOR_CLOSE_DELAY);
        markEntityDirty('door', doorAssetId(sectorIndex));
    } finally {
        doorEntry.evaluating = false;
    }
}

/**
 * Close a door by resetting its state and triggering the close animation.
 * If any hazard-susceptible actor is inside the door sector, reverse the door
 * (reopen) to avoid crushing them — matches DOOM's T_VerticalDoor() blocked-
 * check behavior, generalised so monsters who can be crushed also block the
 * close.
 * Based on: linuxdoom-1.10/p_doors.c:T_VerticalDoor()
 */
function closeDoor(sectorIndex) {
    const doorEntry = state.doorState.get(sectorIndex);
    if (!doorEntry || !doorEntry.open) return;

    if (anyHazardActorInSector(sectorIndex)) {
        doorEntry.timer = setTimeout(() => closeDoor(sectorIndex), DOOR_CLOSE_DELAY);
        markEntityDirty('door', doorAssetId(sectorIndex));
        return;
    }

    doorEntry.open = false;
    doorEntry.passable = false;
    doorEntry.closingUntil = Date.now() + DOOR_CLOSE_TRAVEL_MS;
    clearTimeout(doorEntry.passableTimer);
    doorEntry.timer = null;
    renderer.setDoorState(sectorIndex, 'closed');
    playSound('DSDORCLS');
    markEntityDirty('door', doorAssetId(sectorIndex));
}

/**
 * Attempt to open a door in front of the player (triggered by the "use" key).
 * Casts a point forward from the player's position and checks if it is within
 * USE_RANGE of any wall that borders a door sector.
 * In DOOM, doors can be opened by pressing any wall adjacent to the door sector,
 * not just walls whose linedef has a door special type.
 * Based on: linuxdoom-1.10/p_map.c:PTR_UseTraverse()
 */
export async function tryOpenDoor(requestedBy) {
    if (!state.doorState.size) return;

    const controller = requestedBy || getControlled();
    if (!controller) return;
    const originX = controller.x;
    const originY = controller.y;
    const originAngle = controller.viewAngle ?? controller.facing ?? 0;

    // Calculate a check point in front of the controller (halfway to USE_RANGE)
    const forwardX = -Math.sin(originAngle);
    const forwardY = Math.cos(originAngle);
    const checkPointX = originX + forwardX * USE_RANGE / 2;
    const checkPointY = originY + forwardY * USE_RANGE / 2;

    for (const wall of mapData.walls) {
        if (!wall.isUpperWall) continue;
        // Skip walls whose linedef targets a remote sector by tag — those
        // trigger a specific action (switch, walk-over, etc.) and should not
        // also open the adjacent door generically.
        const linedef = mapData.linedefs[wall.linedefIndex];
        if (linedef?.sectorTag > 0) continue;
        // Check if this wall borders any door sector
        const doorSectorIndex = state.doorState.has(wall.frontSectorIndex) ? wall.frontSectorIndex
            : state.doorState.has(wall.backSectorIndex) ? wall.backSectorIndex
            : null;
        if (doorSectorIndex === null) continue;

        // Find the closest point on the wall segment to the check point
        const segmentDeltaX = wall.end.x - wall.start.x;
        const segmentDeltaY = wall.end.y - wall.start.y;
        const segmentLengthSquared = segmentDeltaX * segmentDeltaX + segmentDeltaY * segmentDeltaY;
        if (segmentLengthSquared === 0) continue;

        // Project checkPoint onto the wall segment, clamped to [0, 1]
        let projectionParameter = ((checkPointX - wall.start.x) * segmentDeltaX + (checkPointY - wall.start.y) * segmentDeltaY) / segmentLengthSquared;
        projectionParameter = Math.max(0, Math.min(1, projectionParameter));

        const closestPointX = wall.start.x + projectionParameter * segmentDeltaX;
        const closestPointY = wall.start.y + projectionParameter * segmentDeltaY;
        const distanceToWall = Math.sqrt((checkPointX - closestPointX) ** 2 + (checkPointY - closestPointY) ** 2);

        if (distanceToWall < USE_RANGE) {
            await toggleDoor(doorSectorIndex, controller);
            return;
        }
    }
}

/**
 * Queue a use-attempt for human review. The promise returned here resolves
 * when the operator's decision arrives via `resolveDoorRequest`, or when
 * the operator releases the door, or a safety timeout fires.
 *
 * The request summary is visible to the operator client via the snapshot
 * (see `server/world.js#fillDoorRecord`) and is also consumed by the door
 * operator UI on the client.
 */
function enqueueOperatorRequest(doorEntry, controller) {
    const doorEntity = doorEntry.doorEntity;
    const requestId = nextRequestId++;
    const { approachSide, approachAngle } = computeApproachSide(doorEntity, controller);
    const summary = describeInteractor(controller);

    if (doorEntity.pendingRequests.length === 0 && typeof approachAngle === 'number') {
        doorEntity.viewAngle = approachAngle;
        doorEntity.facing = approachAngle + Math.PI / 2;
    }

    return new Promise((resolve) => {
        const entry = {
            id: requestId,
            interactorId: summary.id,
            interactorLabel: summary.label,
            interactorDetails: summary.details,
            approachSide,
            approachAngle,
            resolve,
            timer: null,
        };
        entry.timer = setTimeout(() => {
            resolveDoorRequest(doorEntity.sectorIndex, requestId, 'ignore');
        }, OPERATOR_REQUEST_TIMEOUT_MS);

        doorEntity.pendingRequests.push(entry);
        markEntityDirty('door', doorAssetId(doorEntity.sectorIndex));
    });
}

/**
 * Resolve the operator's pending request with 'open' or 'ignore'. Safe to
 * call with a stale id (no-op). Called from the in-process modal (SP) and
 * from the server after a `doorDecision` input arrives (MP).
 */
export function resolveDoorRequest(sectorIndex, requestId, decision) {
    const doorEntry = state.doorState.get(sectorIndex);
    if (!doorEntry) return;
    const queue = doorEntry.doorEntity.pendingRequests;
    const idx = queue.findIndex((r) => r.id === requestId);
    if (idx < 0) return;
    const [entry] = queue.splice(idx, 1);
    if (entry.timer) clearTimeout(entry.timer);
    try { entry.resolve(decision === 'open' ? 'open' : 'ignore'); } catch {}
    markEntityDirty('door', doorAssetId(sectorIndex));
}

/**
 * Called when the operator releases a door — pending requests auto-deny so
 * the interactor doesn't hang forever.
 */
function drainDoorRequestsFor(doorEntity) {
    if (!doorEntity) return;
    const queue = doorEntity.pendingRequests;
    while (queue.length) {
        const entry = queue.shift();
        if (entry.timer) clearTimeout(entry.timer);
        try { entry.resolve('ignore'); } catch {}
    }
}

function computeApproachSide(doorEntity, controller) {
    if (!controller) return { approachSide: 'unknown', approachAngle: null };
    const originX = controller.x ?? 0;
    const originY = controller.y ?? 0;
    const dx = originX - doorEntity.x;
    const dy = originY - doorEntity.y;
    if (dx === 0 && dy === 0) return { approachSide: 'same-sector', approachAngle: null };
    const heading = Math.atan2(-dx, dy); // DOOM convention: 0 = north, CCW+
    const compass = (Math.abs(dx) > Math.abs(dy))
        ? (dx > 0 ? 'east' : 'west')
        : (dy > 0 ? 'north' : 'south');
    return { approachSide: compass, approachAngle: heading };
}
