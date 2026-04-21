/**
 * Capability predicates and pose helpers. No classes; no allocations.
 * `possession.js` must not import this module (avoid cycles); callers pass entities in.
 */

import { ENEMIES, WEAPONS } from '../constants.js';
import { getMarine } from '../state.js';
import { getSessionIdControlling } from '../possession.js';
import { normalizeAngle } from '../math/angle.js';

export function kindOf(target) {
    if (!target || typeof target !== 'object') return 'unknown';
    if (target === getMarine()) return 'marine';
    if (target.__isDoorEntity) return 'door';
    if (target.ai && ENEMIES.has(target.type)) return 'enemy';
    if (target.ai) return 'monster';
    return 'thing';
}

export function sessionIdOf(entity) {
    return getSessionIdControlling(entity);
}

export function isActorAlive(actor) {
    if (!actor) return false;
    if (actor === getMarine()) return actor.hp > 0 && !actor.deathMode;
    if (actor.__isDoorEntity) return true;
    if (!actor.ai) return false;
    if (actor.collected) return false;
    return (actor.hp ?? 0) > 0;
}

/** Same gate as snapshot `entityIsControllableSnapshot` / assignment `controlledBodyIsAlive` for bodies. */
export function isControllableBody(entity) {
    return isActorAlive(entity);
}

export function canPossess(entity) {
    return isControllableBody(entity);
}

export function canFire(entity) {
    if (!entity) return false;
    if (entity.__isDoorEntity) return false;
    if (entity === getMarine()) {
        const w = WEAPONS[entity.currentWeapon];
        if (!w) return false;
        if (!w.ammoType) return true;
        return entity.ammo[w.ammoType] >= (w.ammoPerShot || 0);
    }
    if (entity.ai) return (entity.hp ?? 0) > 0 && !entity.collected;
    return false;
}

export function canUse(entity) {
    if (!entity) return false;
    if (entity.__isDoorEntity) return true;
    return entity === getMarine() || Boolean(entity.ai);
}

export function canMove(entity) {
    return entity && !entity.__isDoorEntity;
}

export function canBeFollowed(entity) {
    return isControllableBody(entity);
}

/** Pose for MCP / UI (angles normalized to [-pi, pi]). */
export function poseOf(entity) {
    if (!entity) return null;
    if (entity === getMarine()) {
        const m = getMarine();
        return {
            kind: 'marine',
            x: m.x,
            y: m.y,
            z: m.z,
            angle: normalizeAngle(m.viewAngle),
        };
    }
    if (entity.__isDoorEntity) {
        return {
            kind: 'door',
            x: entity.x,
            y: entity.y,
            z: entity.z ?? 0,
            angle: normalizeAngle(entity.viewAngle ?? 0),
        };
    }
    const angle = typeof entity.viewAngle === 'number'
        ? entity.viewAngle
        : ((entity.facing ?? 0) - Math.PI / 2);
    return {
        kind: 'enemy',
        x: entity.x,
        y: entity.y,
        z: entity.z ?? entity.floorHeight ?? 0,
        angle: normalizeAngle(angle),
    };
}
