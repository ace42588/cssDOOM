/**
 * Enemy AI — state machine, movement orchestration, per-frame update loop,
 * and marine-as-AI when no human drives the player character.
 */

import {
  ENEMIES,
  ENEMY_PROJECTILES,
  ENEMY_RADIUS,
  LINE_OF_SIGHT_CHECK_INTERVAL,
  WEAPONS,
} from "../constants.js";

import { state, getMarine, debug } from "../state.js";
import { getSectorAt, getFloorHeightAt } from "../physics/queries.js";
import * as renderer from "../../renderer/index.js";
import { hasLineOfSight } from "../physics/line-of-sight.js";
import { isSectorAlerted } from "../sound-propagation.js";
import { damageActor } from '../combat/damage.js';
import { playSound } from "../../audio/audio.js";
import { setEnemyState, respawnEnemy } from './state.js';
import { getThingIndex } from '../things/registry.js';
import {
  enemyHitscanAttack,
  checkMissileRange,
  damageEnemy,
} from '../combat/enemy.js';
import { spawnProjectile } from './projectiles.js';
import {
  getHorizontalDistance,
  randomDoomSpreadAngleRadians,
} from "../geometry.js";
import { moveEnemyToward } from './chase.js';
import {
  distance2,
  resolveTargetActor,
} from '../actors/math.js';
import { isPlayerActorLike } from '../entity/interop.js';
import { isHumanControlled, ensurePlayerAi } from '../possession.js';

/** Throttle overlapping alert cries when many enemies wake at once. */
const ALERT_SOUND_MIN_INTERVAL_MS = 500;

let lastAlertSoundTime = 0;

/** A_TroopAttack / A_SargAttack / A_BruisAttack damage rolls by thing type. */
const MELEE_DAMAGE_ROLL = {
  3001: () => (Math.floor(Math.random() * 8) + 1) * 3,
  3002: () => (Math.floor(Math.random() * 10) + 1) * 4,
  58: () => (Math.floor(Math.random() * 10) + 1) * 4,
  3003: () => (Math.floor(Math.random() * 8) + 1) * 10,
};

function rollMeleeDamage(enemyType) {
  const roll = MELEE_DAMAGE_ROLL[enemyType];
  return roll ? roll() : 0;
}

const marine = () => getMarine();

/**
 * Chase target position; invalidates dead infighting targets (→ marine, threshold 0).
 * Based on: linuxdoom-1.10/p_enemy.c:A_Chase() — target dead → P_LookForPlayers flow.
 */
function resolveTarget(enemy, deltaTime) {
  const ai = enemy.ai;
  const m = marine();
  let targetActor = resolveTargetActor(enemy, m);

  if (targetActor !== m) {
    if (targetActor.collected || targetActor.hp <= 0) {
      ai.target = "player";
      ai.threshold = 0;
      targetActor = m;
    }
  }

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
    playSound(ai.alertSound);
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
    if (debug.noEnemyAttack && isPlayerActorLike(ai.target)) return;

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
    const targetIsPlayer = isPlayerActorLike(ai.target);

    if (ai.attackIsMelee) {
      const meleeDmg = rollMeleeDamage(enemy.type);
      if (hasLineOfSight(enemy, targetPos)) {
        if (targetIsPlayer) {
          damageActor(marine(), meleeDmg, null);
        } else {
          damageEnemy(ai.target, meleeDmg, enemy);
        }
      }
      playSound(
        enemy.type === 3002 || enemy.type === 58 ? "DSSGTATK" : "DSCLAW",
      );
    } else {
      const projectileDefinition = ENEMY_PROJECTILES[enemy.type];
      if (projectileDefinition) {
        spawnProjectile(enemy, projectileDefinition);
      } else if (ai.pellets) {
        enemyHitscanAttack(enemy);
      }
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
 * @param {object} enemy
 * @param {number} deltaTime - Seconds
 * @param {number} currentTime - performance.now()
 */
function updateSingleEnemy(enemy, deltaTime, currentTime) {
  const ai = enemy.ai;
  ai.stateTime += deltaTime;

  const targetPos = resolveTarget(enemy, deltaTime);
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
// Player-as-AI (marine body while user possesses a monster)
// ============================================================================

function pickPlayerAiTarget() {
  const m = marine();
  const aiTarget = m.ai?.target;
  if (
    aiTarget &&
    typeof aiTarget === 'object' &&
    aiTarget !== m &&
    !aiTarget.collected &&
    (aiTarget.hp ?? 0) > 0
  ) {
    return aiTarget;
  }

  let closestDistSq = Infinity;
  let closest = null;
  for (let i = 1; i < state.actors.length; i++) {
    const thing = state.actors[i];
    if (!thing || !thing.ai) continue;
    if (!ENEMIES.has(thing.type)) continue;
    if (thing.collected) continue;
    if ((thing.hp ?? 0) <= 0) continue;
    if (isHumanControlled(thing)) continue;
    const dx = thing.x - m.x;
    const dy = thing.y - m.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < closestDistSq) {
      closestDistSq = d2;
      closest = thing;
    }
  }
  return closest;
}

function rollHitscanDamage() {
  return 5 * (Math.floor(Math.random() * 3) + 1);
}

function fireAiWeapon(target) {
  const m = marine();
  const weapon = WEAPONS[m.currentWeapon];
  if (!weapon) return;

  if (!hasLineOfSight(m, target)) {
    if (weapon.sound) playSound(weapon.sound);
    return;
  }

  if (weapon.ammoType) {
    if (m.ammo[weapon.ammoType] < weapon.ammoPerShot) return;
    m.ammo[weapon.ammoType] -= weapon.ammoPerShot;
  }

  const distance = Math.max(1, getHorizontalDistance(m, target));
  const radius = target.ai?.radius ?? ENEMY_RADIUS;
  const angularSize = Math.atan2(radius, distance);

  if (weapon.sound) playSound(weapon.sound);

  const pellets = weapon.pellets || 1;
  let totalDamage = 0;
  for (let i = 0; i < pellets; i++) {
    const spread = randomDoomSpreadAngleRadians(22.5);
    if (Math.abs(spread) < angularSize) {
      totalDamage += rollHitscanDamage();
    }
  }

  if (totalDamage > 0) {
    damageEnemy(target, totalDamage, m);
  }
}

function updatePlayerFacingForAi(target) {
  const m = marine();
  const dx = target.x - m.x;
  const dy = target.y - m.y;
  if (dx === 0 && dy === 0) return;
  m.viewAngle = Math.atan2(-dx, dy);
  m.facing = m.viewAngle + Math.PI / 2;
}

function updatePlayerAi(deltaTime) {
  const m = marine();
  if (!m.ai) ensurePlayerAi();
  if (m.hp <= 0 || m.deathMode) return;

  m.floorHeight = getFloorHeightAt(m.x, m.y);

  const ai = m.ai;
  ai.stateTime += deltaTime;
  if (ai.threshold > 0) ai.threshold -= deltaTime;

  const target = pickPlayerAiTarget();
  if (!target) {
    ai.state = 'idle';
    return;
  }
  ai.target = target;

  const distSq = distance2(m, target);

  switch (ai.state) {
    case 'idle':
      ai.wakeCheckTimer += deltaTime;
      if (ai.wakeCheckTimer >= LINE_OF_SIGHT_CHECK_INTERVAL) {
        ai.wakeCheckTimer = 0;
        if (
          distSq < ai.sightRange * ai.sightRange &&
          hasLineOfSight(m, target)
        ) {
          ai.state = 'chasing';
          ai.stateTime = 0;
          ai.reactionTimer = ai.reactionTime;
        }
      }
      break;

    case 'chasing': {
      updatePlayerFacingForAi(target);
      if (moveEnemyToward(m, target, deltaTime)) {
        // Movement updates handled by chase helper.
      }

      if (ai.reactionTimer > 0) {
        ai.reactionTimer -= deltaTime;
        break;
      }

      const now = performance.now();
      if (now - ai.lastAttack > ai.cooldown * 1000) {
        ai.rangedLosTimer += deltaTime;
        if (
          ai.rangedLosTimer >= LINE_OF_SIGHT_CHECK_INTERVAL &&
          distSq < ai.attackRange * ai.attackRange
        ) {
          ai.rangedLosTimer = 0;
          if (hasLineOfSight(m, target)) {
            ai.state = 'attacking';
            ai.stateTime = 0;
            ai.damageDealt = false;
          }
        }
      }
      break;
    }

    case 'attacking': {
      updatePlayerFacingForAi(target);
      if (!ai.damageDealt && ai.stateTime >= ai.attackDuration / 2) {
        ai.damageDealt = true;
        if (!debug.noEnemyAttack) {
          fireAiWeapon(target);
        }
      }
      if (ai.stateTime >= ai.attackDuration) {
        ai.lastAttack = performance.now();
        ai.state = 'chasing';
        ai.stateTime = 0;
      }
      break;
    }

    case 'pain':
      if (ai.stateTime >= ai.painDuration) {
        ai.state = 'chasing';
        ai.stateTime = 0;
      }
      break;
  }
}

/**
 * All enemies: nightmare respawn, distance cull, AI tick, sprite rotation.
 * Based on: linuxdoom-1.10/p_mobj.c:P_NightmareRespawn()
 *
 * NOTE: in single-player DOOM the world stops thinking once the marine
 * dies. Multiplayer can't do that — there may be other sessions
 * possessing monsters who still want a live simulation. AI keeps running
 * regardless of `getMarine().isDead`; downstream damage helpers (`damageActor`)
 * already guard against attacking a corpse, and infighting / wandering
 * remain valid for everybody else.
 */
export function updateAllEnemies(deltaTime) {
  const currentTime = performance.now();
  for (let i = 1, length = state.actors.length; i < length; i++) {
    const thing = state.actors[i];
    if (!thing || !thing.ai) continue;
    if (!ENEMIES.has(thing.type)) continue;

    if (isHumanControlled(thing)) {
      renderer.updateEnemyRotation(thing.thingIndex, thing);
      continue;
    }

    if (thing.collected) {
      if (thing.respawnTimer !== undefined) {
        thing.respawnTimer -= deltaTime;
        if (thing.respawnTimer <= 0) {
          respawnEnemy(thing);
        }
      }
      continue;
    }

    updateSingleEnemy(thing, deltaTime, currentTime);
    renderer.updateEnemyRotation(thing.thingIndex, thing);
  }

  const m = marine();
  if (!isHumanControlled(m) && !m.deathMode && m.hp > 0) {
    updatePlayerAi(deltaTime);
  }
}
