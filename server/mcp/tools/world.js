/**
 * MCP tools for world-level reads.
 *
 * `world-get-state` is the catch-all "what's going on" view; agents that
 * just want to start playing can call this and decide what to do next.
 * `world-get-map` returns the map name + raw map JSON (mirrors what the
 * browser receives in `mapLoad`). `world-poll-events` drains the per-
 * session event log so agents notice role changes / map switches without
 * needing to diff snapshots.
 */

import { z } from 'zod';

import { snapshotWorld, listPlayers } from '../snapshot.js';
import { getRing, drainLog } from '../sessions.js';
import { getMapPayload } from '../../world.js';
import { textResult } from './_helpers.js';

export function registerWorldTools(server, ctx) {
    server.registerTool(
        'world-get-state',
        {
            title: 'Get world state',
            description:
                'Return a JSON snapshot of the authoritative game world from this session\'s perspective: marine stats, alive enemies, doors, other connected players, and what this session is currently controlling.',
            inputSchema: {},
        },
        async () => textResult(snapshotWorld(ctx.getSessionId()), ctx.getSessionId()),
    );

    server.registerTool(
        'world-get-map',
        {
            title: 'Get current map',
            description:
                'Return the current map name and full map JSON (vertices, linedefs, sectors, things). Same payload the browser receives on mapLoad. Useful for offline navigation/path planning.',
            inputSchema: {
                includeMapData: z
                    .boolean()
                    .optional()
                    .describe('If false, omit the heavy map JSON and just return the name.'),
            },
        },
        async (args) => {
            const includeMapData = args?.includeMapData !== false;
            const { name, mapData } = getMapPayload();
            return textResult({
                mapName: name,
                mapData: includeMapData ? mapData : undefined,
            }, ctx.getSessionId());
        },
    );

    server.registerTool(
        'world-list-players',
        {
            title: 'List players',
            description:
                'List every connected session: their role (player/spectator), the body they control, their position, and their transport (ws or mcp). The session calling this tool is tagged with self=true.',
            inputSchema: {},
        },
        async () => textResult({
            players: listPlayers(ctx.getSessionId()),
        }, ctx.getSessionId()),
    );

    server.registerTool(
        'world-poll-events',
        {
            title: 'Poll events',
            description:
                "Drain this session's pending event log (role changes, map loads, disconnect notices). Returns events since the last call and clears the log.",
            inputSchema: {},
        },
        async () => textResult({ events: drainLog(ctx.getSessionId()) }, ctx.getSessionId()),
    );

    server.registerTool(
        'world-get-latest-snapshot',
        {
            title: 'Latest pushed snapshot',
            description:
                'Return the most recent server-pushed snapshot delta for this session (same shape the browser client receives over WebSocket). Newer than world-get-state at high tick rates because it captures rendererEvents/soundEvents emitted by the engine that frame.',
            inputSchema: {},
        },
        async () => {
            const ring = getRing(ctx.getSessionId());
            return textResult({ snapshot: ring?.snapshot ?? null }, ctx.getSessionId());
        },
    );
}
