/**
 * Shared actor movement integration helpers.
 */

import { resolveSlidingMoveActor } from '../physics/collision.js';

export function integratePlanarMove(actor, moveVec, deltaTime) {
    const fromX = actor.entity.x;
    const fromY = actor.entity.y;
    const to = {
        x: fromX + moveVec.x * deltaTime,
        y: fromY + moveVec.y * deltaTime,
    };
    const resolved = resolveSlidingMoveActor(actor, to);
    actor.entity.x = resolved.x;
    actor.entity.y = resolved.y;
    return {
        moved: resolved.moved,
        fromX,
        fromY,
        toX: resolved.x,
        toY: resolved.y,
    };
}

export function updateActorFacingFromDelta(actor, fromX, fromY, minDistSq = 0.001) {
    if (actor.kind === 'player') return;
    const deltaX = actor.entity.x - fromX;
    const deltaY = actor.entity.y - fromY;
    if (deltaX * deltaX + deltaY * deltaY > minDistSq) {
        actor.entity.facing = Math.atan2(deltaY, deltaX);
    }
}
