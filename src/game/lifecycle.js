/**
 * Map loading, level transitions, and full/partial game state resets.
 */

import { state, player } from './state.js';
import { MAPS, mapData, currentMap, setMapState } from '../data/maps.js';
import { equipWeapon } from './combat/weapons.js';
import { resetPossession } from './possession.js';
import * as renderer from '../renderer/index.js';
import { setMapName, flushNow, markAllDirty } from './services.js';
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

    if (isInitialLoad || player.isDead) {
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
 * reset game state, spawn things, initialize doors/lifts/crushers, build
 * spatial queries, and wire sound adjacency. Does not touch the renderer or
 * UI; callers install a renderer host (no-op or recording) beforehand.
 *
 * @param {string} name Map identifier (e.g. 'E1M1')
 * @param {(name: string) => Promise<object>} readMapJson Async loader that
 *   returns parsed map JSON. The server reads from the filesystem; a browser
 *   caller could pass `(n) => fetch('maps/'+n+'.json').then(r => r.json())`.
 */
export async function loadMapHeadless(name, readMapJson) {
    const json = await readMapJson(name);
    setMapState(name, json);
    setMapName(name);
    applyPlayerStart();
    // Always do a full reset on a headless map load. The server owns the
    // authoritative state and starts with fresh inventory/health for the
    // marine on each level.
    resetGameState();
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
    }
    // Player eye height uses the real constant; applyPlayerStart parked the
    // view at +80, which matches the intro-drop final position.
    player.z = player.floorHeight + 80;
}

function applyPlayerStart() {
    player.x = mapData.playerStart.x;
    player.y = mapData.playerStart.y;
    player.angle = mapData.playerStart.angle - Math.PI / 2;
    player.floorHeight = mapData.playerStart.floorHeight || 0;
    player.z = player.floorHeight + 80;
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
    player.isDead = false;
    player.isFiring = false;
    player.sectorDamageTimer = 0;
    state.things = [];
    for (let index = 0; index < state.projectiles.length; index++) {
        renderer.removeProjectile(state.projectiles[index].id);
    }
    state.projectiles = [];
    state.nextProjectileId = 0;
    for (const name in player.powerups) {
        renderer.hidePowerup(name);
        delete player.powerups[name];
    }
    renderer.setPlayerDead(false);
    // Return control to the normal player character; clear any player-AI
    // state and the AI-dead flag carried over from a previous level.
    resetPossession();
}

/** Level transition — keep inventory, clear keys (keys are per-level). */
export function transitionToLevel() {
    clearSceneState();
    player.collectedKeys.clear();
    renderer.clearKeys();
    equipWeapon(player.currentWeapon);
    markAllDirty();
    void flushNow();
}

/** Full reset — new game or respawn after death. */
export function resetGameState() {
    clearSceneState();
    player.health = 100;
    player.armor = 0;
    player.armorType = 0;
    player.ammo.bullets = 50;
    player.ammo.shells = 0;
    player.ammo.rockets = 0;
    player.ammo.cells = 0;
    player.maxAmmo.bullets = 200;
    player.maxAmmo.shells = 50;
    player.maxAmmo.rockets = 50;
    player.maxAmmo.cells = 300;
    player.hasBackpack = false;
    player.currentWeapon = 2;
    player.ownedWeapons.clear();
    player.ownedWeapons.add(1);
    player.ownedWeapons.add(2);
    player.collectedKeys.clear();
    renderer.clearKeys();
    renderer.clearWeaponSlots();
    equipWeapon(player.currentWeapon);
    markAllDirty();
    void flushNow();
}
