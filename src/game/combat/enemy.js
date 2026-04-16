/**
 * Enemy combat — hitscan attacks, damage handling, and barrel explosions.
 */

import {
  ENEMY_RADIUS,
  PLAYER_RADIUS,
  BARREL_EXPLOSION_DAMAGE,
  BARREL_EXPLOSION_RADIUS,
  INFIGHTING_THRESHOLD,
} from "../constants.js";

import { state, player } from "../state.js";
import { currentMap } from "../../data/maps.js";
import { hasLineOfSight } from "../physics/line-of-sight.js";
import { damagePlayer } from "../player/damage.js";
import { hasPowerup } from "../player/pickups.js";
import { playSound } from "../../audio/audio.js";
import { setEnemyState } from '../ai/state.js';
import { getThingIndex } from '../things/registry.js';
import { forEachRadiusDamageTarget } from './radius.js';
import {
  asDamageableActor,
  assertDamageableActor,
} from '../actors/adapter.js';
import {
  applyDamage,
  normalizeDamageSource,
  resolveDamageTarget,
} from './damage.js';
import * as renderer from "../../renderer/index.js";
import {
  getHorizontalDistance,
  randomDoomSpreadAngleRadians,
} from "../geometry.js";
import { resolveTargetActor } from '../actors/math.js';

// ============================================================================
// Enemy Hitscan Attack
// ============================================================================

/**
 * Shared hitscan resolution for enemy pellet weapons (Zombieman, Shotgun Guy).
 *
 * Based on: linuxdoom-1.10/p_enemy.c:A_PosAttack() and A_SPosAttack()
 * Accuracy: Approximation — uses the same angular spread formula and damage
 * rolls, but since we don't trace individual rays through the 2D map, we
 * approximate hit/miss by checking if the spread angle is within the angular
 * size of the victim at the given distance.
 *
 * Angular spread: (P_Random()-P_Random()) gives range [-255, +255]. In DOOM this
 * is shifted left 20 bits in a 32-bit angle space (2^32 = 360°), giving roughly
 * ±22.4° max spread. We convert directly to radians
 * (p_enemy.c:A_PosAttack() / p_map.c:P_AimLineAttack()).
 *
 * When shooting the player who has Partial Invisibility (MF_SHADOW), max spread
 * is doubled (45° vs 22.5°). Infighting shots at another enemy use 22.5° only.
 *
 * Each pellet gets an independent spread and damage roll ((random 0-4) + 1) * 3.
 * Zombieman: 1 pellet (3–15), Shotgun Guy: 3 pellets (9–45).
 *
 */

/**
 * Performs an enemy hitscan attack against the current chase target (player or
 * infighting enemy).
 */
export function enemyHitscanAttack(attacker) {
  const attackerAI = attacker.ai;
  const target = resolveTargetActor(attacker, player);
  const targetIsPlayer = target === player;
  if (!targetIsPlayer && (!target || target.collected)) return;

  if (!hasLineOfSight(attacker, target)) {
    playSound(attackerAI.hitscanSound);
    return;
  }

  const distance = getHorizontalDistance(attacker, target);
  const radius =
    target === player
      ? (player.radius ?? PLAYER_RADIUS)
      : target.ai
        ? target.ai.radius
        : ENEMY_RADIUS;
  const angularSize = Math.atan2(radius, distance);

  const maxSpreadDeg = targetIsPlayer
    ? hasPowerup("invisibility")
      ? 45
      : 22.5
    : 22.5;

  let totalDamage = 0;
  for (let pellet = 0; pellet < attackerAI.pellets; pellet++) {
    const spreadAngle = randomDoomSpreadAngleRadians(maxSpreadDeg);
    if (Math.abs(spreadAngle) < angularSize) {
      totalDamage += (Math.floor(Math.random() * 5) + 1) * 3;
    }
  }

  playSound(attackerAI.hitscanSound);
  if (totalDamage > 0) {
    damageEnemy(target, totalDamage, attacker);
  }
}

/**
 * Distance-based attack probability check for ranged enemies.
 *
 * Based on: linuxdoom-1.10/p_enemy.c:P_CheckMissileRange()
 * Accuracy: Approximation — uses the same distance-to-probability curve but
 * without DOOM's fixed-point arithmetic or monster-specific overrides (Vile,
 * Revenant, Cyberdemon, Spider Mastermind).
 *
 * At point-blank range the enemy almost always attacks. At long range (200+
 * map units after subtracting the 64-unit close range buffer), there is a
 * ~78% chance (200/256) the enemy decides NOT to attack this frame.
 * Melee-only enemies skip this check entirely (they always attack in range).
 */
export function checkMissileRange(enemy, distanceToPlayer) {
  // Subtract a close-range buffer so enemies are very aggressive up close
  let adjustedDistance = distanceToPlayer - 64;

  // If the enemy has no melee attack, subtract an additional buffer
  // (they are more eager to fire since they have no fallback)
  if (!enemy.ai.melee) {
    adjustedDistance -= 128;
  }

  // Clamp to [0, 200] — beyond 200, probability of NOT attacking plateaus
  adjustedDistance = Math.max(0, Math.min(200, adjustedDistance));

  // Random 0-255; if random < distance, enemy does NOT attack this tick.
  // Close range: adjustedDistance ≈ 0, so almost always attacks.
  // Far range: adjustedDistance ≈ 200, so ~78% chance of skipping.
  return Math.floor(Math.random() * 256) >= adjustedDistance;
}

// ============================================================================
// Barrel Explosion
// ============================================================================

/**
 * Handles the explosive barrel (thing type 2035) chain-reaction explosion.
 * Deals area-of-effect damage that falls off linearly with distance from the
 * barrel center. Affects both the player and nearby shootable things (enemies
 * and other barrels), enabling chain explosions when barrels are clustered.
 */
function barrelExplosion(barrel) {
  forEachRadiusDamageTarget(barrel, BARREL_EXPLOSION_RADIUS, (target, damage) => {
    if (target === player) {
      damagePlayer(damage);
      return;
    }
    if (target === barrel) return;
    // Barrel explosions are sourced from the player since only player actions
    // can currently trigger them (shooting a barrel). This means barrel splash
    // damage won't trigger infighting — matching original DOOM where barrels
    // have no "source" monster and don't cause retargeting.
    damageEnemy(target, damage, player);
  });
}

// ============================================================================
// Enemy Damage (central damage handler)
// ============================================================================

/**
 * Applies damage to an enemy or barrel, handling death, pain, sound effects,
 * and infighting retarget logic.
 *
 * The `source` parameter identifies who dealt the damage:
 * - player object — the player fired a weapon or caused a barrel explosion
 * - an enemy entry object — another enemy's projectile or hitscan hit this target
 * - null — environmental damage (no retarget)
 *
 * Infighting retarget logic:
 * Based on: linuxdoom-1.10/p_inter.c:P_DamageMobj() lines ~730-745
 * Accuracy: Exact — same threshold check, same retarget behavior.
 * No same-species check: any enemy type can fight any other (matching original DOOM).
 *
 * When a monster damages another monster, the target retargets to the attacker
 * if its threshold is 0 (not locked onto a current chase target). The threshold
 * is then set to BASETHRESHOLD (~2.86s) to prevent rapid target-switching.
 */
export function damageEnemy(target, damage, source) {
  const normalizedTarget = resolveDamageTarget(target);
  if (normalizedTarget === player) return damagePlayer(damage);
  const targetActor = asDamageableActor(normalizedTarget);
  const sourceActor = normalizeDamageSource(source);
  assertDamageableActor(targetActor, "damageEnemy");
  const damageResult = applyDamage(targetActor, damage, sourceActor, {
    infightingThreshold: INFIGHTING_THRESHOLD,
    random: Math.random,
  });

  const thingIndex = getThingIndex(normalizedTarget);

  if (damageResult.killed) {
    // Target killed
    normalizedTarget.collected = true;
    renderer.killEnemy(thingIndex, normalizedTarget.type);

    if (normalizedTarget.type === 2035) {
      playSound("DSBAREXP");
      barrelExplosion(normalizedTarget);
    } else {
      playSound("DSPODTH1");
      // Based on: linuxdoom-1.10/p_mobj.c:P_NightmareRespawn()
      // Nightmare: enemies respawn 12 seconds after death
      if (state.skillLevel === 5 && normalizedTarget.ai) {
        normalizedTarget.respawnTimer = 12;
      }
      // Based on: linuxdoom-1.10/p_enemy.c:A_BossDeath()
      // E1M8: when all Barons (type 3003) are dead, lower tag 666 sector floor
      if (normalizedTarget.type === 3003 && currentMap === "E1M8") {
        checkBossDeath();
      }
    }
  } else {
    // Target survived — play pain sound (barrels have no pain sound)
    if (normalizedTarget.type !== 2035) {
      playSound("DSPOPAIN");
    }

    if (normalizedTarget.ai && damageResult.painTriggered) {
      setEnemyState(normalizedTarget, "pain");
    }
  }
}

// ============================================================================
// E1M8 Boss Death Trigger
// ============================================================================

/**
 * Checks if all Barons of Hell are dead. If so, lowers the tag 666 sector
 * floor to open the exit on E1M8.
 */
function checkBossDeath() {
  const allThings = state.things;
  for (let i = 0, len = allThings.length; i < len; i++) {
    if (allThings[i].type === 3003 && !allThings[i].collected) return;
  }
  renderer.lowerTaggedFloor(666);
}
