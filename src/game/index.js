/**
 * Authoritative game tick — runs all game systems for one fixed-step frame.
 * The server calls `updateGameMulti` each tick with per-session input snapshots.
 */

import { MAX_FRAME_DELTA_TIME } from './constants.js';
import { updateMovementFor } from './movement/system.js';
import { checkSectorDamage } from './combat/damage.js';
import { checkPickups, updatePowerups } from './actor/pickups.js';
import { updateAllEnemies } from './ai/controller.js';
import { updateProjectiles } from './ai/projectiles.js';
import { checkWalkOverTriggers } from './mechanics/lifts.js';
import { checkTeleporters } from './mechanics/teleporters.js';
import { updateCrushers } from './mechanics/crushers.js';
import { tickHeartbeat } from './services.js';
import { state } from './state.js';

/**
 * Server tick entry: once per step with `sessionId → inputSnapshot` for every
 * session that holds a controlled body. Each session's movement runs against
 * its own input; world-scoped systems (AI, projectiles, triggers, pickups) run once.
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

    // Pickups + powerup tick for every actor. `checkPickups` is itself
    // gated on `inventory.canCollectPickups === true`, so monsters and
    // decorations trivially no-op; today only the marine opts in, but
    // any future actor with the capability inherits the behaviour for
    // free without re-touching this call site.
    for (let i = 0, len = state.actors.length; i < len; i++) {
        const actor = state.actors[i];
        if (!actor) continue;
        checkPickups(actor);
        updatePowerups(actor, dt);
    }

    tickHeartbeat(dt);
}
