/**
 * Shared damage application pipeline for player/enemy/barrel actors.
 * Marine-facing damage (`damageActor` / `damagePlayer`) and sector hazards
 * live here with `applyDamage` math.
 */

import { asSourceActor, resolveTargetEntity, asDamageableActor, assertDamageableActor } from '../entity/interop.js';
import { state, getMarine } from '../state.js';
import { playSound } from '../../audio/audio.js';
import { getSectorHazardAt } from '../physics/queries.js';
import * as renderer from '../../renderer/index.js';
import { flushNow, markPlayerDirty } from '../services.js';
import {
    getSessionIdControlling,
    isHumanControlled,
    onPossessedDeath,
} from '../possession.js';

export function normalizeDamageSource(source) {
  return asSourceActor(source);
}

export function resolveDamageTarget(target) {
  return resolveTargetEntity(target, getMarine());
}

export function applyDamage(targetActor, amount, sourceActor, context = {}) {
  const result = {
    processed: true,
    applied: 0,
    killed: false,
    painTriggered: false,
    retargeted: false,
    ignored: false,
  };

  if (targetActor.kind === "player") {
    const playerEntity = targetActor.entity;
    if (playerEntity.hp <= 0 || playerEntity.deathMode || targetActor.invulnerable) {
      result.processed = false;
      result.ignored = true;
      return result;
    }

    let damage = amount;
    if (context.skillLevel === 1) damage >>= 1;

    if (playerEntity.armorType) {
      let saved =
        playerEntity.armorType === 1
          ? Math.floor(damage / 3)
          : Math.floor(damage / 2);
      if (playerEntity.armor <= saved) {
        saved = playerEntity.armor;
        playerEntity.armorType = 0;
      }
      playerEntity.armor -= saved;
      damage -= saved;
    }

    playerEntity.hp -= damage;
    result.applied = damage;
    if (playerEntity.hp <= 0) {
      playerEntity.hp = 0;
      result.killed = true;
    }
    return result;
  }

  const target = targetActor.entity;
  target.hp -= amount;
  result.applied = amount;
  if (target.hp <= 0) {
    result.killed = true;
    return result;
  }

  if (target.ai) {
    const rng = context.random ?? Math.random;
    if (rng() * 256 < target.ai.painChance) {
      result.painTriggered = true;
    }

    if (
      sourceActor &&
      sourceActor.kind === "enemy" &&
      sourceActor.entity !== target &&
      target.ai.threshold <= 0
    ) {
      target.ai.target = sourceActor.entity;
      target.ai.threshold = context.infightingThreshold ?? target.ai.threshold;
      result.retargeted = true;
    }
  }

  return result;
}

// ============================================================================
// Marine / marine-shaped actor damage (side effects)
// ============================================================================

/**
 * Based on: linuxdoom-1.10/p_inter.c:P_DamageMobj() lines 692-704
 * Accuracy: Exact — same integer division, same absorption ratios, same armor depletion logic.
 *
 * @param {object} actor Marine entity (`state.actors[0]` / `getMarine()`).
 * @param {number} damageAmount
 * @param {object|null} _source Reserved for future attribution (infighting etc.).
 */
export function damageActor(actor, damageAmount, _source = null) {
    // A corpse can't be damaged again. Without this guard, AI ticks that
    // keep running after a multiplayer marine death (see
    // `updateAllEnemies`) would re-enter the death code path repeatedly,
    // re-broadcasting hurt sounds and re-firing `onPossessedDeath` on a
    // marine that's already been resolved.
    if (actor.hp <= 0 || actor.deathMode) return;

    const playerIsControlled = isHumanControlled(actor);
    const controllingSession = getSessionIdControlling(actor);
    const targetActor = asDamageableActor(actor);
    assertDamageableActor(targetActor, 'damageActor');
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
            actor.deathMode = 'gameover';
            actor.deathTime = performance.now();
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
            actor.deathMode = 'ai';
            playSound('DSPLDETH');
            onPossessedDeath(actor);
        }
    }
}

export function damagePlayer(damageAmount) {
    damageActor(getMarine(), damageAmount, null);
}

// ============================================================================
// Sector damage (marine position)
// ============================================================================

export function checkSectorDamage(deltaTime) {
    const m = getMarine();
    const { damage: sectorDamageAmount, specialType } = getSectorHazardAt(m.x, m.y);
    const radsuitBypassed = m.powerups.radsuit
        && (specialType === 4 || specialType === 16)
        && Math.random() < 5 / 256;
    if (sectorDamageAmount > 0 && (!m.powerups.radsuit || radsuitBypassed)) {
        m.sectorDamageTimer += deltaTime;
        if (m.sectorDamageTimer >= 32 / 35) {
            m.sectorDamageTimer -= 32 / 35;
            damageActor(m, sectorDamageAmount, null);
        }
    } else {
        m.sectorDamageTimer = 0;
    }
}
