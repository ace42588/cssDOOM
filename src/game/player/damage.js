/**
 * Player damage and sector (environmental) damage.
 */

import { state, player } from '../state.js';
import { playSound } from '../../audio/audio.js';
import { getSectorHazardAt } from '../physics/queries.js';
import * as renderer from '../../renderer/index.js';
import { asDamageableActor, assertDamageableActor } from '../actors/adapter.js';
import { applyDamage } from '../combat/damage.js';
import { flushScimNow, markAllScimDirty, markPlayerDirty } from '../../sgnl/client/scim.js';

// ============================================================================
// Player Damage
// ============================================================================

/**
 * Based on: linuxdoom-1.10/p_inter.c:P_DamageMobj() lines 692-704
 * Accuracy: Exact — same integer division, same absorption ratios, same armor depletion logic.
 */
export function damagePlayer(damageAmount) {
    const targetActor = asDamageableActor(player);
    assertDamageableActor(targetActor, 'damagePlayer');
    const damageResult = applyDamage(targetActor, damageAmount, null, {
        skillLevel: state.skillLevel,
    });
    if (!damageResult.processed) return;
    markPlayerDirty();

    renderer.triggerFlash('hurt');
    playSound('DSPLPAIN');

    if (damageResult.killed) {
        player.isDead = true;
        player.deathTime = performance.now();
        renderer.setPlayerDead(true);
        playSound('DSPLDETH');
        markAllScimDirty();
        void flushScimNow();
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
