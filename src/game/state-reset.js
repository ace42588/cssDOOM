import { state } from './state.js';

export function resetLevelWorldState() {
    state.things.length = 0;
    while (state.actors.length > 1) state.actors.pop();
    state.projectiles.length = 0;
    state.nextProjectileId = 0;
    state.doorState.clear();
    state.liftState.clear();
    state.crusherState.clear();
}

