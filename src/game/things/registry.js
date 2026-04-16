/**
 * Canonical thing registry helpers.
 *
 * The game state array (`state.things`) is the source of truth for thing IDs.
 * Renderer DOM maps and gameplay systems must use these helpers so ownership of
 * `thingIndex` allocation and lookup stays centralized.
 *
 * Actor adapters (`game/actors/adapter.js`) consume this registry for
 * stable actor IDs during the signature unification migration.
 *
 * Migration gate: preserve stable `thingIndex` identity until a full entity
 * store replaces array-index addressing end-to-end.
 */

import { state } from "../state.js";

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
