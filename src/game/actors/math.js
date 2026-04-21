/**
 * Actor-first math helpers used by movement, targeting, and combat.
 */

import { horizontalDistanceSquared } from '../geometry.js';
import { resolveTargetEntity } from '../entity/interop.js';

export function distance2(actorA, actorB) {
    return horizontalDistanceSquared(actorA, actorB);
}

export function inRadius(actorA, actorB, radius) {
    return distance2(actorA, actorB) < radius * radius;
}

export function resolveTargetActor(ownerActor, playerActor) {
    if (!ownerActor?.ai) return playerActor;
    return resolveTargetEntity(ownerActor.ai.target, playerActor);
}
