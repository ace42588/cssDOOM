/**
 * Lifts
 *
 * Lifts (elevators) work via a dual-system approach:
 *   - Visual movement: The renderer smoothly animates the platform and its contents
 *     between upper and lower positions.
 *   - Physics sync: An ease-in-out interpolation runs each frame to keep
 *     `currentHeight` in sync with the visual animation, so collision detection
 *     and floor-height queries reflect the lift's position at all times.
 *
 * Shaft walls are static geometry spanning the gap between lowerHeight and upperHeight,
 * positioned at upperHeight so they are always visible behind the moving platform.
 *
 * Walk-over triggers use edge detection: the trigger only fires when the player
 * crosses INTO range of a trigger linedef (wasNear=false -> isNear=true), preventing
 * repeated activation while standing near a trigger line.
 *
 * Collision edges block the player from walking into the lift shaft from below when
 * the platform is raised, handled externally by the collision system.
 */

import { USE_RANGE, WALK_TRIGGER_RANGE, LIFT_RAISE_DELAY, LIFT_USE_SPECIAL } from '../constants.js';

import { state } from '../state.js';
import { mapData } from '../../shared/maps.js';
import { playSound } from '../../audio/audio.js';
import * as renderer from '../../renderer/index.js';

const LIFT_MOVE_DURATION = 1.0; // seconds — must match renderer animation duration

// Cached flat array of { sectorIndex, entry } for zero-alloc iteration in the hot path
let liftEntries = [];

export function initLifts() {
    state.liftState = new Map();
    if (!mapData.lifts) return;

    for (const lift of mapData.lifts) {
        const heightDelta = lift.upperHeight - lift.lowerHeight;
        if (heightDelta <= 0) continue;

        // Build the visual representation via the renderer
        renderer.buildLift(lift);

        state.liftState.set(lift.sectorIndex, {
            sectorIndex: lift.sectorIndex,
            tag: lift.tag,
            upperHeight: lift.upperHeight,
            lowerHeight: lift.lowerHeight,
            collisionEdges: lift.collisionEdges || [],
            currentHeight: lift.upperHeight,
            targetHeight: lift.upperHeight,
            moving: false,
            timer: null
        });
    }

    // Cache flat array for zero-alloc iteration in the per-frame hot path
    liftEntries = [];
    state.liftState.forEach((entry, sectorIndex) => {
        liftEntries.push({ sectorIndex, entry });
    });
}

export function activateLift(sectorIndex) {
    const liftState = state.liftState.get(sectorIndex);
    if (!liftState) return;

    // Ignore if already lowered or moving down
    if (liftState.targetHeight === liftState.lowerHeight) return;

    // Begin lowering: set up interpolation state and trigger animation
    liftState.targetHeight = liftState.lowerHeight;
    liftState.moving = true;
    liftState.moveStart = performance.now() / 1000;
    liftState.moveFrom = liftState.currentHeight;
    renderer.setLiftState(sectorIndex, 'lowered');
    playSound('DSPSTART');

    // Schedule automatic raise after the configured delay
    clearTimeout(liftState.timer);
    liftState.timer = setTimeout(() => raiseLift(sectorIndex), LIFT_RAISE_DELAY);
}

function raiseLift(sectorIndex) {
    const liftState = state.liftState.get(sectorIndex);
    if (!liftState) return;

    // Begin raising: set up interpolation state and trigger animation
    liftState.targetHeight = liftState.upperHeight;
    liftState.moving = true;
    liftState.moveStart = performance.now() / 1000;
    liftState.moveFrom = liftState.currentHeight;
    renderer.setLiftState(sectorIndex, 'raised');
    playSound('DSPSTOP');
    liftState.timer = null;
}

/**
 * Called each frame to interpolate lift heights in sync with the renderer animation.
 * Uses an ease-in-out curve that matches the renderer's easing so that the
 * currentHeight closely tracks the visual position of the animated platform.
 */
export function updatePlayerFromLift(timestamp) {
    const currentTimeSeconds = timestamp / 1000;
    for (let index = 0, count = liftEntries.length; index < count; index++) {
        const liftState = liftEntries[index].entry;
        if (!liftState.moving) continue;

        const elapsedSeconds = currentTimeSeconds - liftState.moveStart;
        const interpolation = Math.min(1, elapsedSeconds / LIFT_MOVE_DURATION);

        // Renderer uses ease-in-out (cubic-bezier 0.42, 0, 0.58, 1).
        // Approximate with a cubic that closely matches for physics sync.
        const t = interpolation;
        const easedInterpolation = t * t * (3 - 2 * t);

        liftState.currentHeight = liftState.moveFrom + (liftState.targetHeight - liftState.moveFrom) * easedInterpolation;

        if (interpolation >= 1) {
            liftState.currentHeight = liftState.targetHeight;
            liftState.moving = false;
        }
    }
}

/**
 * Check all walk-over trigger lines each frame.
 * For each trigger linedef, compute the closest point on the line segment to the
 * player and check if the player is within WALK_TRIGGER_RANGE. Uses edge detection
 * (only fires when crossing INTO range, not while standing near) to prevent
 * repeated activation on consecutive frames.
 */
export function checkWalkOverTriggers() {
    const triggers = mapData.triggers;
    if (!triggers) return;

    for (let index = 0, count = triggers.length; index < count; index++) {
        const trigger = triggers[index];

        // Compute the vector along the trigger linedef
        const deltaX = trigger.end.x - trigger.start.x;
        const deltaY = trigger.end.y - trigger.start.y;
        const lengthSquared = deltaX * deltaX + deltaY * deltaY;
        if (lengthSquared === 0) continue;

        // Project the player position onto the trigger line segment, clamped to [0, 1]
        let parameter = ((state.playerX - trigger.start.x) * deltaX + (state.playerY - trigger.start.y) * deltaY) / lengthSquared;
        parameter = Math.max(0, Math.min(1, parameter));

        // Find the closest point on the segment to the player
        const closestX = trigger.start.x + parameter * deltaX;
        const closestY = trigger.start.y + parameter * deltaY;
        const distSq = (state.playerX - closestX) ** 2 + (state.playerY - closestY) ** 2;

        // Edge detection: only fire when the player crosses into range, not while
        // continuously standing near the trigger line
        const wasPreviouslyNear = trigger._wasNear || false;
        const isCurrentlyNear = distSq < WALK_TRIGGER_RANGE * WALK_TRIGGER_RANGE;
        trigger._wasNear = isCurrentlyNear;

        if (isCurrentlyNear && !wasPreviouslyNear) {
            // Activate all lifts whose tag matches this trigger's sector tag
            for (let liftIndex = 0, liftCount = liftEntries.length; liftIndex < liftCount; liftIndex++) {
                if (liftEntries[liftIndex].entry.tag === trigger.sectorTag) {
                    activateLift(liftEntries[liftIndex].sectorIndex);
                }
            }
        }
    }
}

/**
 * Attempt to activate a lift in front of the player (triggered by the "use" key).
 * Checks nearby walls for linedefs with the lift-use special type (62: SR Lower
 * Lift Wait Raise) and activates any matching lifts.
 * Based on: linuxdoom-1.10/p_map.c:PTR_UseTraverse() → EV_DoPlat()
 */
export function tryUseLift() {
    if (!liftEntries.length) return;

    const forwardX = -Math.sin(state.playerAngle);
    const forwardY = Math.cos(state.playerAngle);
    const checkX = state.playerX + forwardX * USE_RANGE / 2;
    const checkY = state.playerY + forwardY * USE_RANGE / 2;

    for (const wall of mapData.walls) {
        const linedef = mapData.linedefs[wall.linedefIndex];
        if (!linedef || linedef.specialType !== LIFT_USE_SPECIAL) continue;

        const dx = wall.end.x - wall.start.x;
        const dy = wall.end.y - wall.start.y;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) continue;

        let t = ((checkX - wall.start.x) * dx + (checkY - wall.start.y) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        const closestX = wall.start.x + t * dx;
        const closestY = wall.start.y + t * dy;
        const dist = Math.sqrt((checkX - closestX) ** 2 + (checkY - closestY) ** 2);

        if (dist < USE_RANGE) {
            for (let i = 0; i < liftEntries.length; i++) {
                if (liftEntries[i].entry.tag === linedef.sectorTag) {
                    activateLift(liftEntries[i].sectorIndex);
                }
            }
            return;
        }
    }
}
