/**
 * Headless thing spawner — populates `state.things` and `state.actors` from
 * `mapData.things` without touching the DOM or the renderer.
 *
 * Mirrors the entry-construction logic in
 * [src/client/renderer/scene/entities/things.js](../../renderer/scene/entities/things.js)
 * so the server and browser share the same filter rules and `thingIndex`
 * mapping. The server calls `spawnThings()` during headless map load; the
 * browser calls it before `buildThings()` so DOM nodes align with snapshot ids.
 *
 * The marine is spawned through this same pipeline: `setMapState()` in
 * `src/engine/data/maps.js` synthesizes a `type: MARINE_ACTOR_TYPE` entry at the
 * front of `mapData.things` from the map's `playerStart`, and we branch on
 * that type here to produce the marine-shaped actor.
 *
 * Filter rules match the DOOM WAD conventions:
 *   - Bit 4 (multiplayer-only) — skipped (this build uses one spawn set for all sessions).
 *   - Skill flags:
 *       bit 0 — appears on skill 1-2 (ITYTD / HNTR)
 *       bit 1 — appears on skill 3 (HMP)
 *       bit 2 — appears on skill 4-5 (UV / NM)
 *   - Unknown types (no `THING_NAMES[type]` and no `THING_SPRITES[type]`)
 *     are skipped — they produce no gameplay entity and no visual.
 */

import {
    THING_HEALTH,
    SHOOTABLE,
    ENEMY_AI_STATS,
    LINE_OF_SIGHT_CHECK_INTERVAL,
    SOLID_THING_RADIUS,
    PLAYER_HEIGHT,
    PLAYER_RADIUS,
    MAX_STEP_HEIGHT,
    MOVE_SPEED,
    MONSTER_INTRINSIC_WEAPON_SLOT,
    ENEMY_KIND_BY_TYPE,
} from '../constants.js';
import { THING_CATEGORY, THING_SPRITES, THING_NAMES } from '../data/things.js';
import {
    state,
    ammoProxy,
    maxAmmoProxy,
    MARINE_ACTOR_TYPE,
    getMarineActor,
} from '../state.js';
import { registerActorEntry, registerThingEntry } from './registry.js';
import { mapData } from '../data/maps.js';

/**
 * Shape of the initial capability schema attached to every actor at spawn.
 * Capability blocks exist so identity-based branches (`entity === marine`,
 * `ENEMIES.has(type)`) can migrate to capability reads in subsequent slices
 * without hunting every call site twice.
 *
 * `controller` is the live possession link (null at spawn; possession.js is
 * the source of truth once a session grabs the body). Flat mirror fields
 * (`actor.hp`, `actor.x`, inventory, etc.) are preserved for Slice A; later
 * slices move those into the capability blocks proper.
 */
function buildMarineCapabilities() {
    // ITYTD (skill 1) halves damage the marine takes; every other skill is
    // full damage. Baking this at spawn removes the per-hit skillLevel
    // branch that Slice D collapses.
    const incomingDamageMultiplier = state.skillLevel === 1 ? 0.5 : 1;
    return {
        controller: null,
        onDeath: { mode: 'gameover' },
        movement: {
            hazardSusceptible: true,
            canTriggerWalkOver: true,
        },
        defense: {
            incomingDamageMultiplier,
            hp: 100,
            maxHp: 100,
        },
        offense: {
            projectileType: null,
            attacks: [],
            currentAttack: null,
        },
        inventory: {
            hasBackpack: false,
            canCollectPickups: true,
        },
        brain: null,
    };
}

/**
 * Per-spawn capability snapshot for an AI-driven monster. Skill level
 * baked in at spawn so the per-hit code paths stay identity-free:
 *   - Nightmare (5) doubles incoming damage absorbed? No — nightmare speeds
 *     up behaviour, not damage. `incomingDamageMultiplier` stays 1.
 *   - Damage output amplification is per-attack, so `damageMultiplier`
 *     gets baked into `offense` for future skill tiers.
 *   - HP / maxHp mirror the `THING_HEALTH` value chosen at spawn.
 */
function buildEnemyCapabilities(thingType, spawnHp) {
    return {
        controller: null,
        onDeath: { mode: 'corpse' },
        movement: {
            hazardSusceptible: false,
            canTriggerWalkOver: false,
        },
        defense: {
            incomingDamageMultiplier: 1,
            hp: spawnHp,
            maxHp: spawnHp,
        },
        offense: {
            projectileType: null,
            damageMultiplier: 1,
            attacks: [],
            currentAttack: null,
        },
        inventory: {
            hasBackpack: false,
            canCollectPickups: false,
        },
        brain: {
            profile: 'doom-monster',
            hostile: true,
            faction: 'demon',
        },
    };
}

function buildShootableCapabilities(spawnHp) {
    return {
        controller: null,
        onDeath: { mode: 'explode' },
        movement: {
            hazardSusceptible: false,
            canTriggerWalkOver: false,
        },
        defense: {
            incomingDamageMultiplier: 1,
            hp: spawnHp,
            maxHp: spawnHp,
        },
        offense: {},
        inventory: { canCollectPickups: false },
        brain: null,
    };
}

function buildThingCapabilities() {
    return {
        controller: null,
        onDeath: { mode: 'remove' },
        movement: {
            hazardSusceptible: false,
            canTriggerWalkOver: false,
        },
        defense: { incomingDamageMultiplier: 0 },
        offense: {},
        inventory: { canCollectPickups: false },
        brain: null,
    };
}

function buildMarineEntry(thing, mapThingIndex) {
    const angle = (thing.angle ?? 0) * Math.PI / 180;
    return {
        kind: 'marine',
        type: MARINE_ACTOR_TYPE,
        mapThingIndex,
        lastDamagedBySessionId: null,

        x: thing.x,
        y: thing.y,
        z: 0,
        viewAngle: angle - Math.PI / 2,
        facing: angle,
        floorHeight: thing.floorHeight ?? 0,
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

        ...buildMarineCapabilities(),
    };
}

/**
 * Iterate `mapData.things` and register game entries. The marine (type 1) and
 * enemies go into `state.actors`; pickups, barrels, and solid decorations go
 * into `state.things`. Returns an array parallel to `mapData.things` where
 * each element is either the allocated `thingIndex` (number) or `null` if the
 * map thing produced no game entry (e.g. flavor decoration).
 *
 * The returned array is also stashed at `mapData._thingIndexByMapIdx` so the
 * DOM builder can look up registered entries without re-running the filter.
 */
export function spawnThings() {
    /** @type {Array<number | null>} */
    const mapThingToIndex = [];
    if (!mapData || !mapData.things) {
        if (mapData) mapData._thingIndexByMapIdx = mapThingToIndex;
        return mapThingToIndex;
    }

    // Reset proxy-backed ammo pools to their default starting values. The
    // marine spawned below will reference these same proxies, so HUD
    // subscribers (`subscribeAmmo`) see the reset as ordinary ammo changes.
    ammoProxy.bullets = 50;
    ammoProxy.shells = 0;
    ammoProxy.rockets = 0;
    ammoProxy.cells = 0;
    maxAmmoProxy.bullets = 200;
    maxAmmoProxy.shells = 50;
    maxAmmoProxy.rockets = 50;
    maxAmmoProxy.cells = 300;

    for (let mapThingIndex = 0; mapThingIndex < mapData.things.length; mapThingIndex++) {
        const thing = mapData.things[mapThingIndex];

        if (thing.type === MARINE_ACTOR_TYPE) {
            const marineEntry = buildMarineEntry(thing, mapThingIndex);
            registerActorEntry(marineEntry);
            mapThingToIndex.push(marineEntry.thingIndex);
            continue;
        }

        // Bit 4 = multiplayer-only — not used for this build's spawn set
        if (thing.flags & 16) {
            mapThingToIndex.push(null);
            continue;
        }

        // Skill level flags
        const skillBit = state.skillLevel <= 2 ? 1 : state.skillLevel === 3 ? 2 : 4;
        if (!(thing.flags & skillBit)) {
            mapThingToIndex.push(null);
            continue;
        }

        const thingName = THING_NAMES[thing.type];
        const staticSprite = THING_SPRITES[thing.type];
        if (!thingName && !staticSprite) {
            mapThingToIndex.push(null);
            continue;
        }

        const category = THING_CATEGORY[thing.type] ?? 'decoration';
        const isShootable = SHOOTABLE.has(thing.type);
        const solidRadius = SOLID_THING_RADIUS[thing.type];

        // Matches the condition in buildThings: `category === 'pickup' ||
        // SHOOTABLE.has(thing.type) || SOLID_THING_RADIUS[thing.type]`.
        const shouldRegister = category === 'pickup' || isShootable || Boolean(solidRadius);
        if (!shouldRegister) {
            mapThingToIndex.push(null);
            continue;
        }

        const entry = {
            x: thing.x,
            y: thing.y,
            z: 0,
            type: thing.type,
            collected: false,
            hp: THING_HEALTH[thing.type] || 0,
            // Position of this thing in the raw map JSON. Used to build
            // stable short asset ids (`pickup:<mapThingIndex>`, `key:<mapThingIndex>`)
            // that line up with the ids the
            // SGNL gRPC adapter emits for the same entity.
            mapThingIndex,
        };

        if (solidRadius && !isShootable) {
            entry.solidRadius = solidRadius;
        }

        const aiStats = ENEMY_AI_STATS[thing.type];
        let wSlot;
        if (aiStats) {
            entry.spawnX = thing.x;
            entry.spawnY = thing.y;
            entry.maxHp = entry.hp;
            entry.facing = thing.angle * Math.PI / 180;
            entry.ai = {
                state: 'idle',
                stateTime: 0,
                wakeCheckTimer: Math.random() * LINE_OF_SIGHT_CHECK_INTERVAL,
                rangedLosTimer: 0,
                lastAttack: 0,
                damageDealt: false,
                reactionTimer: 0,
                ambush: (thing.flags & 8) !== 0,
                // Marine is spawned before enemies in this same loop, so the
                // lookup resolves to the fresh marine actor instead of
                // stashing the legacy `'player'` string sentinel.
                target: getMarineActor() ?? null,
                threshold: 0,
                ...aiStats,
            };
            // Nightmare (skill 5): monsters move + think 2x faster. Based
            // on: linuxdoom-1.10/p_mobj.c and info.c nightmare tables. HP
            // stays the same — nightmare scales behaviour, not stats.
            if (state.skillLevel === 5) {
                entry.ai.speed *= 2;
                entry.ai.reactionTime /= 2;
                entry.ai.attackDuration /= 2;
                entry.ai.painDuration /= 2;
                entry.ai.cooldown /= 2;
            }

            wSlot = MONSTER_INTRINSIC_WEAPON_SLOT[thing.type];
            if (wSlot !== undefined) {
                entry.kind = ENEMY_KIND_BY_TYPE[thing.type] || 'enemy';
                entry.maxDropHeight = MAX_STEP_HEIGHT;
                entry.height = PLAYER_HEIGHT;
                entry.radius = entry.ai.radius;
                entry.speed = entry.ai.speed;
                entry.ownedWeapons = new Set([wSlot]);
                entry.currentWeapon = wSlot;
                entry.viewAngle = entry.facing - Math.PI / 2;
                entry.armor = 0;
                entry.armorType = 0;
                entry.ammo = {};
                entry.maxAmmo = {};
                entry.hasBackpack = false;
                entry.powerups = {};
                entry.collectedKeys = new Set();
                entry.deathMode = null;
                entry.deathTime = 0;
                entry.isFiring = false;
                entry.sectorDamageTimer = 0;
                entry.lastDamagedBySessionId = null;
                Object.assign(entry, buildEnemyCapabilities(thing.type, entry.hp));
            }
        }

        let mapRef;
        if (Boolean(aiStats) && wSlot !== undefined) {
            registerActorEntry(entry);
            mapRef = entry.thingIndex;
        } else {
            Object.assign(
                entry,
                isShootable
                    ? buildShootableCapabilities(entry.hp)
                    : buildThingCapabilities(),
            );
            mapRef = registerThingEntry(entry);
        }
        mapThingToIndex.push(mapRef);
    }

    mapData._thingIndexByMapIdx = mapThingToIndex;
    return mapThingToIndex;
}
