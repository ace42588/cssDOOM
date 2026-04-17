/**
 * Player damage and sector (environmental) damage.
 */

import { state, player } from '../state.js';
import { playSound } from '../../audio/audio.js';
import { getSectorHazardAt } from '../physics/queries.js';
import * as renderer from '../../renderer/index.js';
import { asDamageableActor, assertDamageableActor } from '../actors/adapter.js';
import { applyDamage } from '../combat/damage.js';
import { flushNow, markAllDirty, markPlayerDirty } from '../services.js';
import { isHumanControlled, onPossessedDeath } from '../possession.js';

// ============================================================================
// Player Damage
// ============================================================================

/**
 * Based on: linuxdoom-1.10/p_inter.c:P_DamageMobj() lines 692-704
 * Accuracy: Exact — same integer division, same absorption ratios, same armor depletion logic.
 */
export function damagePlayer(damageAmount) {
    const playerIsControlled = isHumanControlled(player);
    const targetActor = asDamageableActor(player);
    assertDamageableActor(targetActor, 'damagePlayer');
    const damageResult = applyDamage(targetActor, damageAmount, null, {
        skillLevel: state.skillLevel,
    });
    if (!damageResult.processed) return;
    markPlayerDirty();

    // Only flash the viewport / play the hurt grunt when the user is
    // actually the one being hit — otherwise we're just an AI enemy taking
    // damage off-camera.
    if (playerIsControlled) {
        renderer.triggerFlash('hurt');
        playSound('DSPLPAIN');
    } else {
        playSound('DSPOPAIN');
    }

    if (damageResult.killed) {
        if (playerIsControlled) {
            player.isDead = true;
            player.deathTime = performance.now();
            renderer.setPlayerDead(true);
            playSound('DSPLDETH');
            markAllDirty();
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
