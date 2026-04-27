import { state } from '../../src/game/state.js';
import { getThingIndex } from '../../src/game/things/registry.js';
import { getSessionIdControlling } from '../../src/game/possession.js';

/** Allocate a fresh, empty baseline for a newly-attached connection. */
export function emptyBaseline() {
    return {
        actors: new Map(),
        things: new Map(),
        projectiles: new Map(),
        doors: new Map(),
        lifts: new Map(),
        crushers: new Map(),
        role: null,
        controlledId: null,
        followTargetId: null,
    };
}

/** Clear a baseline in place. Called when a map load is about to fire. */
export function resetBaseline(conn) {
    if (!conn) return;
    conn.baseline = emptyBaseline();
}

const _current = {
    actors: new Map(),
    things: new Map(),
    projectiles: new Map(),
    doors: new Map(),
    lifts: new Map(),
    crushers: new Map(),
};

const _seenActors = new Set();
const _seenThings = new Set();
const _seenProjectiles = new Set();
const _seenDoors = new Set();
const _seenLifts = new Set();
const _seenCrushers = new Set();

/**
 * Allocates a record that every actor (marine, enemy, possessed monster)
 * shares. Optional capability sub-blocks (`loadout`-style ammo/weapons,
 * inventory-style keys/powerups) default to `null` so diffing can distinguish
 * "actor does not carry this" from "value cleared".
 */
function makeEmptyActorRecord() {
    return {
        id: -1,
        type: 0,
        x: 0, y: 0, z: null,
        floorHeight: 0,
        angle: null,
        facing: null,
        hp: null,
        maxHp: null,
        collected: false,
        aiState: null,
        armor: null,
        armorType: null,
        ammo: null,
        maxAmmo: null,
        ownedWeapons: null,
        currentWeapon: null,
        collectedKeys: null,
        powerups: null,
        hasBackpack: false,
        isDead: false,
        isAiDead: false,
        isFiring: false,
        __sessionId: null,
    };
}

function makeEmptyThingRecord() {
    return {
        id: -1,
        type: 0,
        x: 0, y: 0, z: null,
        floorHeight: 0,
        facing: 0,
        viewAngle: null,
        hp: null,
        maxHp: null,
        collected: false,
        aiState: null,
        __sessionId: null,
    };
}

function makeEmptyProjectileRecord() {
    return { id: null, x: 0, y: 0, z: 0 };
}

function makeEmptyDoorRecord() {
    return {
        sectorIndex: -1,
        open: false,
        passable: false,
        sessionId: null,
        viewAngle: 0,
        pendingRequests: null,
    };
}

function makeEmptyLiftRecord() {
    return {
        sectorIndex: -1,
        currentHeight: 0,
        targetHeight: 0,
        moving: false,
    };
}

function makeEmptyCrusherRecord() {
    return {
        sectorIndex: -1,
        active: false,
        direction: 0,
        currentHeight: 0,
        damageTimer: 0,
    };
}

export function serializeCurrentWorld() {
    syncActors(_current.actors, _seenActors);
    syncThings(_current.things, _seenThings);
    syncProjectiles(_current.projectiles, _seenProjectiles);
    syncDoors(_current.doors, _seenDoors);
    syncLifts(_current.lifts, _seenLifts);
    syncCrushers(_current.crushers, _seenCrushers);

    return _current;
}

function syncThings(map, seen) {
    seen.clear();
    for (let i = 0; i < state.things.length; i++) {
        const t = state.things[i];
        const id = getThingIndex(t);
        let rec = map.get(id);
        if (!rec) {
            rec = makeEmptyThingRecord();
            map.set(id, rec);
        }
        fillThingRecord(rec, id, t);
        seen.add(id);
    }
    sweepStale(map, seen);
}

function syncProjectiles(map, seen) {
    seen.clear();
    for (let i = 0; i < state.projectiles.length; i++) {
        const p = state.projectiles[i];
        let rec = map.get(p.id);
        if (!rec) {
            rec = makeEmptyProjectileRecord();
            map.set(p.id, rec);
        }
        fillProjectileRecord(rec, p);
        seen.add(p.id);
    }
    sweepStale(map, seen);
}

function syncDoors(map, seen) {
    seen.clear();
    for (const entry of state.doorState.values()) {
        const key = entry.sectorIndex;
        let rec = map.get(key);
        if (!rec) {
            rec = makeEmptyDoorRecord();
            map.set(key, rec);
        }
        fillDoorRecord(rec, entry);
        seen.add(key);
    }
    sweepStale(map, seen);
}

function syncLifts(map, seen) {
    seen.clear();
    for (const entry of state.liftState.values()) {
        const key = entry.sectorIndex;
        let rec = map.get(key);
        if (!rec) {
            rec = makeEmptyLiftRecord();
            map.set(key, rec);
        }
        fillLiftRecord(rec, entry);
        seen.add(key);
    }
    sweepStale(map, seen);
}

function syncCrushers(map, seen) {
    seen.clear();
    for (const entry of state.crusherState.values()) {
        const key = entry.sectorIndex;
        let rec = map.get(key);
        if (!rec) {
            rec = makeEmptyCrusherRecord();
            map.set(key, rec);
        }
        fillCrusherRecord(rec, entry);
        seen.add(key);
    }
    sweepStale(map, seen);
}

function sweepStale(map, seen) {
    if (map.size === seen.size) return;
    for (const key of map.keys()) {
        if (!seen.has(key)) map.delete(key);
    }
}

/**
 * Uniform actor emitter. Every entry in `state.actors` — marine-type or
 * monster — ships through this function. The actor's runtime id is its
 * natural slot in `state.actors`; there is no reserved index. Optional
 * capability blocks (`ammo`, `ownedWeapons`, `collectedKeys`, …) are left
 * `null` for actors that don't carry them so the diff helper doesn't emit
 * spurious updates as monsters move.
 */
function syncActors(map, seen) {
    seen.clear();
    for (let i = 0; i < state.actors.length; i++) {
        const a = state.actors[i];
        if (!a) continue;
        let rec = map.get(i);
        if (!rec) {
            rec = makeEmptyActorRecord();
            map.set(i, rec);
        }
        fillActorRecord(rec, i, a);
        seen.add(i);
    }
    sweepStale(map, seen);
}

function fillActorRecord(rec, id, a) {
    rec.id = id;
    rec.type = a.type;
    rec.x = a.x;
    rec.y = a.y;
    rec.z = a.z ?? null;
    rec.floorHeight = a.floorHeight ?? 0;
    rec.angle = typeof a.viewAngle === 'number' ? a.viewAngle : null;
    rec.facing = typeof a.facing === 'number' ? a.facing : null;
    rec.hp = a.hp ?? null;
    rec.maxHp = a.maxHp ?? null;
    rec.collected = Boolean(a.collected);
    rec.aiState = a.ai?.state ?? null;
    rec.armor = typeof a.armor === 'number' ? a.armor : null;
    rec.armorType = a.armorType ?? null;
    rec.ammo = a.ammo ? { ...a.ammo } : null;
    rec.maxAmmo = a.maxAmmo ? { ...a.maxAmmo } : null;
    rec.ownedWeapons = a.ownedWeapons ? [...a.ownedWeapons] : null;
    rec.currentWeapon = typeof a.currentWeapon === 'number' ? a.currentWeapon : null;
    rec.collectedKeys = a.collectedKeys ? [...a.collectedKeys] : null;
    rec.powerups = a.powerups ? { ...a.powerups } : null;
    rec.hasBackpack = Boolean(a.hasBackpack);
    rec.isDead = a.deathMode === 'gameover';
    rec.isAiDead = a.deathMode === 'ai';
    rec.isFiring = Boolean(a.isFiring);
    rec.__sessionId = getSessionIdControlling(a) ?? null;
}

function fillThingRecord(rec, id, t) {
    rec.id = id;
    rec.type = t.type;
    rec.x = t.x;
    rec.y = t.y;
    rec.z = t.z ?? null;
    rec.floorHeight = t.floorHeight ?? 0;
    rec.facing = t.facing ?? 0;
    rec.viewAngle = typeof t.viewAngle === 'number' ? t.viewAngle : null;
    rec.hp = t.hp ?? null;
    rec.maxHp = t.maxHp ?? null;
    rec.collected = Boolean(t.collected);
    rec.aiState = t.ai?.state ?? null;
    rec.__sessionId = getSessionIdControlling(t) ?? null;
}

function fillProjectileRecord(rec, p) {
    rec.id = p.id;
    rec.x = p.x;
    rec.y = p.y;
    rec.z = p.z;
}

const EMPTY_PENDING_REQUESTS = Object.freeze([]);

function fillDoorRecord(rec, entry) {
    const doorEntity = entry.doorEntity;
    rec.sectorIndex = entry.sectorIndex;
    rec.open = Boolean(entry.open);
    rec.passable = Boolean(entry.passable);
    rec.sessionId = getSessionIdControlling(doorEntity) ?? null;
    rec.viewAngle = typeof doorEntity?.viewAngle === 'number' ? doorEntity.viewAngle : 0;
    const pending = doorEntity?.pendingRequests;
    if (pending && pending.length > 0) {
        const out = new Array(pending.length);
        for (let i = 0; i < pending.length; i++) {
            const r = pending[i];
            out[i] = {
                id: r.id,
                interactorId: r.interactorId,
                interactorLabel: r.interactorLabel,
                interactorDetails: r.interactorDetails,
                approachSide: r.approachSide,
            };
        }
        rec.pendingRequests = out;
    } else {
        rec.pendingRequests = EMPTY_PENDING_REQUESTS;
    }
}

function fillLiftRecord(rec, entry) {
    rec.sectorIndex = entry.sectorIndex;
    rec.currentHeight = entry.currentHeight;
    rec.targetHeight = entry.targetHeight;
    rec.moving = Boolean(entry.moving);
}

function fillCrusherRecord(rec, entry) {
    rec.sectorIndex = entry.sectorIndex;
    rec.active = Boolean(entry.active);
    rec.direction = entry.direction;
    rec.currentHeight = entry.currentHeight;
    rec.damageTimer = entry.damageTimer;
}

export function fieldsEqual(a, b) {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b)) return false;
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!fieldsEqual(a[i], b[i])) return false;
        }
        return true;
    }
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
        if (!fieldsEqual(a[k], b[k])) return false;
    }
    return true;
}

export function diffRecord(prev, next) {
    if (!prev) {
        const out = {};
        for (const k of Object.keys(next)) {
            if (next[k] !== undefined) out[k] = next[k];
        }
        return out;
    }
    let out = null;
    for (const k of Object.keys(next)) {
        if (!fieldsEqual(prev[k], next[k])) {
            if (!out) out = {};
            out[k] = next[k];
        }
    }
    return out;
}

export function diffAndCommit(conn, current, meta) {
    if (!conn.baseline) conn.baseline = emptyBaseline();
    const baseline = conn.baseline;

    const delta = {
        type: 'snapshot',
        tick: meta.tick,
        serverTime: meta.serverTime,
        rendererEvents: meta.rendererEvents,
        soundEvents: meta.soundEvents,
    };

    if (conn.role !== baseline.role) {
        delta.role = conn.role;
        baseline.role = conn.role;
    }
    if (conn.controlledId !== baseline.controlledId) {
        delta.controlledId = conn.controlledId;
        baseline.controlledId = conn.controlledId;
    }
    if (conn.followTargetId !== baseline.followTargetId) {
        delta.followTargetId = conn.followTargetId;
        baseline.followTargetId = conn.followTargetId;
    }

    delta.actors = diffIdMap(baseline.actors, current.actors);

    delta.things = diffIdMap(baseline.things, current.things);
    delta.projectiles = diffIdMap(baseline.projectiles, current.projectiles);
    delta.doors = diffKeyedUpdates(baseline.doors, current.doors, 'sectorIndex');
    delta.lifts = diffKeyedUpdates(baseline.lifts, current.lifts, 'sectorIndex');
    delta.crushers = diffKeyedUpdates(baseline.crushers, current.crushers, 'sectorIndex');

    return delta;
}

export function diffIdMap(baselineMap, currentMap) {
    const spawn = [];
    const update = [];
    const despawn = [];

    for (const [id, record] of currentMap) {
        const prev = baselineMap.get(id);
        if (!prev) {
            spawn.push({ ...record });
            baselineMap.set(id, { ...record });
            continue;
        }
        const changed = diffRecord(prev, record);
        if (changed && Object.keys(changed).length > 0) {
            update.push({ id, ...changed });
            for (const k of Object.keys(changed)) prev[k] = changed[k];
        }
    }

    for (const id of baselineMap.keys()) {
        if (!currentMap.has(id)) {
            despawn.push(id);
        }
    }
    for (const id of despawn) baselineMap.delete(id);

    return { spawn, update, despawn };
}

export function diffKeyedUpdates(baselineMap, currentMap, keyField) {
    const out = [];
    for (const [key, record] of currentMap) {
        const prev = baselineMap.get(key);
        if (!prev) {
            out.push({ ...record });
            baselineMap.set(key, { ...record });
            continue;
        }
        const changed = diffRecord(prev, record);
        if (changed && Object.keys(changed).length > 0) {
            out.push({ [keyField]: key, ...changed });
            for (const k of Object.keys(changed)) prev[k] = changed[k];
        }
    }
    return out;
}

