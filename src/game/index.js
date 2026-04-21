/**
 * Game update — runs all game systems for a single frame.
 */

import { MAX_FRAME_DELTA_TIME } from './constants.js';
import { updateMovement, updateMovementFor } from './movement/system.js';
import { checkSectorDamage } from './combat/damage.js';
import { checkPickups, updatePowerups } from './actor/pickups.js';
import { updateAllEnemies } from './ai/controller.js';
import { updateProjectiles } from './ai/projectiles.js';
import { checkWalkOverTriggers } from './mechanics/lifts.js';
import { checkTeleporters } from './mechanics/teleporters.js';
import { updateCrushers } from './mechanics/crushers.js';
import { tickHeartbeat } from './services.js';

let previousTimestamp = 0;

/** Browser single-player entry — reads the global input object. */
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
    tickHeartbeat(deltaTime);
}

/**
 * Multi-session entry — the server calls this once per fixed-step tick with
 * a map of `sessionId → inputSnapshot` for every session that currently
 * holds a controlled body. Each session's movement runs against its own
 * input; world-scoped systems (AI, projectiles, triggers, pickups) run once.
 *
 * @param {number} deltaTime Seconds.
 * @param {number} timestamp Milliseconds (server tick timestamp).
 * @param {Map<string, object>} sessionInputs
 */
export function updateGameMulti(deltaTime, timestamp, sessionInputs) {
    const dt = Math.min(deltaTime, MAX_FRAME_DELTA_TIME);
    if (sessionInputs) {
        for (const [sessionId, inputSnapshot] of sessionInputs) {
            updateMovementFor(sessionId, inputSnapshot, dt, timestamp);
        }
    }
    checkSectorDamage(dt);
    updateAllEnemies(dt);
    updateProjectiles(dt);
    checkWalkOverTriggers();
    checkTeleporters();
    updateCrushers(dt);
    checkPickups();
    updatePowerups(dt);
    tickHeartbeat(dt);
}
