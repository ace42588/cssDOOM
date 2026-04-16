/**
 * Collision detection, sliding movement resolution, and hitscan ray casting.
 */

import { PLAYER_HEIGHT, MAX_STEP_HEIGHT, EYE_HEIGHT } from '../constants.js';
import { state, player, debug } from '../state.js';
import { isDoorClosed, getDoorEntry } from '../mechanics/doors.js';
import { circleLineCollision } from '../geometry.js';
import { forEachWallInAABB } from '../spatial-grid.js';
import { getFloorHeightAt, getSectorAt } from './queries.js';
import { getThingCollisionRadius } from '../things/geometry.js';
import { asMovementActor, assertMovementActor } from '../actors/adapter.js';

function crossesLinedef(newX, newY, _radius, wall) {
    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;

    const oldSide = (player.x - wall.start.x) * dy - (player.y - wall.start.y) * dx;
    const newSide = (newX - wall.start.x) * dy - (newY - wall.start.y) * dx;

    if ((oldSide > 0) === (newSide > 0)) return false;

    return true;
}

function canMoveToRaw(newX, newY, radius, currentFloorHeight, maxDropHeight = Infinity, excludeThing = null) {
    if (debug.noclip) return true;

    const playerTop = currentFloorHeight + (player.height ?? PLAYER_HEIGHT);
    let blocked = false;
    forEachWallInAABB(newX - radius, newY - radius, newX + radius, newY + radius, wall => {
        const doorEntry = getDoorEntry(wall);
        if (doorEntry) {
            if (doorEntry.passable) return;
        } else if (wall.isUpperWall && wall.bottomHeight !== undefined && wall.topHeight !== undefined) {
            if (wall.topHeight <= currentFloorHeight || wall.bottomHeight >= playerTop) return;
            if (!crossesLinedef(newX, newY, radius, wall)) return;
        } else if (wall.isSolid) {
        } else {
            return;
        }
        if (circleLineCollision(newX, newY, radius,
            wall.start.x, wall.start.y, wall.end.x, wall.end.y)) {
            blocked = true;
            return false;
        }
    });
    if (blocked) return false;

    const things = state.things;
    for (let i = 0, thingCount = things.length; i < thingCount; i++) {
        const thing = things[i];
        if (thing.collected || thing === excludeThing) continue;
        const thingRadius = getThingCollisionRadius(thing);
        if (thingRadius === null) continue;
        const deltaX = newX - thing.x;
        const deltaY = newY - thing.y;
        const combinedRadius = radius + thingRadius;
        if (deltaX * deltaX + deltaY * deltaY < combinedRadius * combinedRadius) {
            return false;
        }
    }

    for (const [, liftEntry] of state.liftState) {
        const edges = liftEntry.collisionEdges;
        if (!edges) continue;
        if (currentFloorHeight >= liftEntry.currentHeight - MAX_STEP_HEIGHT) continue;
        for (let i = 0, edgeCount = edges.length; i < edgeCount; i++) {
            const edge = edges[i];
            if (circleLineCollision(newX, newY, radius, edge.start.x, edge.start.y, edge.end.x, edge.end.y)) {
                return false;
            }
        }
    }

    const newFloorHeight = getFloorHeightAt(newX, newY);
    if (newFloorHeight - currentFloorHeight > MAX_STEP_HEIGHT) return false;
    if (currentFloorHeight - newFloorHeight > maxDropHeight) return false;
    return true;
}

export function canMoveTo(newX, newY, radius, currentFloorHeight, maxDropHeight = Infinity, excludeThing = null) {
    return canMoveToRaw(newX, newY, radius, currentFloorHeight, maxDropHeight, excludeThing);
}

export function canMoveToActor(actor, newX, newY, options = {}) {
    assertMovementActor(actor, 'canMoveToActor');
    const maxDropHeight = options.maxDropHeight ?? actor.maxDropHeight ?? Infinity;
    const excludeThing = options.excludeThing ?? actor.excludeThing ?? null;
    const currentFloorHeight =
        actor.kind === 'player'
            ? (actor.floorHeight ?? getFloorHeightAt(actor.x, actor.y))
            : getFloorHeightAt(actor.entity.x, actor.entity.y);
    return canMoveToRaw(newX, newY, actor.radius, currentFloorHeight, maxDropHeight, excludeThing);
}

export function resolveSlidingMoveActor(actor, to) {
    assertMovementActor(actor, 'resolveSlidingMove');

    const fromX = actor.entity.x;
    const fromY = actor.entity.y;
    const toX = to.x;
    const toY = to.y;

    const canAt = (nx, ny) => canMoveToActor(actor, nx, ny);

    if (toX === fromX && toY === fromY) {
        return { x: fromX, y: fromY, moved: false };
    }
    if (canAt(toX, toY)) {
        return { x: toX, y: toY, moved: true };
    }
    if (canAt(toX, fromY)) {
        return { x: toX, y: fromY, moved: true };
    }
    if (canAt(fromX, toY)) {
        return { x: fromX, y: toY, moved: true };
    }
    return { x: fromX, y: fromY, moved: false };
}

export function resolveSlidingMove(actorOrEntity, to) {
    const actor = actorOrEntity?.entity ? actorOrEntity : asMovementActor(actorOrEntity);
    return resolveSlidingMoveActor(actor, to);
}

export function rayHitPoint(originX, originY, directionX, directionY, maxDistance) {
    let closestHitDistance = maxDistance;
    const endX = originX + directionX * maxDistance;
    const endY = originY + directionY * maxDistance;
    const eyeZ = player.floorHeight + EYE_HEIGHT;

    forEachWallInAABB(
        Math.min(originX, endX), Math.min(originY, endY),
        Math.max(originX, endX), Math.max(originY, endY),
        wall => {
            if (wall.isUpperWall || wall.isLowerWall || wall.isMiddleWall) {
                if (wall.isUpperWall && !isDoorClosed(wall)) {
                    const door = getDoorEntry(wall);
                    if (door && door.passable) return;
                }
                let wallBottom = wall.bottomHeight;
                let wallTop = wall.topHeight;
                if (wall.isLiftWall) {
                    const lift = state.liftState.get(wall.liftSectorIndex);
                    if (lift) {
                        const neighborFloor = wall.topHeight === lift.upperHeight
                            ? wall.bottomHeight : wall.topHeight;
                        wallBottom = Math.min(neighborFloor, lift.currentHeight);
                        wallTop = Math.max(neighborFloor, lift.currentHeight);
                    }
                }
                if (wallBottom === undefined || eyeZ < wallBottom || eyeZ > wallTop) return;
            } else if (!wall.isSolid && !isDoorClosed(wall)) {
                return;
            }

            const segmentDeltaX = wall.end.x - wall.start.x;
            const segmentDeltaY = wall.end.y - wall.start.y;
            const crossProductDenominator = directionX * segmentDeltaY - directionY * segmentDeltaX;
            if (Math.abs(crossProductDenominator) < 1e-8) return;

            const rayParameter = ((wall.start.x - originX) * segmentDeltaY - (wall.start.y - originY) * segmentDeltaX) / crossProductDenominator;
            const segmentParameter = ((wall.start.x - originX) * directionY - (wall.start.y - originY) * directionX) / crossProductDenominator;
            if (rayParameter > 0 && rayParameter < closestHitDistance && segmentParameter >= 0 && segmentParameter <= 1) {
                closestHitDistance = rayParameter;
            }
        }
    );

    if (closestHitDistance >= maxDistance) return null;
    return { x: originX + directionX * closestHitDistance, y: originY + directionY * closestHitDistance };
}

export function getSectorLightAt(x, y) {
    const sector = getSectorAt(x, y);
    return sector?.lightLevel ?? 255;
}
