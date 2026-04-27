/**
 * Actor-first math helpers used by movement, targeting, and combat.
 */

import { horizontalDistanceSquared } from '../geometry.js';
import { getMarineActor } from '../state.js';

export function distance2(actorA, actorB) {
    return horizontalDistanceSquared(actorA, actorB);
}

export function inRadius(actorA, actorB, radius) {
    return distance2(actorA, actorB) < radius * radius;
}

/**
 * Resolve the concrete actor an AI entity is currently targeting.
 * `ai.target` is always an actor reference or `null`; setters that want
 * "the default marine target" should use `getMarineActor()` at write
 * time so downstream reads never see a string sentinel. A `null` target
 * falls back to the current marine (still nullable when no marine is
 * alive — callers must tolerate that).
 */
export function resolveTargetActor(ownerActor) {
    const ai = ownerActor?.ai;
    if (!ai) return null;
    const target = ai.target;
    if (target && typeof target === 'object') return target;
    return getMarineActor();
}
