/**
 * Actor AI — state machine, movement orchestration, per-frame update loop.
 *
 * Every actor with a `brain` block is ticked through the same loop: enemies,
 * and the marine when no human drives it. Attack execution routes through
 * `performAttack()` in `../combat/weapons.js` regardless of whether the
 * attacker is a marine-shaped weapon loadout or a monster with an intrinsic
 * projectile / melee swing.
 */

import { LINE_OF_SIGHT_CHECK_INTERVAL } from "../constants.js";

import { state, getMarineActor, debug, MARINE_ACTOR_TYPE } from "../state.js";
import { getSectorAt, getFloorHeightAt } from "../physics/queries.js";
import * as renderer from "../ports/renderer.js";
import { hasLineOfSight } from "../physics/line-of-sight.js";
import { isSectorAlerted } from "../sound-propagation.js";
import { playSound } from "../ports/audio.js";
import { setEnemyState, respawnEnemy } from './state.js';
import { getThingIndex } from '../things/registry.js';
import { checkMissileRange } from '../combat/enemy.js';
import {
  performAttack,
  buildMonsterAttackDescriptor,
  buildMarineAttackDescriptor,
} from '../combat/weapons.js';
import { getHorizontalDistance } from "../geometry.js";
import { moveEnemyToward } from './chase.js';
import {
  distance2,
  resolveTargetActor,
} from '../actors/math.js';
import { isHumanControlled, ensurePlayerAi } from '../possession.js';

/** Throttle overlapping alert cries when many enemies wake at once. */
const ALERT_SOUND_MIN_INTERVAL_MS = 500;

let lastAlertSoundTime = 0;

const marine = () => getMarineActor();

/** True if `target` is the marine actor — used for AI target validation. */
function targetIsMarine(target) {
  return target != null && target === marine();
}

/**
 * Chase target position; invalidates dead infighting targets (→ marine, threshold 0).
 * Based on: linuxdoom-1.10/p_enemy.c:A_Chase() — target dead → P_LookForPlayers flow.
 *
 * Side effect: normalises `ai.target` to a concrete actor reference (or the
 * current marine) so downstream consumers (`tickAttacking` → `performAttack`
 * → projectile aim) never read a stale sentinel and divide by NaN.
 */
function resolveTarget(enemy, deltaTime) {
  const ai = enemy.ai;
  const m = marine();
  let targetActor = resolveTargetActor(enemy);

  if (targetActor && targetActor !== m) {
    if (targetActor.collected || targetActor.hp <= 0) {
      ai.threshold = 0;
      targetActor = m;
    }
  }

  ai.target = targetActor ?? null;

  if (ai.threshold > 0) {
    ai.threshold -= deltaTime;
  }

  return targetActor;
}

/** Updates thing DOM coords and sector reparent for lighting. */
function syncEnemyThingPosition(enemy) {
  const thingIndex = getThingIndex(enemy);
  renderer.updateThingPosition(thingIndex, {
    x: enemy.x,
    y: enemy.y,
    floorHeight: enemy.floorHeight,
  });
  const sector = getSectorAt(enemy.x, enemy.y);
  if (sector) {
    renderer.reparentThingToSector(thingIndex, sector.sectorIndex);
  }
}

/** A_Look: periodic wake from sight or alerted sector; MF_AMBUSH deaf rules. */
function tickIdle(
  enemy,
  deltaTime,
  currentTime,
  targetPos,
  distSqToTarget,
) {
  const ai = enemy.ai;
  ai.wakeCheckTimer += deltaTime;
  if (ai.wakeCheckTimer < LINE_OF_SIGHT_CHECK_INTERVAL) return;

  ai.wakeCheckTimer = 0;

  let shouldWake = false;
  if (
    distSqToTarget < ai.sightRange * ai.sightRange &&
    hasLineOfSight(enemy, targetPos)
  ) {
    shouldWake = true;
  } else {
    const sector = getSectorAt(enemy.x, enemy.y);
    if (sector && isSectorAlerted(sector.sectorIndex)) {
      if (!ai.ambush || hasLineOfSight(enemy, targetPos)) {
        shouldWake = true;
      }
    }
  }

  if (!shouldWake) return;

  setEnemyState(enemy, "chasing");
  ai.reactionTimer = ai.reactionTime;
  if (currentTime - lastAlertSoundTime > ALERT_SOUND_MIN_INTERVAL_MS) {
    lastAlertSoundTime = currentTime;
    if (ai.alertSound) playSound(ai.alertSound);
  }
}

/** A_Chase: move, reactiontime, then melee-before-missile attack decision. */
function tickChasing(
  enemy,
  deltaTime,
  currentTime,
  targetPos,
  distSqToTarget,
) {
  const ai = enemy.ai;

  if (moveEnemyToward(enemy, targetPos, deltaTime)) {
    syncEnemyThingPosition(enemy);
  }

  if (ai.reactionTimer > 0) {
    ai.reactionTimer -= deltaTime;
    return;
  }

  if (currentTime - ai.lastAttack > ai.cooldown * 1000) {
    if (debug.noEnemyAttack && targetIsMarine(ai.target)) return;

    if (ai.meleeRange && distSqToTarget < ai.meleeRange * ai.meleeRange) {
      ai.attackIsMelee = true;
      setEnemyState(enemy, "attacking");
      return;
    }

    if (!ai.melee && distSqToTarget < ai.attackRange * ai.attackRange) {
      ai.rangedLosTimer += deltaTime;
      if (ai.rangedLosTimer >= LINE_OF_SIGHT_CHECK_INTERVAL) {
        ai.rangedLosTimer = 0;
        if (
          hasLineOfSight(enemy, targetPos) &&
          checkMissileRange(enemy, getHorizontalDistance(enemy, targetPos))
        ) {
          ai.attackIsMelee = false;
          setEnemyState(enemy, "attacking");
        }
      }
    }
  }
}

/** Damage at attackDuration/2; return to chase when animation ends. */
function tickAttacking(enemy, targetPos, currentTime) {
  const ai = enemy.ai;

  if (!ai.damageDealt && ai.stateTime >= ai.attackDuration / 2) {
    ai.damageDealt = true;

    // Marine-shaped actors (and any future actor tagged with a
    // `WEAPONS`-backed loadout) fire through their equipped weapon;
    // everyone else uses their intrinsic monster stats. We key on the
    // actor type today rather than a capability flag because the marine
    // is the only weapon-holder — when that changes, swap this to a
    // capability read on `offense`.
    const usesWeaponLoadout = enemy.type === MARINE_ACTOR_TYPE;
    if (usesWeaponLoadout) {
      const descriptor = buildMarineAttackDescriptor(enemy, { aimTarget: ai.target });
      if (descriptor) performAttack(enemy, descriptor);
    } else if (ai.attackIsMelee) {
      // Melee requires line-of-sight at the swing moment — if the target has
      // moved behind cover during the attack windup, the claw whiffs.
      if (hasLineOfSight(enemy, targetPos)) {
        performAttack(enemy, buildMonsterAttackDescriptor(enemy, {
          attackIsMelee: true,
          aimTarget: ai.target,
        }));
      } else {
        // Still play the swing sound even on a whiff (matches DOOM feel).
        playSound(
          enemy.type === 3002 || enemy.type === 58 ? 'DSSGTATK' : 'DSCLAW',
        );
      }
    } else {
      performAttack(enemy, buildMonsterAttackDescriptor(enemy, {
        attackIsMelee: false,
        aimTarget: ai.target,
      }));
    }
  }

  if (ai.stateTime >= ai.attackDuration) {
    ai.lastAttack = currentTime;
    setEnemyState(enemy, "chasing");
  }
}

/** Pain stun then resume chase. */
function tickPain(enemy) {
  const ai = enemy.ai;
  if (ai.stateTime >= ai.painDuration) {
    setEnemyState(enemy, "chasing");
  }
}

/**
 * Pick the closest live, non-human-controlled enemy actor for an actor
 * whose AI auto-acquires targets (today: the unpiloted marine). Prefers
 * the current `ai.target` when still valid so chase behaviour is sticky.
 */
function pickClosestEnemyTarget(actor) {
  const aiTarget = actor.ai?.target;
  if (
    aiTarget &&
    typeof aiTarget === 'object' &&
    aiTarget !== actor &&
    !aiTarget.collected &&
    (aiTarget.hp ?? 0) > 0
  ) {
    return aiTarget;
  }

  let closestDistSq = Infinity;
  let closest = null;
  for (let i = 0; i < state.actors.length; i++) {
    const thing = state.actors[i];
    if (!thing || thing === actor || !thing.ai) continue;
    if (thing.type === MARINE_ACTOR_TYPE) continue;
    if (thing.collected) continue;
    if ((thing.hp ?? 0) <= 0) continue;
    if (isHumanControlled(thing)) continue;
    const dx = thing.x - actor.x;
    const dy = thing.y - actor.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < closestDistSq) {
      closestDistSq = d2;
      closest = thing;
    }
  }
  return closest;
}

/** Point `actor.viewAngle` / `facing` at `target`. */
function faceTarget(actor, target) {
  const dx = target.x - actor.x;
  const dy = target.y - actor.y;
  if (dx === 0 && dy === 0) return;
  actor.viewAngle = Math.atan2(-dx, dy);
  actor.facing = actor.viewAngle + Math.PI / 2;
}

/**
 * @param {object} enemy
 * @param {number} deltaTime - Seconds
 * @param {number} currentTime - performance.now()
 */
function updateSingleEnemy(enemy, deltaTime, currentTime) {
  const ai = enemy.ai;
  ai.stateTime += deltaTime;

  let targetPos;
  if (ai.autoAcquireTarget) {
    // Target-picking specialisation for the unpiloted marine: scan every
    // tick for the nearest live enemy instead of chasing `ai.target` and
    // falling back to the marine. Also keep the marine's footing + facing
    // in sync since it isn't being driven through `updateMovementFor`.
    enemy.floorHeight = getFloorHeightAt(enemy.x, enemy.y);
    const target = pickClosestEnemyTarget(enemy);
    if (!target) {
      ai.target = null;
      ai.state = 'idle';
      ai.stateTime = 0;
      return;
    }
    ai.target = target;
    faceTarget(enemy, target);
    targetPos = target;
  } else {
    targetPos = resolveTarget(enemy, deltaTime);
    if (!targetPos) return;
  }

  const distSqToTarget = distance2(enemy, targetPos);

  switch (ai.state) {
    case "idle":
      tickIdle(enemy, deltaTime, currentTime, targetPos, distSqToTarget);
      break;
    case "chasing":
      tickChasing(enemy, deltaTime, currentTime, targetPos, distSqToTarget);
      break;
    case "attacking":
      tickAttacking(enemy, targetPos, currentTime);
      break;
    case "pain":
      tickPain(enemy);
      break;
  }
}

// ============================================================================
// Per-frame loop
// ============================================================================

/**
 * All AI actors: nightmare respawn, distance cull, AI tick, sprite rotation.
 * Based on: linuxdoom-1.10/p_mobj.c:P_NightmareRespawn()
 *
 * NOTE: in single-player DOOM the world stops thinking once the marine
 * dies. Multiplayer can't do that — there may be other sessions
 * possessing monsters who still want a live simulation. AI keeps running
 * regardless of any single body's `deathMode`; downstream damage helpers
 * (`applyDamage`) already guard against attacking a corpse, and
 * infighting / wandering remain valid for everybody else.
 *
 * Marine and monsters share a single linear pass: skip-if-dead, skip-if-
 * possessed (with billboard rotation update for non-marines), respawn-if-
 * collected, otherwise tick AI. The unpiloted marine reaches
 * `updateSingleEnemy` via its `autoAcquireTarget` brain block, which
 * picks the nearest live monster as its target instead of relying on the
 * former `tickMarineAi` special case.
 */
export function updateAllEnemies(deltaTime) {
  const currentTime = performance.now();
  for (let i = 0, length = state.actors.length; i < length; i++) {
    const thing = state.actors[i];
    if (!thing) continue;

    // Lazy-install AI on any unpiloted marine missing a brain block
    // (e.g. an older save). Monsters always spawn with `ai` populated.
    if (!thing.ai && thing.type === MARINE_ACTOR_TYPE) ensurePlayerAi();
    if (!thing.ai) continue;

    // Dead body. Marine flags death via `deathMode === 'gameover'`;
    // monster `routeDeath` flags it via `collected = true` (set
    // synchronously when hp reaches 0). Both gate the AI tick.
    if (thing.deathMode || (thing.hp ?? 0) <= 0) continue;
    if (thing.collected) {
      if (thing.respawnTimer !== undefined) {
        thing.respawnTimer -= deltaTime;
        if (thing.respawnTimer <= 0) respawnEnemy(thing);
      }
      continue;
    }

    if (isHumanControlled(thing)) {
      // Marine third-person pose is driven by `#avatar` + camera vars,
      // not the per-thing rotation pool, so skip the renderer update for
      // marines and let the avatar pipeline keep ownership.
      if (thing.type !== MARINE_ACTOR_TYPE) {
        renderer.updateEnemyRotation(thing.thingIndex, thing);
      }
      continue;
    }

    updateSingleEnemy(thing, deltaTime, currentTime);

    if (thing.type !== MARINE_ACTOR_TYPE) {
      renderer.updateEnemyRotation(thing.thingIndex, thing);
    }
  }
}
