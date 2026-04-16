/**
 * Actor adapters bridge legacy player/enemy/thing shapes to shared interfaces.
 *
 * These adapters are intentionally thin and do not mutate schema. They provide
 * consistent signatures while the codebase migrates toward a full entity model.
 */

import { MAX_STEP_HEIGHT } from '../constants.js';
import { player } from '../state.js';
import { getThingIndex } from '../things/registry.js';

function actorTagForEntity(entity) {
    if (entity === player || entity === 'player') return 'player';
    if (!entity || typeof entity !== 'object') return 'unknown';
    if (entity.type === 2035) return 'barrel';
    if (entity.ai) return 'enemy';
    if (entity.type !== undefined) return 'pickup';
    return 'unknown';
}

export function getActorId(actor) {
    if (!actor) return 'unknown';
    if (actor.kind === 'player') return 'player';
    if (actor.entity?.thingIndex !== undefined) return `thing:${actor.entity.thingIndex}`;
    if (actor.entity) {
        const idx = getThingIndex(actor.entity);
        if (idx >= 0) return `thing:${idx}`;
    }
    return 'unknown';
}

export function isActorAlive(actor) {
    if (!actor) return false;
    if (actor.kind === 'player') return !actor.entity.isDead;
    return !actor.entity.collected && (actor.entity.hp ?? 1) > 0;
}

export function asMovementActor(entity) {
    const kind = actorTagForEntity(entity);
    const isPlayer = kind === 'player';
    return {
        kind,
        entity,
        x: entity.x,
        y: entity.y,
        radius: entity.ai ? entity.ai.radius : entity.radius,
        floorHeight: entity.floorHeight,
        maxDropHeight: isPlayer ? Infinity : MAX_STEP_HEIGHT,
        excludeThing: isPlayer ? null : entity,
    };
}

export function asDamageableActor(entity) {
    const kind = actorTagForEntity(entity);
    const wrapped = kind === 'player' ? player : entity;
    return {
        kind,
        entity: wrapped,
        hp: kind === 'player' ? wrapped.health : wrapped.hp,
        armor: kind === 'player' ? wrapped.armor : 0,
        armorType: kind === 'player' ? wrapped.armorType : 0,
        invulnerable: kind === 'player' ? !!wrapped.powerups?.invulnerability : false,
    };
}

export function asSourceActor(source) {
    if (!source) return null;
    if (source === 'player' || source === player) return asDamageableActor(player);
    if (typeof source === 'object') return asDamageableActor(source);
    return null;
}

export function isPlayerActorLike(target) {
    return target === player || target === 'player';
}

export function resolveTargetEntity(target, playerEntity = player) {
    return isPlayerActorLike(target) ? playerEntity : target;
}

export function assertMovementActor(actor, context = 'movement') {
    if (!import.meta.env.DEV) return;
    if (!actor || typeof actor.x !== 'number' || typeof actor.y !== 'number') {
        throw new Error(`[adapter] Invalid movement actor in ${context}`);
    }
    if (typeof actor.radius !== 'number') {
        throw new Error(`[adapter] Missing radius in ${context}`);
    }
}

export function assertDamageableActor(actor, context = 'damage') {
    if (!import.meta.env.DEV) return;
    if (!actor || !actor.entity || typeof actor.kind !== 'string') {
        throw new Error(`[adapter] Invalid damage actor in ${context}`);
    }
}
