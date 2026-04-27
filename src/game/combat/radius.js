/**
 * Shared radius-damage target resolution. Iterates every shootable actor
 * and every shootable thing uniformly — no marine special case. Actors
 * that should be exempt from radius damage set an explicit capability
 * (today: barrel excludes itself; future: invulnerability / immunity
 * blocks evaluated by `applyDamage` in `./damage.js`).
 */

import { state } from "../state.js";
import { hasLineOfSight } from "../physics/line-of-sight.js";
import { chebyshevDistance } from "../geometry.js";
import { getThingDamageRadius, isShootableThing } from '../things/geometry.js';

function actorRadius(actor) {
  if (typeof actor.radius === 'number') return actor.radius;
  if (actor.ai) return actor.ai.radius;
  return 0;
}

/**
 * Iterate every entity within `maxDamage` chebyshev distance of `origin`
 * and invoke `onHit(target, damage)` with the distance-falloff damage value.
 * Walks `state.actors` (marine + monsters) then `state.things` (barrels,
 * shootable decorations).
 *
 * @param {{x:number,y:number}} origin
 * @param {number} maxDamage
 * @param {(target: object, damage: number) => void} onHit
 */
export function forEachRadiusDamageTarget(origin, maxDamage, onHit) {
  for (let i = 0, len = state.actors.length; i < len; i++) {
    const actor = state.actors[i];
    if (!actor || actor.collected) continue;
    if ((actor.hp ?? 0) <= 0 || actor.deathMode) continue;

    const dist = chebyshevDistance(origin, actor, actorRadius(actor));
    if (dist >= maxDamage) continue;
    if (!hasLineOfSight(origin, actor)) continue;

    onHit(actor, maxDamage - dist);
  }

  for (let i = 0, len = state.things.length; i < len; i++) {
    const thing = state.things[i];
    if (!thing || thing.collected) continue;
    if (!isShootableThing(thing)) continue;

    const dist = chebyshevDistance(origin, thing, getThingDamageRadius(thing));
    if (dist >= maxDamage) continue;
    if (!hasLineOfSight(origin, thing)) continue;

    onHit(thing, maxDamage - dist);
  }
}
