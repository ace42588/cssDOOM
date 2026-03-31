/**
 * Shared map data store and loader.
 *
 * Holds the parsed JSON map data (walls, sectors, things, doors, lifts, etc.)
 * loaded from maps/E*M*.json files. Both the game layer and renderer import
 * this directly — it is not owned by either layer.
 *
 * Also owns map loading, level transitions, and map sequencing. The loader
 * orchestrates game state resets and renderer scene (re)builds, but does not
 * own either — it delegates to them.
 */

import { EYE_HEIGHT } from '../game/constants.js';

export const MAPS = ['E1M1', 'E1M2', 'E1M3', 'E1M4', 'E1M5', 'E1M6', 'E1M7', 'E1M8', 'E1M9'];
import { state } from '../game/state.js';
import { transitionToLevel, resetGameState } from '../game/player/damage.js';
import { teardownScene, buildScene } from '../renderer/scene/scene.js';
import { showLevelTransition, hideLevelTransition } from '../ui/overlay.js';
import { buildSectorAdjacency } from '../game/sound-propagation.js';

/** The currently loaded map's parsed JSON data. Null until a map is loaded. */
export let mapData = null;

/** Name of the currently loaded map (e.g. "E1M1"). */
export let currentMap = null;

/** Clears the map data reference (for teardown/GC). */
export function clearMap() {
    mapData = null;
}

/**
 * Fetches a map JSON and applies it to game state: sets player position,
 * resets game/level state, and rebuilds the 3D scene.
 *
 * Handles both initial load (no existing scene) and level transitions
 * (overlay fade, teardown with GPU yield).
 */
export async function loadMap(name) {
    const isInitialLoad = !currentMap;

    if (!isInitialLoad) {
        await showLevelTransition();
    }

    const response = await fetch(`maps/${name}.json`);
    currentMap = name;
    mapData = await response.json();
    applyPlayerStart();

    // Death restarts with a full reset (health/ammo/weapons);
    // level transitions keep the player's inventory intact.
    if (isInitialLoad || state.isDead) {
        resetGameState();
    } else {
        transitionToLevel();
    }

    if (!isInitialLoad) {
        // Tear down old scene and yield to the browser so iOS Safari can
        // release GPU-backed texture memory before we allocate new elements.
        teardownScene();
        await new Promise(r => setTimeout(r, 100));
    }

    await buildScene();
    buildSectorAdjacency();

    // Drop camera from intro height to eye level after scene is ready
    setTimeout(() => { state.playerZ = state.floorHeight + EYE_HEIGHT; }, 600);

    if (!isInitialLoad) {
        hideLevelTransition();
    }
}

/**
 * Sets player position and angle from the current map's start data.
 */
function applyPlayerStart() {
    state.playerX = mapData.playerStart.x;
    state.playerY = mapData.playerStart.y;
    state.playerAngle = mapData.playerStart.angle - Math.PI / 2;
    state.floorHeight = mapData.playerStart.floorHeight || 0;
    // Start camera high, then drop to eye height for intro effect
    state.playerZ = state.floorHeight + 80;
}

export function getNextMap() {
    const currentIndex = MAPS.indexOf(currentMap);
    return currentIndex >= 0 && currentIndex < MAPS.length - 1 ? MAPS[currentIndex + 1] : null;
}

export function getSecretExitMap() {
    return 'E1M9';
}
