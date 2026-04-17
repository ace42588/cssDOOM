/**
 * Enemy AI — state machine, movement orchestration, and per-frame update loop.
 */

import {
  ENEMIES,
  ENEMY_PROJECTILES,
  LINE_OF_SIGHT_CHECK_INTERVAL,
  MAX_RENDER_DISTANCE,
} from "../constants.js";

import { state, player, debug } from "../state.js";
import { getSectorAt } from "../physics/queries.js";
import * as renderer from "../../renderer/index.js";
import { hasLineOfSight } from "../physics/line-of-sight.js";
import { isSectorAlerted } from "../sound-propagation.js";
import { damagePlayer } from "../player/damage.js";
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
} from "../geometry.js";
import { moveEnemyToward } from './chase.js';
import {
  distance2,
  inRadius,
  resolveTargetActor,
} from '../actors/math.js';
import { isPlayerActorLike } from '../actors/adapter.js';
import { isHumanControlled } from '../possession.js';
import { updatePlayerAi } from './player-ai.js';

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

/**
 * Chase target position; invalidates dead infighting targets (→ player, threshold 0).
 * Based on: linuxdoom-1.10/p_enemy.c:A_Chase() — target dead → P_LookForPlayers flow.
 */
function resolveTarget(enemy, deltaTime) {
  const ai = enemy.ai;
  let targetActor = resolveTargetActor(enemy, player);

  if (targetActor !== player) {
    if (targetActor.collected || targetActor.hp <= 0) {
      ai.target = "player";
      ai.threshold = 0;
      targetActor = player;
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
          damagePlayer(meleeDmg);
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

/**
 * All enemies: nightmare respawn, distance cull, AI tick, sprite rotation.
 * Based on: linuxdoom-1.10/p_mobj.c:P_NightmareRespawn()
 */
export function updateAllEnemies(deltaTime) {
  if (player.isDead) return;
  const currentTime = performance.now();
  const allThings = state.things;
  for (let i = 0, length = allThings.length; i < length; i++) {
    const thing = allThings[i];
    if (!thing.ai) continue;
    if (!ENEMIES.has(thing.type)) continue;

    // Skip monsters under any human controller — those sessions drive the
    // body through movement/weapon modules instead. In single-player this
    // matches the previous "skip the one possessed body" behavior.
    //
    // BUT: DOOM sprite rotation is computed relative to *the local
    // viewer*, not the monster itself. Non-possessed enemies get their
    // rotation refreshed every tick below; if we bail here for possessed
    // bodies the sprite stays locked on whatever frame the last net
    // snapshot set, so it looks static (or jumps on facing deltas) as
    // the local player walks around them. Keep the rotation refresh but
    // skip the AI tick.
    if (isHumanControlled(thing)) {
      if (inRadius(thing, player, MAX_RENDER_DISTANCE)) {
        renderer.updateEnemyRotation(getThingIndex(thing), thing);
      }
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

    //if (!inRadius(thing, player, MAX_RENDER_DISTANCE)) continue;

    updateSingleEnemy(thing, deltaTime, currentTime);
    renderer.updateEnemyRotation(getThingIndex(thing), thing);
  }

  // When no human is driving the player character, run a lightweight
  // enemy-style AI on it so the ex-body keeps fighting and roaming.
  if (!isHumanControlled(player) && !player.isAiDead && !player.isDead) {
    updatePlayerAi(deltaTime);
  }
}
