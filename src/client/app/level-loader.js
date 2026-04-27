/**
 * Application-level level lifecycle orchestration.
 *
 * Keeps sequencing concerns out of shared map data and renderer scene build.
 */

import { clearSpatialGrid, buildSpatialGrid } from "../../engine/spatial-grid.js";
import { initDoors } from "../../engine/mechanics/doors.js";
import { initLifts } from "../../engine/mechanics/lifts.js";
import { initCrushers } from "../../engine/mechanics/crushers.js";
import { buildSectorAdjacency } from "../../engine/sound-propagation.js";
import { buildPortalGraph } from "../renderer/scene/portals.js";
import { resetPvs } from "../renderer/scene/pvs.js";
import { teardownScene, buildScene } from "../renderer/scene/scene.js";
import { beginLocalCameraDrop } from "../renderer/scene/camera.js";
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

export function endLevelTransition(isInitialLoad) {
  if (!isInitialLoad) {
    hideLevelTransition();
  }
}

/**
 * Kick off the intro camera "fall" for the local viewer only. Previously
 * the server parked the marine at `floorHeight + 80` so every client saw
 * the drop — per the session-scoped renderer decision, the drop is now a
 * purely local visual offset on `--view-z` that decays to zero over
 * ~1.2s. Other sessions watching the same actor see it at its natural
 * eye height from the first snapshot.
 */
export function scheduleIntroCameraDrop() {
  beginLocalCameraDrop(80, 1200);
}
