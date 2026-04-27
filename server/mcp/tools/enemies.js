/**
 * MCP tools for enumerating hostile actors (read-only listing + single-actor read).
 *
 * These wrap `actor-list({ kind: 'enemy' })` and `actor-get-state({ id })`
 * against the unified snapshot path. They stay registered as a thin
 * first-class convenience surface because agents often want "just the
 * enemies" and the filter wiring is cheap.
 *
 * To take control of an enemy, use `actor-possess` with `targetId: 'actor:N'`
 * or `targetId: 'thing:N'` (whichever its `id` resolves to from this list).
 */

import { z } from 'zod';

import {
    listActors,
    snapshotActor,
    isLiveActor,
} from '../../views/world.js';
import { state, getMarineActor } from '../../../src/game/state.js';
import { getControlledFor } from '../../../src/game/possession.js';
import { textResult, err } from './_helpers.js';

/**
 * Distance origin for the calling session: the actor the session drives,
 * or the marine if the session is a spectator / hasn't been assigned a
 * body yet. Pure spectators fall back to the marine so `distanceToOrigin`
 * still reflects "distance from the action".
 */
function originForSession(sessionId) {
    const controlled = sessionId ? getControlledFor(sessionId) : null;
    const anchor = controlled || getMarineActor();
    if (!anchor) return {};
    return { originX: anchor.x, originY: anchor.y };
}

export function registerEnemyTools(server, ctx) {
    server.registerTool(
        'enemies-list',
        {
            title: 'List enemies',
            description:
                "Convenience over actor-list({ kind: 'enemy' }). Returns hostile-by-default actors with their unified snapshot shape. Each entry has a stable `id`: `actor:<slot>` for spawned monsters or `thing:<idx>` for legacy thing-only hostiles. Use with enemies-get-state and actor-possess. Sorted by distance from the caller's controlled body (marine if the caller is a spectator).",
            inputSchema: {
                maxDistance: z.number().optional().describe("Omit enemies farther than this many map units from the caller's controlled body."),
                limit: z.number().int().optional().describe('Cap on the number of entries returned.'),
            },
        },
        async (args) => {
            const sid = ctx.getSessionId();
            const maxDistance = Number.isFinite(args?.maxDistance) ? Number(args.maxDistance) : Infinity;
            const limit = Number.isInteger(args?.limit) && args.limit > 0 ? args.limit : Infinity;
            const enemies = listActors({
                kind: 'enemy',
                alive: true,
                ...originForSession(sid),
                maxDistance,
                limit,
            });
            return textResult({ count: enemies.length, enemies }, sid);
        },
    );

    server.registerTool(
        'enemies-get-state',
        {
            title: 'Get enemy state',
            description: 'Return the latest authoritative state for a single enemy by id. Accepts either the numeric id from enemies-list (legacy alias for the actor slot / thing index) or a string id `actor:<slot>` / `thing:<idx>`.',
            inputSchema: {
                id: z.union([
                    z.string().describe('`actor:<slot>` or `thing:<idx>` as returned by enemies-list'),
                    z.number().int().describe('Legacy numeric id: actor slot (preferred) or thing index.'),
                ]).describe('Enemy id from enemies-list.'),
            },
        },
        async (args) => {
            const sid = ctx.getSessionId();
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
            if (!entity) return err('not found', {}, sid);
            const snap = snapshotActor(entity, originForSession(sid));
            return textResult({
                ok: true,
                enemy: snap,
                alive: isLiveActor(entity),
            }, sid);
        },
    );
}
