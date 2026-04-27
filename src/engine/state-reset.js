import { state } from './state.js';

/**
 * Wipes all per-level world state so a fresh map load (or client resync)
 * starts from a blank slate. The marine is respawned by `spawnThings()` from
 * the synthesized `type: MARINE_ACTOR_TYPE` entry at the front of
 * `mapData.things`, so no actors survive this reset.
 */
export function resetLevelWorldState() {
    state.things.length = 0;
    state.actors.length = 0;
    state.projectiles.length = 0;
    state.nextProjectileId = 0;
    state.doorState.clear();
    state.liftState.clear();
    state.crusherState.clear();
}
