/**
 * WebMCP tools for enemies.
 *
 * The client is read-only with respect to server-authoritative enemy state:
 * `state.things` is mirrored from each snapshot. Tools here either inspect
 * that mirror or ask the server (via the body-swap input flag) to hand the
 * local session a different body to pilot.
 *
 * Once possession switches to an enemy, all `marine.*` movement/fire tools
 * naturally drive that body because the server-side `updateMovementFor`
 * and `fireWeaponFor` already branch on the session's controlled entity.
 */

import { state, player } from '../../game/state.js';
import { ENEMIES } from '../../game/constants.js';
import { requestBodySwap } from '../../net/client.js';

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
    const dx = (thing.x ?? 0) - player.x;
    const dy = (thing.y ?? 0) - player.y;
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
        possessedBySessionId: thing.__sessionId ?? null,
    };
}

function textContent(obj) {
    return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

export function registerEnemyTools() {
    navigator.modelContext.registerTool({
        name: 'enemies.list',
        description:
            "List currently-alive enemies mirrored from the latest server snapshot. Each entry has a stable `id` (use with enemies.get-state / enemies.possess). Sorted by distance to the marine. Optional maxDistance filter in map units.",
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

    navigator.modelContext.registerTool({
        name: 'enemies.possess',
        description:
            'Ask the server to hand the local session control of the given enemy (body-swap). On success, subsequent marine.* movement/fire tools will drive the possessed body. The server validates: target must be alive, uncollected, not controlled by another session.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'integer', description: 'thingIndex of the enemy to possess.' },
            },
            required: ['id'],
        },
        async execute(args) {
            const id = Number(args?.id);
            if (!Number.isInteger(id) || id < 0) {
                return textContent({ ok: false, reason: 'invalid id' });
            }
            const thing = state.things[id];
            if (!thing) return textContent({ ok: false, reason: 'not found' });
            if (!isLiveEnemy(thing)) {
                return textContent({ ok: false, reason: 'enemy not live/possessable from client view' });
            }
            requestBodySwap(`thing:${id}`);
            return textContent({ ok: true, requested: `thing:${id}` });
        },
    });

    navigator.modelContext.registerTool({
        name: 'enemies.release',
        description:
            'Ask the server to return the local session to the marine body (the inverse of enemies.possess).',
        inputSchema: { type: 'object', properties: {} },
        async execute() {
            requestBodySwap('player');
            return textContent({ ok: true, requested: 'player' });
        },
    });
}
