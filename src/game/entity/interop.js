/**
 * Thin bridges for movement + damage pipelines until stage 4 merges them.
 */

import { MAX_STEP_HEIGHT } from '../constants.js';
import { getMarine } from '../state.js';
import { getThingIndex } from '../things/registry.js';

function actorTagForEntity(entity) {
    if (entity === getMarine() || entity === 'player') return 'player';
    if (!entity || typeof entity !== 'object') return 'unknown';
    if (entity.type === 2035) return 'barrel';
    if (entity.ai) return 'enemy';
    if (entity.type !== undefined) return 'pickup';
    return 'unknown';
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
    const wrapped = kind === 'player' ? getMarine() : entity;
    return {
        kind,
        entity: wrapped,
        hp: wrapped.hp,
        armor: kind === 'player' ? wrapped.armor : 0,
        armorType: kind === 'player' ? wrapped.armorType : 0,
        invulnerable: kind === 'player' ? !!wrapped.powerups?.invulnerability : false,
    };
}

export function asSourceActor(source) {
    if (!source) return null;
    if (source === 'player' || source === getMarine()) return asDamageableActor(getMarine());
    if (typeof source === 'object') return asDamageableActor(source);
    return null;
}

export function isPlayerActorLike(target) {
    return target === getMarine() || target === 'player';
}

export function resolveTargetEntity(target, playerEntity = getMarine()) {
    return isPlayerActorLike(target) ? playerEntity : target;
}

function isDevBuild() {
    try { return Boolean(import.meta.env?.DEV); } catch { return false; }
}

export function assertMovementActor(actor, context = 'movement') {
    if (!isDevBuild()) return;
    if (!actor || typeof actor.x !== 'number' || typeof actor.y !== 'number') {
        throw new Error(`[interop] Invalid movement actor in ${context}`);
    }
    if (typeof actor.radius !== 'number') {
        throw new Error(`[interop] Missing radius in ${context}`);
    }
}

export function assertDamageableActor(actor, context = 'damage') {
    if (!isDevBuild()) return;
    if (!actor || !actor.entity || typeof actor.kind !== 'string') {
        throw new Error(`[interop] Invalid damage actor in ${context}`);
    }
}
