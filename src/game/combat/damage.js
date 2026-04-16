/**
 * Shared damage application pipeline for player/enemy/barrel actors.
 * Side effects (audio/renderer/state transitions) remain in caller modules.
 */

import { asSourceActor, resolveTargetEntity } from '../actors/adapter.js';
import { player } from "../state.js";

export function normalizeDamageSource(source) {
  return asSourceActor(source);
}

export function resolveDamageTarget(target) {
  return resolveTargetEntity(target, player);
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
    if (playerEntity.isDead || targetActor.invulnerable) {
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

    playerEntity.health -= damage;
    result.applied = damage;
    if (playerEntity.health <= 0) {
      playerEntity.health = 0;
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
