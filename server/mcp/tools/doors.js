/**
 * MCP tools for doors.
 *
 * Doors are identified by sector index. The "open-in-front" tool maps to
 * the same `use` press a human would do — the controlled body must be
 * facing the door and within range. Approve/deny only have effect when
 * this session is the door's current camera operator (`processConnectionInputs`
 * ignores non-operators). Take the camera with `actor-possess` and
 * `targetId: 'door:N'`.
 *
 * Direct "open this specific door now, regardless of facing/range" is
 * intentionally not a tool here — that would be admin-level mutation and
 * lives in the deferred `admin.*` namespace.
 */

import { z } from 'zod';

import { state } from '../../../src/game/state.js';
import { snapshotDoor, listDoors } from '../snapshot.js';
import { textResult, ok, err, requireConn } from './_helpers.js';

export function registerDoorTools(server, ctx) {
    server.registerTool(
        'doors-list',
        {
            title: 'List doors',
            description:
                'List every door in the current map. Each entry includes sectorIndex, open/passable flags, key requirement, current camera operator (if any), and any pending operator requests.',
            inputSchema: {},
        },
        async () => {
            const doors = listDoors();
            return textResult({ count: doors.length, doors }, ctx.getSessionId());
        },
    );

    server.registerTool(
        'doors-get-state',
        {
            title: 'Get door state',
            description: 'Return the latest authoritative state for a single door by its sectorIndex.',
            inputSchema: {
                sectorIndex: z.number().int().describe('Sector index of the door.'),
            },
        },
        async (args) => {
            const sid = ctx.getSessionId();
            const sectorIndex = Number(args?.sectorIndex);
            if (!Number.isInteger(sectorIndex)) return err('sectorIndex must be an integer', {}, sid);
            const entry = state.doorState.get(sectorIndex);
            if (!entry) return err('door not found', {}, sid);
            return textResult({ ok: true, door: snapshotDoor(entry) }, sid);
        },
    );

    server.registerTool(
        'doors-open-in-front',
        {
            title: 'Press use',
            description:
                "Press 'use' (equivalent to space). Opens the door the controlled body is facing, hits switches, triggers linedef specials. Edge-triggered: consumed once per call. Result confirms the input flag was queued; observe the next world-get-state for actual outcome.",
            inputSchema: {},
        },
        async () => {
            const { conn, error } = requireConn(ctx.getSessionId());
            if (error) return error;
            conn.input.use = true;
            return ok({ queued: 'use' }, conn.sessionId);
        },
    );

    server.registerTool(
        'doors-approve-request',
        {
            title: 'Approve door request',
            description:
                "Approve a pending door-open request. Only meaningful when this session is the door's current camera operator (see actor-possess with targetId door:N); the server ignores decisions from non-operators. Find requestId values via doors-list / doors-get-state.",
            inputSchema: {
                sectorIndex: z.number().int(),
                requestId: z.number().int(),
            },
        },
        async (args) => {
            const { conn, error } = requireConn(ctx.getSessionId());
            if (error) return error;
            const sectorIndex = Number(args?.sectorIndex);
            const requestId = Number(args?.requestId);
            if (!Number.isInteger(sectorIndex) || !Number.isInteger(requestId)) {
                return err('sectorIndex and requestId must be integers', {}, conn.sessionId);
            }
            conn.input.doorDecision = { sectorIndex, requestId, decision: 'open' };
            return ok({ sectorIndex, requestId, decision: 'open' }, conn.sessionId);
        },
    );

    server.registerTool(
        'doors-deny-request',
        {
            title: 'Deny door request',
            description:
                'Deny a pending door-open request (same operator-only caveat as doors-approve-request).',
            inputSchema: {
                sectorIndex: z.number().int(),
                requestId: z.number().int(),
            },
        },
        async (args) => {
            const { conn, error } = requireConn(ctx.getSessionId());
            if (error) return error;
            const sectorIndex = Number(args?.sectorIndex);
            const requestId = Number(args?.requestId);
            if (!Number.isInteger(sectorIndex) || !Number.isInteger(requestId)) {
                return err('sectorIndex and requestId must be integers', {}, conn.sessionId);
            }
            conn.input.doorDecision = { sectorIndex, requestId, decision: 'ignore' };
            return ok({ sectorIndex, requestId, decision: 'ignore' }, conn.sessionId);
        },
    );
}
