/**
 * MCP tools for session-level flows (join challenge resolution).
 */

import { z } from 'zod';

import { resolveChallenge } from '../../join-challenge.js';
import { textResult, err, requireConn } from './_helpers.js';

export function registerSessionTools(server, ctx) {
    server.registerTool(
        'session-resolve-join',
        {
            title: 'Resolve join challenge',
            description:
                'After world-poll-events shows kind `joinChallenge` (or you receive a joinChallenge snapshot), choose `displace` to take the MCP agent\'s body or `spectate` to stay a spectator.',
            inputSchema: {
                challengeId: z.string().describe('challengeId from the joinChallenge event.'),
                decision: z.enum(['displace', 'spectate']).describe('displace | spectate'),
            },
        },
        async (args) => {
            const sid = ctx.getSessionId();
            const { conn, error } = requireConn(sid);
            if (error) return error;
            const challengeId = args?.challengeId;
            const decision = args?.decision;
            if (typeof challengeId !== 'string' || !challengeId) {
                return err('challengeId required', {}, sid);
            }
            if (decision !== 'displace' && decision !== 'spectate') {
                return err('decision must be displace or spectate', {}, sid);
            }
            const ok = resolveChallenge(challengeId, conn, decision, undefined);
            if (!ok) {
                return err('unknown, expired, or invalid challenge for this session', { challengeId }, sid);
            }
            return textResult({ ok: true, decision }, sid);
        },
    );
}
