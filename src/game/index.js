/**
 * Game update — runs all game systems for a single frame.
 */

import { MAX_FRAME_DELTA_TIME } from './constants.js';
import { updateMovement } from './movement.js';
import { checkSectorDamage } from './player/damage.js';
import { checkPickups, updatePowerups } from './player/pickups.js';
import { updateAllEnemies } from './entities/ai.js';
import { updateProjectiles } from './entities/projectiles.js';
import { checkWalkOverTriggers } from './mechanics/lifts.js';
import { checkTeleporters } from './mechanics/teleporters.js';
import { updateCrushers } from './mechanics/crushers.js';

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
}
