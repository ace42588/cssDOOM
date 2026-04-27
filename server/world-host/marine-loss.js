/**
 * Zero-marine restart policy.
 */

import { getMarineActor } from '../../src/engine/state.js';

import {
    setPendingMarinePromotion,
    clearPendingMarinePromotion,
} from '../assignment.js';
import { getConnection } from '../connections.js';
import { resetCurrentMap } from '../world/maps.js';
import { findMarineControllerSessionId } from '../world/roles.js';

const MARINE_LOSS_RESTART_MS = 4000;

let marineLossSince = null;
let marineRestartInFlight = false;

export function checkMarineLossRestart(now) {
    if (marineRestartInFlight) return;
    const marine = getMarineActor();
    const alive = Boolean(marine) && marine.hp > 0 && marine.deathMode !== 'gameover';
    if (alive) {
        marineLossSince = null;
        return;
    }
    if (marineLossSince === null) {
        marineLossSince = now;
        return;
    }
    if (now - marineLossSince < MARINE_LOSS_RESTART_MS) return;

    capturePendingMarinePromotion(marine);

    marineRestartInFlight = true;
    marineLossSince = null;
    Promise.resolve()
        .then(() => resetCurrentMap())
        .catch((err) => {
            // eslint-disable-next-line no-console
            console.error('[server] marine-loss restart failed', err);
        })
        .finally(() => {
            marineRestartInFlight = false;
        });
}

function capturePendingMarinePromotion(marine) {
    clearPendingMarinePromotion();
    if (!marine) return;
    const killerSid = marine.lastDamagedBySessionId;
    if (typeof killerSid !== 'string' || !killerSid) return;
    if (killerSid === findMarineControllerSessionId()) return;
    if (!getConnection(killerSid)) return;
    setPendingMarinePromotion(killerSid);
}
