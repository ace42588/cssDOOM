/**
 * Mutable game state accessible by all modules.
 *
 * All actors (marine + enemies) live in `state.actors`; pickups, barrels, and
 * decorations live in `state.things`. The marine is identified by
 * `actor.type === MARINE_ACTOR_TYPE` (1) — no pinned slot, no pre-seeded
 * singleton. Use `getMarineActor()` for a dynamic lookup.
 *
 * Ammo / maxAmmo are Proxy objects so the HUD can subscribe to changes via
 * `subscribeAmmo()`. The marine actor spawned from a `type: 1` `mapData.things`
 * entry (see `src/engine/things/spawner.js`) references the same proxies, so
 * the subscriptions persist across map resets.
 */

/** Thing type that spawns the player-controlled marine actor. */
export const MARINE_ACTOR_TYPE = 1;

const ammoListeners = new Set();
const _ammo = { bullets: 50, shells: 0, rockets: 0, cells: 0 };
const _maxAmmo = { bullets: 200, shells: 50, rockets: 50, cells: 300 };

function emitAmmoChange(type) {
    const value = _ammo[type];
    const max = _maxAmmo[type];
    for (const cb of ammoListeners) cb(type, value, max);
}

export const ammoProxy = new Proxy(_ammo, {
    set(target, key, value) {
        const changed = target[key] !== value;
        target[key] = value;
        if (changed && typeof key === 'string') emitAmmoChange(key);
        return true;
    },
});

export const maxAmmoProxy = new Proxy(_maxAmmo, {
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

export const state = {
    skillLevel: 1,

    doorState: new Map(),
    liftState: new Map(),
    crusherState: new Map(),

    actors: [],
    things: [],

    projectiles: [],
    nextProjectileId: 0,
};

/**
 * The live marine actor (type === 1), or `null` if none is spawned.
 *
 * The spawner always registers the marine first, so when present it lives at
 * `state.actors[0]`; the scan below protects against the brief windows where
 * no marine exists (pre-map-load, mid-reset, after a zero-marine game-over).
 */
export function getMarineActor() {
    for (let i = 0; i < state.actors.length; i++) {
        const a = state.actors[i];
        if (a && a.type === MARINE_ACTOR_TYPE) return a;
    }
    return null;
}

export const debug = {
    noEnemyAttack: false,
    noEnemyMove: false,
    noclip: false,
};
