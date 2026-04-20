/**
 * Player damage and sector (environmental) damage.
 */

import { state, player } from '../state.js';
import { playSound } from '../../audio/audio.js';
import { getSectorHazardAt } from '../physics/queries.js';
import * as renderer from '../../renderer/index.js';
import { asDamageableActor, assertDamageableActor } from '../actors/adapter.js';
import { applyDamage } from '../combat/damage.js';
import { flushNow, markPlayerDirty } from '../services.js';
import {
    getSessionIdControlling,
    isHumanControlled,
    onPossessedDeath,
} from '../possession.js';

// ============================================================================
// Player Damage
// ============================================================================

/**
 * Based on: linuxdoom-1.10/p_inter.c:P_DamageMobj() lines 692-704
 * Accuracy: Exact — same integer division, same absorption ratios, same armor depletion logic.
 */
export function damagePlayer(damageAmount) {
    // A corpse can't be damaged again. Without this guard, AI ticks that
    // keep running after a multiplayer marine death (see
    // `updateAllEnemies`) would re-enter the death code path repeatedly,
    // re-broadcasting hurt sounds and re-firing `onPossessedDeath` on a
    // marine that's already been resolved.
    if (player.isDead || player.isAiDead) return;

    const playerIsControlled = isHumanControlled(player);
    const controllingSession = getSessionIdControlling(player);
    const targetActor = asDamageableActor(player);
    assertDamageableActor(targetActor, 'damagePlayer');
    const damageResult = applyDamage(targetActor, damageAmount, null, {
        skillLevel: state.skillLevel,
    });
    if (!damageResult.processed) return;
    markPlayerDirty();

    // First-person hurt feedback only for whoever controls the marine.
    // `isHumanControlled` is true if *any* session owns the body; without
    // scoping by session, every client would replay the same flash/sounds.
    if (playerIsControlled && controllingSession) {
        renderer.triggerViewerFlash('hurt', controllingSession);
        playSound('DSPLPAIN', controllingSession);
    } else if (playerIsControlled) {
        renderer.triggerFlash('hurt');
        playSound('DSPLPAIN');
    } else {
        playSound('DSPOPAIN');
    }

    if (damageResult.killed) {
        if (playerIsControlled) {
            player.isDead = true;
            player.deathTime = performance.now();
            if (controllingSession) {
                renderer.setViewerPlayerDead(true, controllingSession);
                playSound('DSPLDETH', controllingSession);
            } else {
                renderer.setPlayerDead(true);
                playSound('DSPLDETH');
            }
            markPlayerDirty();
            void flushNow();
        } else {
            // Player character died while AI-controlled — don't trigger the
            // normal game-over flow; instead mark the body as un-possessable
            // and let the possession auto-cycle decide what's next (which
            // may be a no-op if the user is already driving a monster).
            player.isAiDead = true;
            playSound('DSPLDETH');
            onPossessedDeath(player);
        }
    }
}

// ============================================================================
// Sector Damage
// ============================================================================

export function checkSectorDamage(deltaTime) {
    const { damage: sectorDamageAmount, specialType } = getSectorHazardAt(player.x, player.y);
    const radsuitBypassed = player.powerups.radsuit
        && (specialType === 4 || specialType === 16)
        && Math.random() < 5 / 256;
    if (sectorDamageAmount > 0 && (!player.powerups.radsuit || radsuitBypassed)) {
        player.sectorDamageTimer += deltaTime;
        if (player.sectorDamageTimer >= 32 / 35) {
            player.sectorDamageTimer -= 32 / 35;
            damagePlayer(sectorDamageAmount);
        }
    } else {
        player.sectorDamageTimer = 0;
    }
}
