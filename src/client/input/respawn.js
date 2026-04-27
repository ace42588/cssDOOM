/**
 * "Press any key to restart" gating.
 *
 * A naive `hp <= 0 && performance.now() - deathTime > 4000` check is
 * wrong in an authoritative multi-session setup for two reasons:
 *
 *   1. Every connected client sees the state of every actor through
 *      snapshots, including bodies other sessions drive. Reloading on
 *      someone else's death would kick everybody out whenever any actor
 *      in the world fell.
 *   2. The server never fills `deathTime` into snapshots, so the
 *      browser-side timestamp would stay 0 and the >4s threshold would
 *      pass instantly.
 *
 * This module solves both: it watches the session's own controlled
 * actor, stamps a death time the first time it flips dead, and gates
 * the offer strictly on "my avatar is down". A monster-possession death
 * now also surfaces the reload affordance, which matches the session's
 * actual "I have no body" state.
 */

import { getPlayerActor } from '../../engine/possession.js';

const RESPAWN_OFFER_DELAY_MS = 4000;

let localDeathStamp = 0;
let wasDead = false;

function actorIsDead(actor) {
    if (!actor) return true;
    if (actor.deathMode === 'gameover') return true;
    return (actor.hp ?? 0) <= 0;
}

function refreshDeathStamp() {
    const dead = actorIsDead(getPlayerActor());
    if (dead && !wasDead) {
        localDeathStamp = performance.now();
    } else if (!dead && wasDead) {
        localDeathStamp = 0;
    }
    wasDead = dead;
}

/**
 * True if this session's controlled actor is down and enough time has
 * elapsed since death to show the "any key to restart" affordance.
 */
export function shouldOfferRespawnReload() {
    refreshDeathStamp();
    const actor = getPlayerActor();
    if (!actorIsDead(actor)) return false;
    if (!localDeathStamp) return false;
    return performance.now() - localDeathStamp > RESPAWN_OFFER_DELAY_MS;
}
