/**
 * Map data store (parsed JSON). Loaded map identity and JSON live here.
 * Map loading orchestration lives in `src/engine/lifecycle.js`.
 */

import { MARINE_ACTOR_TYPE } from '../state.js';

export const MAPS = ['E1M1', 'E1M2', 'E1M3', 'E1M4', 'E1M5', 'E1M6', 'E1M7', 'E1M8', 'E1M9'];

/** The currently loaded map's parsed JSON data. Null until a map is loaded. */
export let mapData = null;

/** Name of the currently loaded map (e.g. "E1M1"). */
export let currentMap = null;

/**
 * Raw map JSON carries a legacy `playerStart` block outside `things`. We
 * synthesize a regular `type: MARINE_ACTOR_TYPE` entry at the front of
 * `data.things` so the marine spawns through the same `spawnThings()` pipeline
 * as every other actor, and strip `playerStart` from the stored map data.
 */
function normalizeMapThings(data) {
    if (!data) return data;
    const start = data.playerStart;
    if (!Array.isArray(data.things)) data.things = [];
    if (start) {
        // Present on every skill + single/coop/DM; matches P_SpawnPlayer in
        // linuxdoom-1.10/p_mobj.c which spawns the marine unconditionally.
        const MARINE_SPAWN_FLAGS = 0b0000_0111;
        data.things.unshift({
            type: MARINE_ACTOR_TYPE,
            x: start.x,
            y: start.y,
            z: 0,
            angle: ((start.angle ?? 0) * 180) / Math.PI,
            floorHeight: start.floorHeight ?? 0,
            flags: MARINE_SPAWN_FLAGS,
        });
    }
    delete data.playerStart;
    return data;
}

/** Updates loaded map identity and JSON (only mutators for ES module export bindings). */
export function setMapState(name, data) {
    currentMap = name;
    mapData = normalizeMapThings(data);
}

/** Clears the map data reference (for teardown/GC). */
export function clearMap() {
    mapData = null;
}
