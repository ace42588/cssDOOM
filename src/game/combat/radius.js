/**
 * Shared radius-damage target resolution.
 */

import { PLAYER_RADIUS } from "../constants.js";
import { state, getMarine } from "../state.js";
import { hasLineOfSight } from "../physics/line-of-sight.js";
import { chebyshevDistance } from "../geometry.js";
import { getThingDamageRadius, isShootableThing } from '../things/geometry.js';

/**
 * Iterates all entities affected by radius damage and yields resolved damage.
 * Walks `state.actors` (marine + shootable enemies) then `state.things`
 * (barrels and other shootable map things).
 *
 * @param {{x:number,y:number}} origin
 * @param {number} maxDamage
 * @param {(target: object, damage: number) => void} onHit
 */
export function forEachRadiusDamageTarget(origin, maxDamage, onHit) {
  const m = getMarine();
  for (let i = 0, len = state.actors.length; i < len; i++) {
    const thing = state.actors[i];
    if (!thing || thing.collected) continue;

    if (thing === m) {
      const playerDist = chebyshevDistance(origin, m, m.radius ?? PLAYER_RADIUS);
      if (playerDist < maxDamage && hasLineOfSight(origin, m)) {
        onHit(m, maxDamage - playerDist);
      }
      continue;
    }

    if (!isShootableThing(thing)) continue;

    const thingDist = chebyshevDistance(origin, thing, getThingDamageRadius(thing));
    if (thingDist >= maxDamage) continue;
    if (!hasLineOfSight(origin, thing)) continue;

    onHit(thing, maxDamage - thingDist);
  }

  for (let i = 0, len = state.things.length; i < len; i++) {
    const thing = state.things[i];
    if (!thing || thing.collected) continue;
    if (!isShootableThing(thing)) continue;

    const thingDist = chebyshevDistance(origin, thing, getThingDamageRadius(thing));
    if (thingDist >= maxDamage) continue;
    if (!hasLineOfSight(origin, thing)) continue;

    onHit(thing, maxDamage - thingDist);
  }
}
