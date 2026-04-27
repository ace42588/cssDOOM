/**
 * Collision detection, sliding movement resolution, and hitscan ray casting.
 *
 * Movement helpers (`canMoveToActor`, `resolveSlidingMoveActor`) take the moving
 * actor entity directly; per-actor capability blocks (`actor.maxDropHeight`,
 * `actor.height`, `actor.radius`, `actor.floorHeight`) supply the geometry.
 * No callsite samples the marine singleton — every read is the actual mover.
 */

import { MAX_STEP_HEIGHT } from '../constants.js';
import { state, debug } from '../state.js';
import { isDoorClosed, getDoorEntry } from '../mechanics/doors.js';
import { circleLineCollision } from '../geometry.js';
import { forEachWallInAABB } from '../spatial-grid.js';
import { getFloorHeightAt } from './queries.js';
import { getThingCollisionRadius } from '../things/geometry.js';

function crossesLinedef(prevX, prevY, newX, newY, wall) {
    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;

    const oldSide = (prevX - wall.start.x) * dy - (prevY - wall.start.y) * dx;
    const newSide = (newX - wall.start.x) * dy - (newY - wall.start.y) * dx;

    if ((oldSide > 0) === (newSide > 0)) return false;

    return true;
}

function canMoveToRaw(prevX, prevY, newX, newY, radius, moverHeight, currentFloorHeight, maxDropHeight, excludeThing) {
    if (debug.noclip) return true;

    const moverTop = currentFloorHeight + moverHeight;
    let blocked = false;
    forEachWallInAABB(newX - radius, newY - radius, newX + radius, newY + radius, wall => {
        const doorEntry = getDoorEntry(wall);
        if (doorEntry) {
            if (doorEntry.passable) return;
        } else if (wall.isUpperWall && wall.bottomHeight !== undefined && wall.topHeight !== undefined) {
            if (wall.topHeight <= currentFloorHeight || wall.bottomHeight >= moverTop) return;
            if (!crossesLinedef(prevX, prevY, newX, newY, wall)) return;
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

    // Iterate every actor (start at 0); the moving actor itself is excluded by
    // identity via `excludeThing`. The marine actor has no thing-collision
    // radius (`getThingCollisionRadius` returns null for it), so it never
    // blocks movement here regardless of slot.
    for (let i = 0, ac = state.actors.length; i < ac; i++) {
        const thing = state.actors[i];
        if (!thing || thing.collected || thing === excludeThing) continue;
        const thingRadius = getThingCollisionRadius(thing);
        if (thingRadius === null) continue;
        const deltaX = newX - thing.x;
        const deltaY = newY - thing.y;
        const combinedRadius = radius + thingRadius;
        if (deltaX * deltaX + deltaY * deltaY < combinedRadius * combinedRadius) {
            return false;
        }
    }
    const things = state.things;
    for (let i = 0, thingCount = things.length; i < thingCount; i++) {
        const thing = things[i];
        if (!thing || thing.collected || thing === excludeThing) continue;
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

/**
 * Test whether `actor` can move to `(newX, newY)`.
 *
 * Reads collision params from the actor's flat capability mirrors:
 *   - `actor.radius`        — collision circle (marine: PLAYER_RADIUS, monsters: ai.radius)
 *   - `actor.height`        — vertical extent for upper-wall passage
 *   - `actor.maxDropHeight` — Infinity for marine, MAX_STEP_HEIGHT for monsters
 *   - `actor.floorHeight`   — pre-step floor sample (kept current by the caller)
 *
 * `options.maxDropHeight` / `options.excludeThing` override per-call. By default
 * the actor itself is the excluded body so it doesn't collide with its own slot.
 */
export function canMoveToActor(actor, newX, newY, options = {}) {
    const maxDropHeight = options.maxDropHeight ?? actor.maxDropHeight ?? Infinity;
    const excludeThing = options.excludeThing ?? actor;
    const prevX = actor.x;
    const prevY = actor.y;
    const moverHeight = actor.height;
    if (typeof moverHeight !== 'number') {
        throw new Error('[collision] Mover is missing .height');
    }
    const currentFloorHeight = actor.floorHeight ?? getFloorHeightAt(prevX, prevY);
    return canMoveToRaw(prevX, prevY, newX, newY, actor.radius, moverHeight, currentFloorHeight, maxDropHeight, excludeThing);
}

/**
 * Try to slide `actor` from its current position to `to` (axis-aligned fallback
 * when the diagonal step is blocked). Returns the resolved position and whether
 * any movement happened. Caller is responsible for assigning the result back
 * onto the actor.
 */
export function resolveSlidingMoveActor(actor, to) {
    const fromX = actor.x;
    const fromY = actor.y;
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

/**
 * Cast a horizontal ray through the wall set, returning the nearest wall-hit
 * point or null if the ray reaches `maxDistance` without intersecting a wall.
 * `rayZ` is the height at which the ray travels; walls are only considered
 * solid if they intersect that height (upper/lower/middle wall bounds).
 */
export function rayHitPoint(originX, originY, directionX, directionY, maxDistance, rayZ) {
    let closestHitDistance = maxDistance;
    const endX = originX + directionX * maxDistance;
    const endY = originY + directionY * maxDistance;

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
                if (wallBottom === undefined || rayZ < wallBottom || rayZ > wallTop) return;
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
