/**
 * Headless thing spawner — populates `state.things` from `mapData.things`
 * without touching the DOM or the renderer.
 *
 * Mirrors the entry-construction logic in
 * [src/renderer/scene/entities/things.js](../../renderer/scene/entities/things.js)
 * so the server can own game entities authoritatively, and the browser can
 * still run single-player identical to before. When multiplayer is active,
 * the server calls `spawnThings()` and the browser's `buildThings()` re-uses
 * the existing `state.things` entries instead of registering new ones.
 *
 * Filter rules match the DOOM WAD conventions:
 *   - Bit 4 (multiplayer-only) — skipped (single-player + multiplayer use
 *     the shared set of spawns today).
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
    MAX_STEP_HEIGHT,
    MONSTER_INTRINSIC_WEAPON_SLOT,
    ENEMY_KIND_BY_TYPE,
} from '../constants.js';
import { THING_SPRITES, THING_NAMES } from '../../renderer/scene/constants.js';
import { THING_CATEGORY } from '../../data/things.js';
import { state } from '../state.js';
import { registerActorEntry, registerThingEntry } from './registry.js';
import { mapData } from '../../data/maps.js';

/**
 * Iterate `mapData.things` and register game entries for pickups, shootables,
 * and solid decorations. Returns an array parallel to `mapData.things` where
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

    for (let mapThingIndex = 0; mapThingIndex < mapData.things.length; mapThingIndex++) {
        const thing = mapData.things[mapThingIndex];
        // Bit 4 = multiplayer only — skip in single player
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
                target: 'player',
                threshold: 0,
                ...aiStats,
            };
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
                entry.mapThingIndex = thing.mapThingIndex;
            }
        }

        let mapRef;
        if (Boolean(aiStats) && wSlot !== undefined) {
            registerActorEntry(entry);
            mapRef = entry.thingIndex;
        } else {
            mapRef = registerThingEntry(entry);
        }
        mapThingToIndex.push(mapRef);
    }

    mapData._thingIndexByMapIdx = mapThingToIndex;
    return mapThingToIndex;
}
