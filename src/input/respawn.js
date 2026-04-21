/**
 * "Press any key to restart" gating.
 *
 * In single-player this used to be `deathMode === 'gameover' && performance.now() -
 * deathTime > 4000`. Multiplayer makes that wrong on two axes:
 *
 *   1. Every connected client sees the marine's `isDead` flag through
 *      snapshots, even sessions that are possessing a monster or just
 *      spectating. Reloading on someone else's marine death would kick
 *      everybody out the moment the marine fell.
 *   2. The server never fills `deathTime` into snapshots, so the
 *      browser-side timestamp would stay 0 and the >4s threshold would
 *      pass instantly.
 *
 * This module solves both: it watches the local copy of the marine death flag,
 * stamps a death time the first time it flips, and gates the offer on
 * whether the local session is the one driving the marine.
 */

import { getMarine } from '../game/state.js';
import { isControllingPlayer } from '../game/possession.js';

const RESPAWN_OFFER_DELAY_MS = 4000;

let localDeathStamp = 0;
let wasDead = false;

function refreshDeathStamp() {
    if (getMarine().deathMode === 'gameover' && !wasDead) {
        localDeathStamp = performance.now();
    } else if (getMarine().deathMode !== 'gameover' && wasDead) {
        localDeathStamp = 0;
    }
    wasDead = getMarine().deathMode === 'gameover';
}

/**
 * True if the marine is dead, this client is the one driving the marine,
 * and enough time has elapsed since death to show the "any key to restart"
 * affordance.
 */
export function shouldOfferRespawnReload() {
    refreshDeathStamp();
    if (getMarine().deathMode !== 'gameover') return false;
    if (!isControllingPlayer()) return false;
    if (!localDeathStamp) return false;
    return performance.now() - localDeathStamp > RESPAWN_OFFER_DELAY_MS;
}
