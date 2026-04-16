/**
 * Shared geometry/classification helpers for thing entries.
 */

import { BARREL_RADIUS, ENEMY_RADIUS, SHOOTABLE } from "../constants.js";

export function isShootableThing(thing) {
  return SHOOTABLE.has(thing.type);
}

/**
 * Collision radius used for movement blocking.
 */
export function getThingCollisionRadius(thing) {
  if (thing.ai) return thing.ai.radius;
  if (thing.type === 2035) return BARREL_RADIUS;
  if (thing.solidRadius) return thing.solidRadius;
  return null;
}

/**
 * Radius used for combat overlap/radius attacks.
 */
export function getThingDamageRadius(thing) {
  if (thing.ai) return thing.ai.radius;
  if (thing.type === 2035) return BARREL_RADIUS;
  return ENEMY_RADIUS;
}
