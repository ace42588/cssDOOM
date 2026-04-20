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
                'List currently-alive enemies. Each entry has a stable thingIndex `id` (use with enemies-get-state and actor-possess). Sorted by distance to the marine.',
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
            description: 'Return the latest authoritative state for a single enemy by its thingIndex id.',
            inputSchema: {
                id: z.number().int().describe('thingIndex of the enemy.'),
            },
        },
        async (args) => {
            const sid = ctx.getSessionId();
            const id = Number(args?.id);
            if (!Number.isInteger(id) || id < 0 || id >= state.things.length) return err('invalid id', {}, sid);
            const thing = state.things[id];
            if (!thing) return err('not found', {}, sid);
            return textResult({
                ok: true,
                enemy: snapshotEnemy(thing),
                alive: isLiveEnemy(thing),
            }, sid);
        },
    );
}
