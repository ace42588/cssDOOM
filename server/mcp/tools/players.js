/**
 * MCP tools focused on the multiplayer roster — split out from world.* so
 * "find a peer to interact with" reads have a dedicated namespace.
 */

import { z } from 'zod';

import { listPlayers } from '../snapshot.js';
import { textResult, err } from './_helpers.js';

export function registerPlayerTools(server, ctx) {
    server.registerTool(
        'players-list',
        {
            title: 'List players',
            description:
                'Roster of every connected session (humans on WS, agents on MCP). Includes role, controlled body, position, and MCP agent identity metadata (`agent`) when available.',
            inputSchema: {},
        },
        async () => textResult({ players: listPlayers(ctx.getSessionId()) }, ctx.getSessionId()),
    );

    server.registerTool(
        'players-peers',
        {
            title: 'List peers',
            description:
                'Like players-list but excludes the caller. Convenience read for "who else is in this match?" — useful before navigating toward another player to interact with them.',
            inputSchema: {
                onlyControlling: z
                    .boolean()
                    .optional()
                    .describe('If true, omit spectators and only return players currently controlling a body.'),
            },
        },
        async (args) => {
            const self = ctx.getSessionId();
            const onlyControlling = Boolean(args?.onlyControlling);
            const peers = listPlayers(self).filter((p) => {
                if (p.self) return false;
                if (onlyControlling && !p.controlledId) return false;
                return true;
            });
            return textResult({ peers }, self);
        },
    );

    server.registerTool(
        'players-get-self',
        {
            title: 'Get self',
            description:
                "Return the caller's roster entry (sessionId, role, controlled body, position, and MCP agent identity metadata).",
            inputSchema: {},
        },
        async () => {
            const self = ctx.getSessionId();
            const me = listPlayers(self).find((p) => p.self);
            if (!me) return err('no session bound', {}, self);
            return textResult({ self: me }, self);
        },
    );
}
