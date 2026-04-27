/**
 * Map loading, level transitions, and full/partial game state resets.
 *
 * The marine spawns through the normal `spawnThings()` pipeline (see
 * `src/engine/data/maps.js` which synthesizes a `type: MARINE_ACTOR_TYPE` entry
 * from the map's `playerStart`). No hook here positions or pre-seeds the
 * marine — lifecycle just clears the scene, spawns things, and optionally
 * carries the marine's inventory across level transitions.
 */

import { state, getMarineActor } from './state.js';
import { MAPS, currentMap, setMapState } from './data/maps.js';
import { EYE_HEIGHT } from './constants.js';
import { equipWeapon } from './combat/weapons.js';
import { resetPossession } from './possession.js';
import * as renderer from './ports/renderer.js';
import { setMapName, flushNow, markMapChanged } from './services.js';
import { spawnThings } from './things/spawner.js';
import { initDoors } from './mechanics/doors.js';
import { initLifts } from './mechanics/lifts.js';
import { initCrushers } from './mechanics/crushers.js';
import { buildSpatialGrid, clearSpatialGrid } from './spatial-grid.js';
import { buildSectorAdjacency } from './sound-propagation.js';
import { getFloorHeightAt } from './physics/queries.js';

// ============================================================================
// Map load orchestration
// ============================================================================

/**
 * Headless map load — for the server (or any environment without a DOM).
 * Reads map JSON, reset/transition game state, spawns things (including the
 * marine), initializes doors/lifts/crushers, builds spatial queries, and
 * wires sound adjacency. Does not touch the renderer or UI; callers install
 * a renderer host (no-op or recording) beforehand.
 *
 * @param {string} name Map identifier (e.g. 'E1M1')
 * @param {(name: string) => Promise<object>} readMapJson Async loader that
 *   returns parsed map JSON. The server reads from the filesystem; a browser
 *   caller could pass `(n) => fetch('maps/'+n+'.json').then(r => r.json())`.
 * @param {{ fullReset?: boolean }} [options]
 *   `fullReset: true` (default) wipes inventory/health back to start values —
 *   correct for a fresh server boot or after marine death. `fullReset: false`
 *   preserves health/ammo/weapons and only clears per-level state — the right
 *   choice when transitioning between levels via an exit switch.
 */
export async function loadMapHeadless(name, readMapJson, options = {}) {
    const { fullReset = true } = options;
    const json = await readMapJson(name);

    // Capture inventory from the previous-level marine *before* the scene is
    // wiped; `spawnThings()` below will rebuild it with default gear and we
    // re-apply the carry-over for level transitions.
    const carryInventory = fullReset ? null : snapshotMarineInventory();

    setMapState(name, json);
    setMapName(name);
    clearSceneState();
    spawnThings();
    clearSpatialGrid();
    initDoors();
    initLifts();
    initCrushers();
    buildSpatialGrid();
    buildSectorAdjacency();

    // Sample the floor under each spawned thing now that the spatial grid
    // is ready. AI entities re-sample every tick during movement, but static
    // pickups / barrels / decorations need this baseline so the snapshot
    // carries a real `floorHeight` — otherwise the client renders them
    // floating at world-origin zero.
    for (const thing of state.things) {
        if (typeof thing.floorHeight !== 'number') {
            thing.floorHeight = getFloorHeightAt(thing.x, thing.y);
        }
        if (typeof thing.z !== 'number') {
            thing.z = thing.floorHeight ?? 0;
        }
    }
    for (let i = 0; i < state.actors.length; i++) {
        const actor = state.actors[i];
        if (!actor) continue;
        if (typeof actor.floorHeight !== 'number') {
            actor.floorHeight = getFloorHeightAt(actor.x, actor.y);
        }
        if (typeof actor.z !== 'number') {
            actor.z = actor.floorHeight ?? 0;
        }
    }

    const marine = getMarineActor();
    if (marine) {
        marine.floorHeight = getFloorHeightAt(marine.x, marine.y);
        // Spawn at natural eye height; the intro "fall" is a client-only
        // camera offset driven by `scheduleIntroCameraDrop` (see
        // `src/client/app/level-loader.js`) so each viewer drops their own camera
        // without perturbing the broadcast actor pose.
        marine.z = marine.floorHeight + EYE_HEIGHT;
        if (carryInventory) {
            applyMarineInventory(marine, carryInventory);
        }
        equipWeapon(marine.currentWeapon);
    }

    markMapChanged(currentMap);
    void flushNow();
}

export function getNextMap() {
    const currentIndex = MAPS.indexOf(currentMap);
    return currentIndex >= 0 && currentIndex < MAPS.length - 1 ? MAPS[currentIndex + 1] : null;
}

export function getSecretExitMap() {
    return 'E1M9';
}

// ============================================================================
// Scene / level lifecycle
// ============================================================================

function clearSceneState() {
    // Hide any lingering powerup indicators before their owning marine is
    // dropped; the renderer tracks them as CSS classes, not entity state.
    const outgoingMarine = getMarineActor();
    if (outgoingMarine) {
        for (const name in outgoingMarine.powerups) {
            renderer.hidePowerup(name);
        }
    }
    state.things.length = 0;
    state.actors.length = 0;
    for (let index = 0; index < state.projectiles.length; index++) {
        renderer.removeProjectile(state.projectiles[index].id);
    }
    state.projectiles = [];
    state.nextProjectileId = 0;
    state.doorState.clear();
    state.liftState.clear();
    state.crusherState.clear();
    renderer.setPlayerDead(false);
    renderer.clearKeys();
    renderer.clearWeaponSlots();
    resetPossession();
}

/**
 * Snapshot the marine's inventory into a plain object the caller can hold
 * across a scene wipe and re-apply to the next spawned marine.
 */
function snapshotMarineInventory() {
    const m = getMarineActor();
    if (!m) return null;
    return {
        hp: m.hp,
        maxHp: m.maxHp,
        armor: m.armor,
        armorType: m.armorType,
        ammo: { ...m.ammo },
        maxAmmo: { ...m.maxAmmo },
        hasBackpack: m.hasBackpack,
        currentWeapon: m.currentWeapon,
        ownedWeapons: new Set(m.ownedWeapons),
        // Keys are intentionally dropped at level transitions.
    };
}

function applyMarineInventory(marine, saved) {
    marine.hp = saved.hp;
    marine.maxHp = saved.maxHp;
    marine.armor = saved.armor;
    marine.armorType = saved.armorType;
    for (const k of Object.keys(saved.ammo)) marine.ammo[k] = saved.ammo[k];
    for (const k of Object.keys(saved.maxAmmo)) marine.maxAmmo[k] = saved.maxAmmo[k];
    marine.hasBackpack = saved.hasBackpack;
    marine.currentWeapon = saved.currentWeapon;
    marine.ownedWeapons = new Set(saved.ownedWeapons);
}
