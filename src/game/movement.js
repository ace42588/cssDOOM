/**
 * Player movement: turning, walking, strafing, collision resolution,
 * floor height tracking, and the moving state flag for head-bob / weapon-bob.
 */

import { EYE_HEIGHT, MOVE_SPEED, RUN_MULTIPLIER, TURN_SPEED } from './constants.js';
import { state } from './state.js';
import { canMoveTo, getFloorHeightAt } from './physics.js';
import { playSound } from '../audio/audio.js';
import { updatePlayerFromLift } from './mechanics/lifts.js';
import * as renderer from '../renderer/index.js';
import { input, collectInput } from '../input/index.js';

let wasMoving = false;

export function updateMovement(deltaTime, timestamp) {
    collectInput();
    updateLocation(deltaTime);
    updatePlayerFromLift(timestamp);
    updateHeight();
    updateMovingState();
}

function updateLocation(deltaTime) {

    // Speed modifier
    const speed = input.run ? MOVE_SPEED * RUN_MULTIPLIER : MOVE_SPEED;
    const turnSpeed = input.run ? TURN_SPEED * RUN_MULTIPLIER : TURN_SPEED;

    /* Turning */

    // Rate-based turning (keyboard arrows) + absolute turn deltas (mouse, analog sticks)
    state.playerAngle += input.turn * turnSpeed * deltaTime + input.turnDelta;

    /* Moving */

    // Forward direction (angle 0 = north = +Y).
    const forwardX = -Math.sin(state.playerAngle);
    const forwardY = Math.cos(state.playerAngle);

    // Strafe direction is perpendicular (90° clockwise from forward).
    const strafeX = Math.cos(state.playerAngle);
    const strafeY = Math.sin(state.playerAngle);

    /* Determine desired movement vector */

    let desiredX = state.playerX + forwardX * speed * input.moveY * deltaTime
                                 + strafeX * speed * input.moveX * deltaTime;
    let desiredY = state.playerY + forwardY * speed * input.moveY * deltaTime
                                 + strafeY * speed * input.moveX * deltaTime;

    /**
     * Collision resolution
     *
     * Movement uses a three-step collision approach:
     *   1. Try the full diagonal move (both axes at once).
     *   2. If blocked, try moving only along X (wall sliding on Y axis).
     *   3. If that is also blocked, try moving only along Y (wall sliding on X axis).
     *
     * This gives natural "wall sliding" behavior — the player glides along
     * walls instead of stopping dead when moving diagonally into them.
     */

    if (desiredX !== state.playerX || desiredY !== state.playerY) {
        if (canMoveTo(desiredX, desiredY)) {
            state.playerX = desiredX;
            state.playerY = desiredY;
        } else if (canMoveTo(desiredX, state.playerY)) {
            state.playerX = desiredX;
        } else if (canMoveTo(state.playerX, desiredY)) {
            state.playerY = desiredY;
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
    const prevFloorHeight = state.floorHeight;
    state.floorHeight = getFloorHeightAt(state.playerX, state.playerY);
    state.playerZ = state.floorHeight + EYE_HEIGHT;

    // Based on: linuxdoom-1.10/p_mobj.c:P_ZMovement() — oof on hard landing.
    // DOOM plays sfx_oof when momz < -GRAVITY*8. With gravity=1 unit/tic²,
    // that velocity is reached after falling 32 units (v²=2gh → h=8²/2=32).
    if (prevFloorHeight - state.floorHeight > 32) {
        playSound('DSOOF');
    }
}
