/**
 * Canonical thing registry helpers.
 *
 * The game state array (`state.things`) is the source of truth for thing IDs.
 * Renderer DOM maps and gameplay systems must use these helpers so ownership of
 * `thingIndex` allocation and lookup stays centralized.
 *
 * `entity/id.js` and movement/damage interop use this registry for stable
 * `thing:<index>` ids until a full entity store replaces array indices.
 *
 * Migration gate: preserve stable `thingIndex` identity until a full entity
 * store replaces array-index addressing end-to-end.
 */

import { ACTOR_DOM_KEY_OFFSET } from '../constants.js';
import { state } from '../state.js';

/**
 * Allocates a stable thing index and stores the entry in game state.
 * @param {object} entry
 * @returns {number}
 */
export function registerThingEntry(entry) {
  const thingIndex = state.things.length;
  entry.thingIndex = thingIndex;
  state.things.push(entry);
  return thingIndex;
}

/**
 * Registers an actor (marine or enemy). `thingIndex` is set to a stable DOM
 * key disjoint from pickup/barrel indices in `state.things`. The marine is
 * spawned from `mapData.things[0]` (see `src/engine/data/maps.js`) and therefore
 * always lands at `actorIndex === 0`; other actors append after it.
 * @returns {number} actorIndex
 */
export function registerActorEntry(entry) {
  const actorIndex = state.actors.length;
  entry.actorIndex = actorIndex;
  entry.thingIndex = ACTOR_DOM_KEY_OFFSET + actorIndex;
  state.actors.push(entry);
  return actorIndex;
}

/**
 * Resolves a thing's stable index.
 * Falls back to `indexOf` only for legacy callers and caches the result.
 * @param {object} thing
 * @returns {number}
 */
export function getThingIndex(thing) {
  if (!thing) return -1;
  if (thing.thingIndex !== undefined) return thing.thingIndex;
  const index = state.things.indexOf(thing);
  if (index >= 0) {
    thing.thingIndex = index;
  }
  return index;
}

/** Actor slot in `state.actors`, or `-1`. */
export function getActorIndex(entity) {
  if (!entity || typeof entity.actorIndex !== 'number') return -1;
  return entity.actorIndex;
}
