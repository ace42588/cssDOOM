/**
 * Map loading, level transitions, and full/partial game state resets.
 */

import { state, getMarine } from './state.js';

const marine = () => getMarine();
import { MAPS, mapData, currentMap, setMapState } from '../data/maps.js';
import { equipWeapon } from './combat/weapons.js';
import { resetPossession } from './possession.js';
import * as renderer from '../renderer/index.js';
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
 * Fetches a map JSON and applies it to game state: sets player position,
 * resets game/level state, and rebuilds the 3D scene.
 */
export async function loadMap(name) {
    const isInitialLoad = !currentMap;
    // Pull in the DOM-heavy level loader lazily so this module can run
    // on the server without touching a `document`.
    const {
        beginLevelTransition,
        rebuildLevelScene,
        scheduleIntroCameraDrop,
        endLevelTransition,
    } = await import('../app/level-loader.js');

    await beginLevelTransition(isInitialLoad);

    const response = await fetch(`maps/${name}.json`);
    const json = await response.json();
    setMapState(name, json);
    setMapName(name);
    applyPlayerStart();

    if (isInitialLoad || marine().deathMode === 'gameover') {
        resetGameState();
    } else {
        transitionToLevel();
    }

    // Spawn game entities first so the DOM builder can match against them.
    spawnThings();
    await rebuildLevelScene(isInitialLoad);
    scheduleIntroCameraDrop();
    endLevelTransition(isInitialLoad);
}

/**
 * Headless map load — for the server (or any environment without a DOM).
 * Performs the pure-data portion of `loadMap`: read JSON, apply player start,
 * reset/transition game state, spawn things, initialize doors/lifts/crushers,
 * build spatial queries, and wire sound adjacency. Does not touch the renderer
 * or UI; callers install a renderer host (no-op or recording) beforehand.
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
    setMapState(name, json);
    setMapName(name);
    applyPlayerStart();
    if (fullReset) {
        resetGameState();
    } else {
        transitionToLevel();
    }
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
    for (let i = 1; i < state.actors.length; i++) {
        const actor = state.actors[i];
        if (!actor) continue;
        if (typeof actor.floorHeight !== 'number') {
            actor.floorHeight = getFloorHeightAt(actor.x, actor.y);
        }
        if (typeof actor.z !== 'number') {
            actor.z = actor.floorHeight ?? 0;
        }
    }
    // Player eye height uses the real constant; applyPlayerStart parked the
    // view at +80, which matches the intro-drop final position.
    marine().z = marine().floorHeight + 80;
}

function applyPlayerStart() {
    marine().x = mapData.playerStart.x;
    marine().y = mapData.playerStart.y;
    marine().viewAngle = mapData.playerStart.angle - Math.PI / 2;
    marine().facing = marine().viewAngle + Math.PI / 2;
    marine().floorHeight = mapData.playerStart.floorHeight || 0;
    marine().z = marine().floorHeight + 80;
}

export function getNextMap() {
    const currentIndex = MAPS.indexOf(currentMap);
    return currentIndex >= 0 && currentIndex < MAPS.length - 1 ? MAPS[currentIndex + 1] : null;
}

export function getSecretExitMap() {
    return 'E1M9';
}

// ============================================================================
// Scene / level lifecycle (called on map change)
// ============================================================================

function clearSceneState() {
    marine().deathMode = null;
    marine().isFiring = false;
    marine().sectorDamageTimer = 0;
    state.things = [];
    while (state.actors.length > 1) state.actors.pop();
    for (let index = 0; index < state.projectiles.length; index++) {
        renderer.removeProjectile(state.projectiles[index].id);
    }
    state.projectiles = [];
    state.nextProjectileId = 0;
    for (const name in marine().powerups) {
        renderer.hidePowerup(name);
        delete marine().powerups[name];
    }
    renderer.setPlayerDead(false);
    // Return control to the normal player character; clear any player-AI
    // state and the AI-dead flag carried over from a previous level.
    resetPossession();
}

/** Level transition — keep inventory, clear keys (keys are per-level). */
export function transitionToLevel() {
    clearSceneState();
    marine().collectedKeys.clear();
    renderer.clearKeys();
    equipWeapon(marine().currentWeapon);
    markMapChanged(currentMap);
    void flushNow();
}

/** Full reset — new game or respawn after death. */
export function resetGameState() {
    clearSceneState();
    marine().hp = 100;
    marine().maxHp = 100;
    marine().armor = 0;
    marine().armorType = 0;
    marine().ammo.bullets = 50;
    marine().ammo.shells = 0;
    marine().ammo.rockets = 0;
    marine().ammo.cells = 0;
    marine().maxAmmo.bullets = 200;
    marine().maxAmmo.shells = 50;
    marine().maxAmmo.rockets = 50;
    marine().maxAmmo.cells = 300;
    marine().hasBackpack = false;
    marine().currentWeapon = 2;
    marine().ownedWeapons.clear();
    marine().ownedWeapons.add(1);
    marine().ownedWeapons.add(2);
    marine().collectedKeys.clear();
    renderer.clearKeys();
    renderer.clearWeaponSlots();
    equipWeapon(marine().currentWeapon);
    markMapChanged(currentMap);
    void flushNow();
}
