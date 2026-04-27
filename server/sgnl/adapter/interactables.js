/**
 * Curated interactable extractors for the SGNL gRPC adapter.
 *
 * The adapter only exposes entities that matter for access decisions:
 * doors, switches, keys, other pickups, exits, lifts, teleporters and
 * crushers. Each row carries a stable short `id` (`door:<sector>`,
 * `pickup:<thingIndex>`, …) matching runtime `assetId` strings sent to
 * SGNL Access Evaluations.
 *
 * These builders operate on the raw map JSON only (no engine imports),
 * so the adapter stays decoupled from `src/game/*`.
 */

// Switch texture prefixes — keep in sync with `SWITCH_ON_PREFIX` /
// `SWITCH_OFF_PREFIX` in `src/game/constants.js`.
const SWITCH_PREFIXES = ['SW1', 'SW2'];

// Linedef special types for the two exit lines — keep in sync with
// `EXIT_SPECIAL` / `SECRET_EXIT_SPECIAL` in `src/game/constants.js`.
const EXIT_SPECIAL = 11;
const SECRET_EXIT_SPECIAL = 51;

// DOOM thing type → human-friendly key name. Color + material match
// `KEY_TYPES` in `src/game/constants.js` (blue / yellow / red).
const KEY_THING_TYPES = {
    5: { color: 'blue', material: 'card', keyName: 'blue-card' },
    6: { color: 'yellow', material: 'card', keyName: 'yellow-card' },
    13: { color: 'red', material: 'card', keyName: 'red-card' },
    38: { color: 'red', material: 'skull', keyName: 'red-skull' },
    39: { color: 'yellow', material: 'skull', keyName: 'yellow-skull' },
    40: { color: 'blue', material: 'skull', keyName: 'blue-skull' },
};

// All pickup thing types the engine recognises — mirrors
// `PICKUP_THING_TYPES` in `src/data/things.js`. Keys are listed
// separately above and are filtered out of the general `pickups`
// entity so a key only shows up once.
const PICKUP_THING_TYPES = new Set([
    2001, 2002, 2003, 2004, 2005, 2006,
    8,
    2007, 2008, 2010, 2046, 2048, 2049,
    2011, 2012, 2013, 2014, 2015, 2018, 2019,
    2022, 2023, 2024, 2025, 2026, 2045,
    5, 6, 13, 38, 39, 40,
]);

// Human-friendly pickup names for the non-key pickups. Values come
// from `THING_NAMES` in `src/data/things.js` plus a small extension
// so the adapter can label every pickup it emits.
const PICKUP_NAMES = {
    2001: 'shotgun',
    2002: 'chaingun',
    2003: 'rocket-launcher',
    2004: 'plasma-rifle',
    2005: 'chainsaw',
    2006: 'bfg-9000',
    8: 'backpack',
    2007: 'clip',
    2008: 'shells',
    2010: 'rocket',
    2046: 'rocket-box',
    2048: 'bullet-box',
    2049: 'shell-box',
    2011: 'stimpack',
    2012: 'medikit',
    2013: 'soulsphere',
    2014: 'health-bonus',
    2015: 'armor-bonus',
    2018: 'green-armor',
    2019: 'blue-armor',
    2022: 'invulnerability',
    2023: 'berserk',
    2024: 'invisibility',
    2025: 'radsuit',
    2026: 'computer-map',
    2045: 'light-amp',
};

const PICKUP_CATEGORY = {
    // weapons
    2001: 'weapon', 2002: 'weapon', 2003: 'weapon',
    2004: 'weapon', 2005: 'weapon', 2006: 'weapon',
    // ammo
    2007: 'ammo', 2008: 'ammo', 2010: 'ammo',
    2046: 'ammo', 2048: 'ammo', 2049: 'ammo',
    8: 'ammo',
    // health
    2011: 'health', 2012: 'health', 2013: 'health', 2014: 'health',
    // armor
    2015: 'armor', 2018: 'armor', 2019: 'armor',
    // powerups
    2022: 'powerup', 2023: 'powerup', 2024: 'powerup',
    2025: 'powerup', 2026: 'powerup', 2045: 'powerup',
};

// ── Utility ───────────────────────────────────────────────────────────

function sectorCentroid(mapJson, sectorIndex) {
    let sumX = 0;
    let sumY = 0;
    let points = 0;
    const walls = Array.isArray(mapJson.walls) ? mapJson.walls : [];
    for (const wall of walls) {
        const touches =
            wall.sectorIndex === sectorIndex ||
            wall.frontSectorIndex === sectorIndex ||
            wall.backSectorIndex === sectorIndex;
        if (!touches) continue;
        if (wall.start) { sumX += wall.start.x; sumY += wall.start.y; points++; }
        if (wall.end)   { sumX += wall.end.x;   sumY += wall.end.y;   points++; }
    }
    if (points === 0) return { x: 0, y: 0 };
    return { x: sumX / points, y: sumY / points };
}

function lineMidpoint(mapJson, linedef) {
    const vertices = Array.isArray(mapJson.vertices) ? mapJson.vertices : [];
    const a = vertices[linedef.startVertex];
    const b = vertices[linedef.endVertex];
    if (!a || !b) return { x: 0, y: 0 };
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function wallMidpoint(wall) {
    if (!wall.start || !wall.end) return { x: 0, y: 0 };
    return {
        x: (wall.start.x + wall.end.x) / 2,
        y: (wall.start.y + wall.end.y) / 2,
    };
}

function mapName(mapJson) {
    return typeof mapJson?.name === 'string' && mapJson.name.length > 0
        ? mapJson.name
        : 'unknown';
}

// ── Builders ──────────────────────────────────────────────────────────

function buildDoors(mapJson) {
    const doors = Array.isArray(mapJson.doors) ? mapJson.doors : [];
    const name = mapName(mapJson);
    return doors.map((door, index) => {
        const { x, y } = sectorCentroid(mapJson, door.sectorIndex);
        return {
            id: `door:${door.sectorIndex}`,
            index,
            mapName: name,
            sectorIndex: door.sectorIndex,
            x, y,
            closedHeight: door.closedHeight,
            openHeight: door.openHeight,
            floorHeight: door.floorHeight,
            keyRequired: door.keyRequired || null,
        };
    });
}

function buildSwitches(mapJson) {
    const walls = Array.isArray(mapJson.walls) ? mapJson.walls : [];
    const linedefs = Array.isArray(mapJson.linedefs) ? mapJson.linedefs : [];
    const name = mapName(mapJson);
    const rows = [];
    let index = 0;
    for (const wall of walls) {
        if (!wall.texture) continue;
        const prefix = SWITCH_PREFIXES.find((p) => wall.texture.startsWith(p));
        if (!prefix) continue;

        const linedef = linedefs[wall.linedefIndex];
        const specialType = linedef?.specialType ?? 0;
        const sectorTag = linedef?.sectorTag ?? 0;

        let action = 'unknown';
        if (specialType === EXIT_SPECIAL) action = 'exit';
        else if (specialType === SECRET_EXIT_SPECIAL) action = 'secretExit';
        else if (sectorTag > 0) action = 'sectorTag';

        const { x, y } = wallMidpoint(wall);
        rows.push({
            id: `switch:${wall.wallId}`,
            index: index++,
            mapName: name,
            wallId: wall.wallId,
            linedefIndex: wall.linedefIndex,
            texture: wall.texture,
            sectorIndex: wall.sectorIndex,
            sectorTag,
            specialType,
            action,
            x, y,
        });
    }
    return rows;
}

function buildKeys(mapJson) {
    const things = Array.isArray(mapJson.things) ? mapJson.things : [];
    const name = mapName(mapJson);
    const rows = [];
    for (let i = 0; i < things.length; i++) {
        const thing = things[i];
        const keyMeta = KEY_THING_TYPES[thing.type];
        if (!keyMeta) continue;
        rows.push({
            id: `key:${i}`,
            index: rows.length,
            thingIndex: i,
            mapName: name,
            type: thing.type,
            keyName: keyMeta.keyName,
            color: keyMeta.color,
            material: keyMeta.material,
            x: thing.x,
            y: thing.y,
            flags: thing.flags,
        });
    }
    return rows;
}

function buildPickups(mapJson) {
    const things = Array.isArray(mapJson.things) ? mapJson.things : [];
    const name = mapName(mapJson);
    const rows = [];
    for (let i = 0; i < things.length; i++) {
        const thing = things[i];
        if (!PICKUP_THING_TYPES.has(thing.type)) continue;
        // Keys are emitted by `buildKeys` — don't duplicate them here.
        if (KEY_THING_TYPES[thing.type]) continue;
        rows.push({
            id: `pickup:${i}`,
            index: rows.length,
            thingIndex: i,
            mapName: name,
            type: thing.type,
            kind: PICKUP_NAMES[thing.type] || `type-${thing.type}`,
            category: PICKUP_CATEGORY[thing.type] || 'other',
            x: thing.x,
            y: thing.y,
            flags: thing.flags,
        });
    }
    return rows;
}

function buildExits(mapJson) {
    const linedefs = Array.isArray(mapJson.linedefs) ? mapJson.linedefs : [];
    const name = mapName(mapJson);
    const rows = [];
    for (let i = 0; i < linedefs.length; i++) {
        const linedef = linedefs[i];
        const special = linedef.specialType;
        if (special !== EXIT_SPECIAL && special !== SECRET_EXIT_SPECIAL) continue;
        const { x, y } = lineMidpoint(mapJson, linedef);
        rows.push({
            id: `exit:${i}`,
            index: rows.length,
            linedefIndex: i,
            mapName: name,
            kind: special === SECRET_EXIT_SPECIAL ? 'secretExit' : 'exit',
            specialType: special,
            sectorTag: linedef.sectorTag,
            x, y,
        });
    }
    return rows;
}

function buildLifts(mapJson) {
    const lifts = Array.isArray(mapJson.lifts) ? mapJson.lifts : [];
    const name = mapName(mapJson);
    return lifts.map((lift, index) => {
        const { x, y } = sectorCentroid(mapJson, lift.sectorIndex);
        return {
            id: `lift:${lift.sectorIndex}`,
            index,
            mapName: name,
            sectorIndex: lift.sectorIndex,
            tag: lift.tag,
            upperHeight: lift.upperHeight,
            lowerHeight: lift.lowerHeight,
            oneWay: Boolean(lift.oneWay),
            x, y,
        };
    });
}

function buildTeleporters(mapJson) {
    const teleporters = Array.isArray(mapJson.teleporters) ? mapJson.teleporters : [];
    const name = mapName(mapJson);
    return teleporters.map((tele, index) => {
        // Teleporter rows come from the flattener as line segments with
        // start/end vertices and a destination `sectorTag`. Fall back
        // gracefully to vertex lookup when the shape is not present.
        let x = 0;
        let y = 0;
        if (tele.start && tele.end) {
            x = (tele.start.x + tele.end.x) / 2;
            y = (tele.start.y + tele.end.y) / 2;
        } else if (Number.isFinite(tele.startVertex) && Number.isFinite(tele.endVertex)) {
            const mid = lineMidpoint(mapJson, {
                startVertex: tele.startVertex,
                endVertex: tele.endVertex,
            });
            x = mid.x; y = mid.y;
        }
        return {
            id: `teleporter:${index}`,
            index,
            mapName: name,
            sectorTag: tele.sectorTag ?? null,
            specialType: tele.specialType ?? null,
            x, y,
        };
    });
}

function buildCrushers(mapJson) {
    const crushers = Array.isArray(mapJson.crushers) ? mapJson.crushers : [];
    const name = mapName(mapJson);
    return crushers.map((crusher, index) => {
        const sectorIndex = crusher.sectorIndex ?? crusher.index ?? index;
        const { x, y } = sectorCentroid(mapJson, sectorIndex);
        return {
            id: `crusher:${sectorIndex}`,
            index,
            mapName: name,
            sectorIndex,
            tag: crusher.tag ?? null,
            topHeight: crusher.topHeight ?? null,
            crushHeight: crusher.crushHeight ?? null,
            x, y,
        };
    });
}

/**
 * Dispatch table keyed by child-entity `external_id`. Used by
 * `get-page.js` to project the curated interactable views into the
 * `EntityObjects` payload SGNL expects.
 */
export const INTERACTABLE_BUILDERS = Object.freeze({
    doors: buildDoors,
    switches: buildSwitches,
    keys: buildKeys,
    pickups: buildPickups,
    exits: buildExits,
    lifts: buildLifts,
    teleporters: buildTeleporters,
    crushers: buildCrushers,
});
