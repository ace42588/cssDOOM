/**
 * MCP tools for enumerating enemies (read-only listing + single-enemy read).
 * To take control of an enemy, use `actor-possess` with `targetId: 'thing:N'`.
 */

import { z } from 'zod';

import { state } from '../../../src/game/state.js';
import {
    snapshotEnemy,
    isLiveEnemy,
    listEnemies,
} from '../snapshot.js';
import { textResult, err } from './_helpers.js';

export function registerEnemyTools(server, ctx) {
    server.registerTool(
        'enemies-list',
        {
            title: 'List enemies',
            description:
                'List currently-alive enemies. Each entry has stable `id`: `actor:N` slot for spawned monsters, or thing index for legacy thing-only hostiles. Use with enemies-get-state and actor-possess. Sorted by distance to the marine.',
            inputSchema: {
                maxDistance: z.number().optional().describe('Omit enemies farther than this many map units from the marine.'),
                limit: z.number().int().optional().describe('Cap on the number of entries returned.'),
            },
        },
        async (args) => {
            const maxDistance = Number.isFinite(args?.maxDistance) ? Number(args.maxDistance) : Infinity;
            const limit = Number.isInteger(args?.limit) && args.limit > 0 ? args.limit : Infinity;
            const enemies = listEnemies({ maxDistance, limit });
            return textResult({ count: enemies.length, enemies }, ctx.getSessionId());
        },
    );

    server.registerTool(
        'enemies-get-state',
        {
            title: 'Get enemy state',
            description: 'Return the latest authoritative state for a single enemy by actor slot id (enemies-list `id`, usually ≥ 1) or thing index for non-actor hostiles.',
            inputSchema: {
                id: z.number().int().describe('Enemy id from enemies-list (actor slot or thing index).'),
            },
        },
        async (args) => {
            const sid = ctx.getSessionId();
            const id = Number(args?.id);
            if (!Number.isInteger(id) || id <= 0) return err('invalid id', {}, sid);
            let thing = null;
            if (id < state.actors.length) thing = state.actors[id];
            else if (id < state.things.length) thing = state.things[id];
            if (!thing) return err('not found', {}, sid);
            return textResult({
                ok: true,
                enemy: snapshotEnemy(thing),
                alive: isLiveEnemy(thing),
            }, sid);
        },
    );
}
