/**
 * WebMCP tools for enemies.
 *
 * The client is read-only with respect to server-authoritative enemy state:
 * `state.things` is mirrored from each snapshot. Tools here inspect that
 * mirror. To possess an enemy, use `actor.possess` with `targetId: 'thing:N'`.
 *
 * Once possession switches to an enemy, all `actor.*` movement/fire tools
 * drive that body because the server-side `updateMovementFor` and
 * `fireWeaponFor` branch on the session's controlled entity.
 */

import { state, getMarine } from '../../game/state.js';
import { ENEMIES } from '../../game/constants.js';
import { getSessionIdControlling } from '../../game/possession.js';

const ENEMY_LABELS = {
    3004: 'Zombieman',
    9: 'Shotgun Guy',
    3001: 'Imp',
    3002: 'Demon',
    58: 'Spectre',
    3003: 'Baron of Hell',
};

function enemyLabel(type) {
    return ENEMY_LABELS[type] || `Enemy #${type}`;
}

function isLiveEnemy(thing) {
    if (!thing) return false;
    if (thing.collected) return false;
    if ((thing.hp ?? 0) <= 0) return false;
    return Boolean(thing.ai) && ENEMIES.has(thing.type);
}

function snapshotEnemy(thing) {
    const m = getMarine();
    const dx = (thing.x ?? 0) - m.x;
    const dy = (thing.y ?? 0) - m.y;
    return {
        id: thing.thingIndex,
        type: thing.type,
        label: enemyLabel(thing.type),
        x: thing.x,
        y: thing.y,
        z: thing.z ?? thing.floorHeight ?? 0,
        facing: thing.facing ?? null,
        viewAngle: thing.viewAngle ?? null,
        hp: thing.hp ?? null,
        maxHp: thing.maxHp ?? null,
        aiState: thing.ai?.state ?? null,
        distanceToMarine: Math.hypot(dx, dy),
        possessedBySessionId: getSessionIdControlling(thing) ?? null,
    };
}

function textContent(obj) {
    return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

export function registerEnemyTools() {
    navigator.modelContext.registerTool({
        name: 'enemies.list',
        description:
            "List currently-alive enemies mirrored from the latest server snapshot. Each entry has a stable `id` (use with enemies.get-state and actor.possess). Sorted by distance to the marine. Optional maxDistance filter in map units.",
        inputSchema: {
            type: 'object',
            properties: {
                maxDistance: { type: 'number', description: 'Omit enemies farther than this many map units from the marine.' },
                limit: { type: 'integer', description: 'Cap on the number of entries returned.' },
            },
        },
        async execute(args) {
            const maxDistance = Number.isFinite(args?.maxDistance) ? Number(args.maxDistance) : Infinity;
            const limit = Number.isInteger(args?.limit) && args.limit > 0 ? args.limit : Infinity;

            const list = [];
            for (const thing of state.things) {
                if (!isLiveEnemy(thing)) continue;
                const snap = snapshotEnemy(thing);
                if (snap.distanceToMarine > maxDistance) continue;
                list.push(snap);
            }
            list.sort((a, b) => a.distanceToMarine - b.distanceToMarine);
            if (list.length > limit) list.length = limit;
            return textContent({ count: list.length, enemies: list });
        },
    });

    navigator.modelContext.registerTool({
        name: 'enemies.get-state',
        description: 'Return the latest mirrored state for a single enemy by its thingIndex id.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'integer', description: 'thingIndex of the enemy.' },
            },
            required: ['id'],
        },
        async execute(args) {
            const id = Number(args?.id);
            if (!Number.isInteger(id) || id < 0 || id >= state.things.length) {
                return textContent({ ok: false, reason: 'invalid id' });
            }
            const thing = state.things[id];
            if (!thing) return textContent({ ok: false, reason: 'not found' });
            return textContent({
                ok: true,
                enemy: snapshotEnemy(thing),
                alive: isLiveEnemy(thing),
            });
        },
    });
}
