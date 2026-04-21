/**
 * Application-level level lifecycle orchestration.
 *
 * Keeps sequencing concerns out of shared map data and renderer scene build.
 */

import { EYE_HEIGHT } from "../game/constants.js";
import { getMarine } from "../game/state.js";
import { clearSpatialGrid, buildSpatialGrid } from "../game/spatial-grid.js";
import { initDoors } from "../game/mechanics/doors.js";
import { initLifts } from "../game/mechanics/lifts.js";
import { initCrushers } from "../game/mechanics/crushers.js";
import { buildSectorAdjacency } from "../game/sound-propagation.js";
import { buildPortalGraph } from "../renderer/scene/portals.js";
import { resetPvs } from "../renderer/scene/pvs.js";
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
    resetPvs();
    // Let mobile browsers release GPU memory before rebuilding.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // Sector adjacency and portal graph are built before buildScene so the
  // renderer's first cull pass (triggered inside buildScene) already has
  // the portal graph and door-data map ready. Door/lift state isn't
  // populated yet — getSectorOpening falls back to raw sector heights in
  // that window, and the next cull tick (after initDoors/initLifts) picks
  // up the real openings.
  buildSectorAdjacency();
  buildPortalGraph();

  await buildScene();
  initDoors();
  initLifts();
  initCrushers();
  buildSpatialGrid();
}

export function scheduleIntroCameraDrop() {
  setTimeout(() => {
    const m = getMarine();
    m.z = m.floorHeight + EYE_HEIGHT;
  }, 600);
}

export function endLevelTransition(isInitialLoad) {
  if (!isInitialLoad) {
    hideLevelTransition();
  }
}
