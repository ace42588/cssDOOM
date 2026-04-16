/**
 * Map data store (parsed JSON). Loaded map identity and JSON live here.
 * Map loading orchestration lives in `src/game/lifecycle.js`.
 */

export const MAPS = ['E1M1', 'E1M2', 'E1M3', 'E1M4', 'E1M5', 'E1M6', 'E1M7', 'E1M8', 'E1M9'];

/** The currently loaded map's parsed JSON data. Null until a map is loaded. */
export let mapData = null;

/** Name of the currently loaded map (e.g. "E1M1"). */
export let currentMap = null;

/** Updates loaded map identity and JSON (only mutators for ES module export bindings). */
export function setMapState(name, data) {
    currentMap = name;
    mapData = data;
}

/** Clears the map data reference (for teardown/GC). */
export function clearMap() {
    mapData = null;
}
