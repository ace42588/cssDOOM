/**
 * Map loading, level transitions, and full/partial game state resets.
 */

import { state, player } from './state.js';
import { MAPS, mapData, currentMap, setMapState } from '../data/maps.js';
import { equipWeapon } from './combat/weapons.js';
import { resetPossession } from './possession.js';
import * as renderer from '../renderer/index.js';
import {
    beginLevelTransition,
    rebuildLevelScene,
    scheduleIntroCameraDrop,
    endLevelTransition,
} from '../app/level-loader.js';
import { setScimMapName, flushScimNow, markAllScimDirty } from '../sgnl/client/scim.js';

// ============================================================================
// Map load orchestration
// ============================================================================

/**
 * Fetches a map JSON and applies it to game state: sets player position,
 * resets game/level state, and rebuilds the 3D scene.
 */
export async function loadMap(name) {
    const isInitialLoad = !currentMap;
    await beginLevelTransition(isInitialLoad);

    const response = await fetch(`maps/${name}.json`);
    const json = await response.json();
    setMapState(name, json);
    setScimMapName(name);
    applyPlayerStart();

    if (isInitialLoad || player.isDead) {
        resetGameState();
    } else {
        transitionToLevel();
    }

    await rebuildLevelScene(isInitialLoad);
    scheduleIntroCameraDrop();
    endLevelTransition(isInitialLoad);
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
    markAllScimDirty();
    void flushScimNow();
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
    markAllScimDirty();
    void flushScimNow();
}
