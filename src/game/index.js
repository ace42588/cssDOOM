/**
 * Game update — runs all game systems for a single frame.
 */

import { MAX_FRAME_DELTA_TIME } from './constants.js';
import { updateMovement } from './movement/player.js';
import { checkSectorDamage } from './player/damage.js';
import { checkPickups, updatePowerups } from './player/pickups.js';
import { updateAllEnemies } from './ai/controller.js';
import { updateProjectiles } from './ai/projectiles.js';
import { checkWalkOverTriggers } from './mechanics/lifts.js';
import { checkTeleporters } from './mechanics/teleporters.js';
import { updateCrushers } from './mechanics/crushers.js';
import { tickScimHeartbeat } from '../sgnl/client/scim.js';

let previousTimestamp = 0;

export function updateGame(timestamp) {
    const deltaTime = Math.min((timestamp - previousTimestamp) / 1000, MAX_FRAME_DELTA_TIME);
    previousTimestamp = timestamp;

    updateMovement(deltaTime, timestamp);
    checkSectorDamage(deltaTime);
    updateAllEnemies(deltaTime);
    updateProjectiles(deltaTime);
    checkWalkOverTriggers();
    checkTeleporters();
    updateCrushers(deltaTime);
    checkPickups();
    updatePowerups(deltaTime);
    tickScimHeartbeat(deltaTime);
}
