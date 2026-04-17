/**
 * Lightweight deterministic regression checks for actor adapters + damage math.
 */

import {
    asDamageableActor,
    asMovementActor,
    getActorId,
    isPlayerActorLike,
    resolveTargetEntity,
} from './adapter.js';
import { applyDamage } from '../combat/damage.js';

function assert(condition, message) {
    if (!condition) throw new Error(`[regressions] ${message}`);
}

function checkArmorAbsorption() {
    const playerEntity = {
        health: 100,
        armor: 100,
        armorType: 1,
        isDead: false,
        powerups: {},
    };
    const result = applyDamage(
        { kind: 'player', entity: playerEntity, invulnerable: false },
        30,
        null,
        { skillLevel: 2 },
    );
    assert(result.applied === 20, 'green armor should absorb one-third');
    assert(playerEntity.health === 80, 'player health should be reduced by absorbed result');
    assert(playerEntity.armor === 90, 'armor should decrease by absorbed amount');
}

function checkPainChanceDeterminism() {
    const enemy = { hp: 100, ai: { painChance: 128, threshold: 0 } };
    const source = { kind: 'enemy', entity: { hp: 50, ai: { threshold: 0 } } };
    const resultHitPain = applyDamage(
        { kind: 'enemy', entity: enemy },
        5,
        source,
        { random: () => 0.2, infightingThreshold: 2.86 },
    );
    assert(resultHitPain.painTriggered, 'pain should trigger when rng under threshold');
    assert(resultHitPain.retargeted, 'enemy source should retarget when threshold unlocked');

    enemy.ai.threshold = 1;
    enemy.ai.target = null;
    const resultNoRetarget = applyDamage(
        { kind: 'enemy', entity: enemy },
        5,
        source,
        { random: () => 0.8, infightingThreshold: 2.86 },
    );
    assert(!resultNoRetarget.retargeted, 'threshold lock should prevent retarget');
}

function checkAdapterInvariants() {
    const enemyThing = { thingIndex: 3, x: 10, y: 20, ai: { radius: 24 }, floorHeight: 0 };
    const actor = asMovementActor(enemyThing);
    assert(actor.kind === 'enemy', 'movement adapter should classify enemy kinds');
    assert(getActorId({ kind: 'enemy', entity: enemyThing }) === 'thing:3', 'actor id should use stable thing index');
    assert(isPlayerActorLike('player'), 'player sentinel should still be recognized');
    assert(resolveTargetEntity('player', { x: 1, y: 1 }).x === 1, 'target resolution should map sentinel to player entity');

    const damageActor = asDamageableActor(enemyThing);
    assert(damageActor.kind === 'enemy', 'damage adapter should preserve enemy kind');
}

export function runActorRegressionChecks() {
    let dev = false;
    try { dev = Boolean(import.meta.env?.DEV); } catch {}
    if (!dev) return;
    checkArmorAbsorption();
    checkPainChanceDeterminism();
    checkAdapterInvariants();
}
