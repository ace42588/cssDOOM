/**
 * Player movement: turning, walking, strafing, collision resolution,
 * floor height tracking, and the moving state flag for head-bob / weapon-bob.
 *
 * Under normal play the "controlled actor" is the player object. When the
 * user possesses a monster (via body-swap), the same path drives that
 * monster instead — reading the monster's position/facing, applying its AI
 * speed, and syncing its renderer position when it moves.
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
    getControlled,
    isControllingPlayer,
    getControlledEyeHeight,
    getControlledSpeed,
} from '../possession.js';
import { getThingIndex } from '../things/registry.js';

let wasMoving = false;

export function updateMovement(deltaTime, timestamp) {
    collectInput();
    updateLocation(deltaTime);
    if (isControllingPlayer()) updatePlayerFromLift(timestamp);
    updateHeight();
    updateMovingState();
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
        // Seed from the monster's sprite facing (0 = east, CCW).
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
    // Keep the monster's sprite `facing` roughly aligned so the culling/
    // infighting code that reads `facing` sees a sensible orientation.
    entity.facing = angle + Math.PI / 2;
}

function updateLocation(deltaTime) {
    const entity = getControlled();
    const baseSpeed = getControlledSpeed();
    const speed = input.run ? baseSpeed * RUN_MULTIPLIER : baseSpeed;
    const turnSpeed = input.run ? TURN_SPEED * RUN_MULTIPLIER : TURN_SPEED;

    const angle = getViewAngle(entity) + input.turn * turnSpeed * deltaTime + input.turnDelta;
    setViewAngle(entity, angle);

    if (input.moveX === 0 && input.moveY === 0) return;

    const forwardX = -Math.sin(angle);
    const forwardY = Math.cos(angle);

    const strafeX = Math.cos(angle);
    const strafeY = Math.sin(angle);

    const movementActor = asMovementActor(entity);
    integratePlanarMove(
        movementActor,
        {
            x: forwardX * speed * input.moveY + strafeX * speed * input.moveX,
            y: forwardY * speed * input.moveY + strafeY * speed * input.moveX,
        },
        deltaTime,
    );

    if (entity !== player) {
        // Sync the monster's DOM position and sector attachment so lighting
        // and culling stay in step while the user drives it.
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

function updateMovingState() {
    const isMoving = input.moveX !== 0 || input.moveY !== 0;
    if (isMoving !== wasMoving) {
        wasMoving = isMoving;
        renderer.setPlayerMoving(isMoving);
    }
}

function updateHeight() {
    const entity = getControlled();
    if (entity === player) {
        const prevFloorHeight = player.floorHeight;
        player.floorHeight = getFloorHeightAt(player.x, player.y);
        player.z = player.floorHeight + EYE_HEIGHT;

        if (prevFloorHeight - player.floorHeight > 32) {
            playSound('DSOOF');
        }
    } else {
        // Possessed monster: derive eye-height from its floor + offset.
        // No "DSOOF" here — monsters don't grunt when they drop.
        entity.floorHeight = getFloorHeightAt(entity.x, entity.y);
    }
}
