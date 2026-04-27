/**
 * WebMCP tools for enemies — thin convenience wrappers over the unified
 * actor snapshot.
 *
 * Mirrors the server tools in `server/mcp/tools/enemies.js`: these delegate
 * to `listActors({ kind: 'enemy' })` and `snapshotActor(entity)` from the
 * shared `src/engine/snapshot.js`, so records are byte-identical to the
 * server's `enemies-list` / `enemies-get-state` output.
 *
 * To possess an enemy, use `actor.possess` with `targetId: 'actor:N'`
 * (spawned monster) or `targetId: 'thing:N'` (legacy thing-only hostile).
 */

import { state, getMarineActor } from '../../../engine/state.js';
import { getControlled } from '../../../engine/possession.js';
import { listActors, snapshotActor, isLiveActor } from '../../../engine/snapshot.js';

/**
 * Distance origin for the local session: the actor it drives, or the
 * marine if the local session is a spectator / pre-assignment.
 */
function originForLocalSession() {
    const anchor = getControlled() || getMarineActor();
    if (!anchor) return {};
    return { originX: anchor.x, originY: anchor.y };
}

function textContent(obj) {
    return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

export function registerEnemyTools() {
    navigator.modelContext.registerTool({
        name: 'enemies.list',
        description:
            "Convenience over actor.list({ kind: 'enemy', alive: true }). Each entry has a stable `id`: `actor:<slot>` for spawned monsters or `thing:<idx>` for legacy thing-only hostiles. Use with enemies.get-state and actor.possess. Sorted by distance from the local session's controlled body (marine fallback for spectators).",
        inputSchema: {
            type: 'object',
            properties: {
                maxDistance: { type: 'number', description: "Omit enemies farther than this many map units from the local session's controlled body." },
                limit: { type: 'integer', description: 'Cap on the number of entries returned.' },
            },
        },
        async execute(args) {
            const maxDistance = Number.isFinite(args?.maxDistance) ? Number(args.maxDistance) : Infinity;
            const limit = Number.isInteger(args?.limit) && args.limit > 0 ? args.limit : Infinity;
            const enemies = listActors({
                kind: 'enemy',
                alive: true,
                ...originForLocalSession(),
                maxDistance,
                limit,
            });
            return textContent({ count: enemies.length, enemies });
        },
    });

    navigator.modelContext.registerTool({
        name: 'enemies.get-state',
        description:
            "Return the latest mirrored state for a single enemy by id. Accepts either a string id `actor:<slot>` / `thing:<idx>` or a legacy numeric id (actor slot preferred, falls back to thing index).",
        inputSchema: {
            type: 'object',
            properties: {
                id: {
                    oneOf: [
                        { type: 'string', description: '`actor:<slot>` or `thing:<idx>` as returned by enemies.list' },
                        { type: 'integer', description: 'Legacy numeric id: actor slot (preferred) or thing index.' },
                    ],
                    description: 'Enemy id from enemies.list.',
                },
            },
            required: ['id'],
        },
        async execute(args) {
            const raw = args?.id;
            let entity = null;
            if (typeof raw === 'string') {
                if (raw.startsWith('actor:')) {
                    entity = state.actors[Number(raw.slice('actor:'.length))] || null;
                } else if (raw.startsWith('thing:')) {
                    entity = state.things[Number(raw.slice('thing:'.length))] || null;
                }
            } else if (Number.isInteger(raw) && raw > 0) {
                entity = state.actors[raw] || state.things[raw] || null;
            }
            if (!entity) return textContent({ ok: false, reason: 'not found' });
            return textContent({
                ok: true,
                enemy: snapshotActor(entity, originForLocalSession()),
                alive: isLiveActor(entity),
            });
        },
    });
}
