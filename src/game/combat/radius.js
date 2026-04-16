/**
 * Shared radius-damage target resolution.
 */

import { PLAYER_RADIUS } from "../constants.js";
import { state, player } from "../state.js";
import { hasLineOfSight } from "../physics/line-of-sight.js";
import { chebyshevDistance } from "../geometry.js";
import { getThingDamageRadius, isShootableThing } from '../things/geometry.js';

/**
 * Iterates all entities affected by radius damage and yields resolved damage.
 * @param {{x:number,y:number}} origin
 * @param {number} maxDamage
 * @param {(target: object, damage: number) => void} onHit
 */
export function forEachRadiusDamageTarget(origin, maxDamage, onHit) {
  const playerDist = chebyshevDistance(origin, player, player.radius ?? PLAYER_RADIUS);
  if (playerDist < maxDamage && hasLineOfSight(origin, player)) {
    onHit(player, maxDamage - playerDist);
  }

  const allThings = state.things;
  for (let i = 0, len = allThings.length; i < len; i++) {
    const thing = allThings[i];
    if (thing.collected) continue;
    if (!isShootableThing(thing)) continue;

    const thingDist = chebyshevDistance(origin, thing, getThingDamageRadius(thing));
    if (thingDist >= maxDamage) continue;
    if (!hasLineOfSight(origin, thing)) continue;

    onHit(thing, maxDamage - thingDist);
  }
}
