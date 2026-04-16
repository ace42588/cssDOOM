/**
 * Player movement: turning, walking, strafing, collision resolution,
 * floor height tracking, and the moving state flag for head-bob / weapon-bob.
 */

import { EYE_HEIGHT, RUN_MULTIPLIER, TURN_SPEED } from '../constants.js';
import { player } from '../state.js';
import { getFloorHeightAt } from '../physics/queries.js';
import { playSound } from '../../audio/audio.js';
import { updatePlayerFromLift } from '../mechanics/lifts.js';
import * as renderer from '../../renderer/index.js';
import { input, collectInput } from '../../input/index.js';
import { asMovementActor } from '../actors/adapter.js';
import { integratePlanarMove } from './system.js';

let wasMoving = false;

export function updateMovement(deltaTime, timestamp) {
    collectInput();
    updateLocation(deltaTime);
    updatePlayerFromLift(timestamp);
    updateHeight();
    updateMovingState();
}

function updateLocation(deltaTime) {
    const speed = input.run ? player.speed * RUN_MULTIPLIER : player.speed;
    const turnSpeed = input.run ? TURN_SPEED * RUN_MULTIPLIER : TURN_SPEED;

    player.angle += input.turn * turnSpeed * deltaTime + input.turnDelta;

    const forwardX = -Math.sin(player.angle);
    const forwardY = Math.cos(player.angle);

    const strafeX = Math.cos(player.angle);
    const strafeY = Math.sin(player.angle);

    const movementActor = asMovementActor(player);
    integratePlanarMove(
        movementActor,
        {
            x: forwardX * speed * input.moveY + strafeX * speed * input.moveX,
            y: forwardY * speed * input.moveY + strafeY * speed * input.moveX,
        },
        deltaTime,
    );
}

function updateMovingState() {
    const isMoving = input.moveX !== 0 || input.moveY !== 0;
    if (isMoving !== wasMoving) {
        wasMoving = isMoving;
        renderer.setPlayerMoving(isMoving);
    }
}

function updateHeight() {
    const prevFloorHeight = player.floorHeight;
    player.floorHeight = getFloorHeightAt(player.x, player.y);
    player.z = player.floorHeight + EYE_HEIGHT;

    if (prevFloorHeight - player.floorHeight > 32) {
        playSound('DSOOF');
    }
}
