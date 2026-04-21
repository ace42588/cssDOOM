import { MOVE_SPEED, PLAYER_HEIGHT, PLAYER_RADIUS } from './constants.js';

/**
 * Mutable game state accessible by all modules.
 *
 * Marine + enemies live in `state.actors` (marine pinned at index 0). Pickups,
 * barrels, and decorations stay in `state.things`. Use `getMarine()` for the
 * singleton marine reference.
 */

const ammoListeners = new Set();
const _ammo = { bullets: 50, shells: 0, rockets: 0, cells: 0 };
const _maxAmmo = { bullets: 200, shells: 50, rockets: 50, cells: 300 };

function emitAmmoChange(type) {
    const value = _ammo[type];
    const max = _maxAmmo[type];
    for (const cb of ammoListeners) cb(type, value, max);
}

const ammoProxy = new Proxy(_ammo, {
    set(target, key, value) {
        const changed = target[key] !== value;
        target[key] = value;
        if (changed && typeof key === 'string') emitAmmoChange(key);
        return true;
    },
});

const maxAmmoProxy = new Proxy(_maxAmmo, {
    set(target, key, value) {
        const changed = target[key] !== value;
        target[key] = value;
        if (changed && typeof key === 'string') emitAmmoChange(key);
        return true;
    },
});

export function subscribeAmmo(callback) {
    ammoListeners.add(callback);
    return () => ammoListeners.delete(callback);
}

export const AMMO_TYPES = Object.freeze(['bullets', 'shells', 'rockets', 'cells']);

export const MARINE_THING_TYPE = 1;

export const MARINE_SLOT = 0;

const marine = {
    kind: 'marine',
    type: MARINE_THING_TYPE,
    thingIndex: null,
    mapThingIndex: null,

    x: 0,
    y: 0,
    z: 0,
    viewAngle: 0,
    facing: Math.PI / 2,
    floorHeight: 0,
    speed: MOVE_SPEED,
    radius: PLAYER_RADIUS,
    height: PLAYER_HEIGHT,
    maxDropHeight: Infinity,

    hp: 100,
    maxHp: 100,
    armor: 0,
    armorType: 0,
    ammo: ammoProxy,
    maxAmmo: maxAmmoProxy,
    hasBackpack: false,
    deathMode: null,
    deathTime: 0,

    currentWeapon: 2,
    ownedWeapons: new Set([1, 2]),
    isFiring: false,
    sectorDamageTimer: 0,
    collectedKeys: new Set(),
    powerups: {},

    ai: null,
};

export const state = {
    skillLevel: 1,

    doorState: new Map(),
    liftState: new Map(),
    crusherState: new Map(),

    actors: [marine],
    things: [],

    projectiles: [],
    nextProjectileId: 0,
};

/** The marine actor — always `state.actors[MARINE_SLOT]`. */
export function getMarine() {
    return state.actors[MARINE_SLOT];
}

export const debug = {
    noEnemyAttack: false,
    noEnemyMove: false,
    noclip: false,
};
