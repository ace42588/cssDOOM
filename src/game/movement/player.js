/**
 * Player movement: turning, walking, strafing, collision resolution,
 * floor height tracking, and the moving state flag for head-bob / weapon-bob.
 *
 * Under normal play the "controlled actor" is the player object. When the
 * user possesses a monster (via body-swap), the same path drives that
 * monster instead — reading the monster's position/facing, applying its AI
 * speed, and syncing its renderer position when it moves.
 *
 * Multiplayer: `updateMovementFor(sessionId, inputSnapshot, dt, timestamp)`
 * runs the movement for a specific session with a specific input snapshot.
 * The server ticks it once per connected controller; the browser single
 * player path still calls `updateMovement(dt, timestamp)` which wraps the
 * per-session call with the local session + global `input` object.
 */

import { EYE_HEIGHT, RUN_MULTIPLIER, TURN_SPEED } from '../constants.js';
import { player } from '../state.js';
import { getFloorHeightAt, getSectorAt } from '../physics/queries.js';
import { playSound } from '../../audio/audio.js';
import { updatePlayerFromLift } from '../mechanics/lifts.js';
import * as renderer from '../../renderer/index.js';
import { input, collectInput } from '../../input/index.js';
import { asMovementActor } from '../actors/adapter.js';
import { integratePlanarMove } from './system.js';
import {
    LOCAL_SESSION,
    getControlledFor,
    getControlledEyeHeight,
    getControlledSpeed,
} from '../possession.js';
import { getThingIndex } from '../things/registry.js';

let wasMoving = false;

/** Browser single-player entry point — uses the local session + global input. */
export function updateMovement(deltaTime, timestamp) {
    collectInput();
    updateMovementFor(LOCAL_SESSION, input, deltaTime, timestamp);
}

/**
 * Apply an input snapshot to the body controlled by `sessionId`. Called by
 * both the browser (indirectly, via `updateMovement`) and the server (once
 * per connected session per tick).
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
    updateLocation(entity, inputSnapshot, deltaTime);
    if (entity === player) updatePlayerFromLift(timestamp);
    updateHeight(entity);
    if (sessionId === LOCAL_SESSION) updateMovingState(inputSnapshot);
}

function updateDoorViewAngle(doorEntity, inputSnapshot, deltaTime) {
    const turnSpeed = inputSnapshot.run ? TURN_SPEED * RUN_MULTIPLIER : TURN_SPEED;
    const angle = (doorEntity.viewAngle ?? 0)
        + (inputSnapshot.turn || 0) * turnSpeed * deltaTime
        + (inputSnapshot.turnDelta || 0);
    doorEntity.viewAngle = angle;
    doorEntity.facing = angle + Math.PI / 2;
}

/**
 * Returns the current view-angle for the controlled actor. For the player
 * character this is `player.angle` directly. For a possessed monster, the
 * view angle is stored on `thing.viewAngle` (seeded from `thing.facing`
 * when first possessed, kept in the player convention: 0 = north).
 */
function getViewAngle(entity) {
    if (entity === player) return player.angle;
    if (typeof entity.viewAngle !== 'number') {
        entity.viewAngle = (entity.facing ?? 0) - Math.PI / 2;
    }
    return entity.viewAngle;
}

function setViewAngle(entity, angle) {
    if (entity === player) {
        player.angle = angle;
        return;
    }
    entity.viewAngle = angle;
    entity.facing = angle + Math.PI / 2;
}

function updateLocation(entity, inputSnapshot, deltaTime) {
    const sessionId = entity.__sessionId || LOCAL_SESSION;
    const baseSpeed = getControlledSpeed(sessionId);
    const speed = inputSnapshot.run ? baseSpeed * RUN_MULTIPLIER : baseSpeed;
    const turnSpeed = inputSnapshot.run ? TURN_SPEED * RUN_MULTIPLIER : TURN_SPEED;

    const angle = getViewAngle(entity)
        + (inputSnapshot.turn || 0) * turnSpeed * deltaTime
        + (inputSnapshot.turnDelta || 0);
    setViewAngle(entity, angle);

    if (!inputSnapshot.moveX && !inputSnapshot.moveY) return;

    const forwardX = -Math.sin(angle);
    const forwardY = Math.cos(angle);

    const strafeX = Math.cos(angle);
    const strafeY = Math.sin(angle);

    const movementActor = asMovementActor(entity);
    integratePlanarMove(
        movementActor,
        {
            x: forwardX * speed * (inputSnapshot.moveY || 0) + strafeX * speed * (inputSnapshot.moveX || 0),
            y: forwardY * speed * (inputSnapshot.moveY || 0) + strafeY * speed * (inputSnapshot.moveX || 0),
        },
        deltaTime,
    );

    if (entity !== player) {
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
    if (entity === player) {
        const prevFloorHeight = player.floorHeight;
        player.floorHeight = getFloorHeightAt(player.x, player.y);
        player.z = player.floorHeight + EYE_HEIGHT;

        if (prevFloorHeight - player.floorHeight > 32) {
            playSound('DSOOF');
        }
    } else {
        entity.floorHeight = getFloorHeightAt(entity.x, entity.y);
    }
}
