/**
 * Application-level level lifecycle orchestration.
 *
 * Keeps sequencing concerns out of shared map data and renderer scene build.
 */

import { EYE_HEIGHT } from "../game/constants.js";
import { player } from "../game/state.js";
import { clearSpatialGrid, buildSpatialGrid } from "../game/spatial-grid.js";
import { initDoors } from "../game/mechanics/doors.js";
import { initLifts } from "../game/mechanics/lifts.js";
import { initCrushers } from "../game/mechanics/crushers.js";
import { buildSectorAdjacency } from "../game/sound-propagation.js";
import { teardownScene, buildScene } from "../renderer/scene/scene.js";
import { showLevelTransition, hideLevelTransition } from "../ui/overlay.js";

export async function beginLevelTransition(isInitialLoad) {
  if (!isInitialLoad) {
    await showLevelTransition();
  }
}

export async function rebuildLevelScene(isInitialLoad) {
  if (!isInitialLoad) {
    teardownScene();
    clearSpatialGrid();
    // Let mobile browsers release GPU memory before rebuilding.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  await buildScene();
  initDoors();
  initLifts();
  initCrushers();
  buildSpatialGrid();
  buildSectorAdjacency();
}

export function scheduleIntroCameraDrop() {
  setTimeout(() => {
    player.z = player.floorHeight + EYE_HEIGHT;
  }, 600);
}

export function endLevelTransition(isInitialLoad) {
  if (!isInitialLoad) {
    hideLevelTransition();
  }
}
