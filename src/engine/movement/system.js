/**
 * Shared actor movement integration and controlled-body movement (player /
 * possessed monster / door camera). Turning, walking, strafing, collision
 * resolution, floor height tracking, and the moving state flag for head-bob /
 * weapon-bob.
 *
 * Under normal play the "controlled actor" is the marine. When the user
 * possesses a monster (via body-swap), the same path drives that monster
 * instead — reading the monster's position/facing, applying its AI speed,
 * and syncing its renderer position when it moves.
 *
 * The authoritative tick calls `updateMovementFor(sessionId, inputSnapshot, dt, timestamp)`
 * once per session per step (see `src/engine/index.js#updateGameMulti`). Tests and
 * tools may call it directly with synthetic input snapshots.
 */

import { resolveSlidingMoveActor } from '../physics/collision.js';
import { EYE_HEIGHT, RUN_MULTIPLIER, TURN_SPEED } from '../constants.js';
import { MARINE_ACTOR_TYPE } from '../state.js';
import { getFloorHeightAt, getSectorAt } from '../physics/queries.js';
import { playSound } from '../ports/audio.js';
import { updateLifts } from '../mechanics/lifts.js';
import * as renderer from '../ports/renderer.js';
import {
    LOCAL_SESSION,
    getControlledFor,
    getControlledSpeed,
} from '../possession.js';
import { getThingIndex } from '../things/registry.js';
import { normalizeAngle } from '../math/angle.js';

/**
 * Step `entity` by `moveVec * deltaTime`, applying sliding collision against
 * walls, things, and lift edges. Mutates `entity.x` / `entity.y` in place and
 * returns the resolved displacement so callers can react (e.g. update facing).
 */
export function integratePlanarMove(entity, moveVec, deltaTime) {
    const fromX = entity.x;
    const fromY = entity.y;
    const to = {
        x: fromX + moveVec.x * deltaTime,
        y: fromY + moveVec.y * deltaTime,
    };
    const resolved = resolveSlidingMoveActor(entity, to);
    entity.x = resolved.x;
    entity.y = resolved.y;
    return {
        moved: resolved.moved,
        fromX,
        fromY,
        toX: resolved.x,
        toY: resolved.y,
    };
}

/**
 * Turn `entity.facing` toward whichever direction it actually moved. Skipped
 * for the marine actor: its facing is locked to the camera/input `viewAngle`
 * (see `setViewAngle`) and the AI marine controller (`updatePlayerFacingForAi`)
 * sets both fields explicitly before stepping.
 */
export function updateActorFacingFromDelta(entity, fromX, fromY, minDistSq = 0.001) {
    if (entity.type === MARINE_ACTOR_TYPE) return;
    const deltaX = entity.x - fromX;
    const deltaY = entity.y - fromY;
    if (deltaX * deltaX + deltaY * deltaY > minDistSq) {
        entity.facing = Math.atan2(deltaY, deltaX);
    }
}

let wasMoving = false;

/**
 * Apply an input snapshot to the body controlled by `sessionId`.
 */
export function updateMovementFor(sessionId, inputSnapshot, deltaTime, timestamp) {
    const entity = getControlledFor(sessionId);
    if (!entity) return;
    if (entity.__isDoorEntity) {
        // Doors are security cameras: yaw only, no translation/physics.
        updateDoorViewAngle(entity, inputSnapshot, deltaTime);
        if (sessionId === LOCAL_SESSION) updateMovingState({ moveX: 0, moveY: 0 });
        return;
    }
    updateLocation(entity, inputSnapshot, deltaTime, sessionId);
    // Lift heights interpolate against `performance.now()`, so calling this
    // once per session per tick is idempotent. (Lifts freeze if no session is
    // bound — pre-existing limitation; flagged for the renderer slice.)
    updateLifts();
    updateHeight(entity);
    if (sessionId === LOCAL_SESSION) updateMovingState(inputSnapshot);
}

function updateDoorViewAngle(doorEntity, inputSnapshot, deltaTime) {
    const turnSpeed = inputSnapshot.run ? TURN_SPEED * RUN_MULTIPLIER : TURN_SPEED;
    const angle = normalizeAngle(
        (doorEntity.viewAngle ?? 0)
        + (inputSnapshot.turn || 0) * turnSpeed * deltaTime
        + (inputSnapshot.turnDelta || 0),
    );
    doorEntity.viewAngle = angle;
    doorEntity.facing = angle + Math.PI / 2;
}

/**
 * View-angle on every controlled body lives at `entity.viewAngle`. The marine
 * is seeded with one at spawn; possessed monsters get one when first possessed
 * (kept in the player convention: 0 = north).
 */
function getViewAngle(entity) {
    if (typeof entity.viewAngle !== 'number') {
        entity.viewAngle = (entity.facing ?? 0) - Math.PI / 2;
    }
    return entity.viewAngle;
}

function setViewAngle(entity, angle) {
    entity.viewAngle = angle;
    entity.facing = angle + Math.PI / 2;
}

function updateLocation(entity, inputSnapshot, deltaTime, sessionId) {
    const baseSpeed = getControlledSpeed(sessionId);
    const speed = inputSnapshot.run ? baseSpeed * RUN_MULTIPLIER : baseSpeed;
    const turnSpeed = inputSnapshot.run ? TURN_SPEED * RUN_MULTIPLIER : TURN_SPEED;

    const angle = normalizeAngle(
        getViewAngle(entity)
        + (inputSnapshot.turn || 0) * turnSpeed * deltaTime
        + (inputSnapshot.turnDelta || 0),
    );
    setViewAngle(entity, angle);

    if (!inputSnapshot.moveX && !inputSnapshot.moveY) return;

    const forwardX = -Math.sin(angle);
    const forwardY = Math.cos(angle);

    const strafeX = Math.cos(angle);
    const strafeY = Math.sin(angle);

    integratePlanarMove(
        entity,
        {
            x: forwardX * speed * (inputSnapshot.moveY || 0) + strafeX * speed * (inputSnapshot.moveX || 0),
            y: forwardY * speed * (inputSnapshot.moveY || 0) + strafeY * speed * (inputSnapshot.moveX || 0),
        },
        deltaTime,
    );

    if (entity.type !== MARINE_ACTOR_TYPE) {
        const idx = getThingIndex(entity);
        entity.floorHeight = getFloorHeightAt(entity.x, entity.y);
        renderer.updateThingPosition(idx, {
            x: entity.x,
            y: entity.y,
            floorHeight: entity.floorHeight,
        });
        const sector = getSectorAt(entity.x, entity.y);
        if (sector) {
            renderer.reparentThingToSector(idx, sector.sectorIndex);
        }
    }
}

function updateMovingState(inputSnapshot) {
    const isMoving = (inputSnapshot.moveX || 0) !== 0 || (inputSnapshot.moveY || 0) !== 0;
    if (isMoving !== wasMoving) {
        wasMoving = isMoving;
        renderer.setPlayerMoving(isMoving);
    }
}

function updateHeight(entity) {
    if (entity.type === MARINE_ACTOR_TYPE) {
        const prevFloorHeight = entity.floorHeight;
        entity.floorHeight = getFloorHeightAt(entity.x, entity.y);
        entity.z = entity.floorHeight + EYE_HEIGHT;

        if (prevFloorHeight - entity.floorHeight > 32) {
            playSound('DSOOF');
        }
    } else {
        entity.floorHeight = getFloorHeightAt(entity.x, entity.y);
    }
}
