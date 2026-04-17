/**
 * WebMCP tools for doors.
 *
 * Doors are identified by their sector index. All runtime door state is
 * mirrored into `state.doorState` by the net client. Tools here let an
 * agent enumerate doors, press 'use' to open the door in front of the
 * marine, or — when the local session is possessing a door's security
 * camera — approve/deny pending operator requests.
 *
 * Directly opening an arbitrary door by id is intentionally not exposed:
 * that would be an admin operation (server-protocol change), whereas
 * this interface is strictly input-parity with a human player.
 */

import { state } from '../../game/state.js';
import { pressUse, requestDoorDecision } from '../../net/client.js';

function textContent(obj) {
    return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

function snapshotDoor(entry) {
    const doorEntity = entry.doorEntity;
    const pendingRequests = (doorEntity?.pendingRequests ?? []).map((r) => ({
        id: r.id,
        interactorId: r.interactorId,
        interactorLabel: r.interactorLabel,
        approachSide: r.approachSide,
    }));
    return {
        sectorIndex: entry.sectorIndex,
        open: Boolean(entry.open),
        passable: Boolean(entry.passable),
        keyRequired: entry.keyRequired ?? null,
        operatorSessionId: doorEntity?.__sessionId ?? null,
        camera: doorEntity
            ? { x: doorEntity.x, y: doorEntity.y, z: doorEntity.z, viewAngle: doorEntity.viewAngle ?? 0 }
            : null,
        pendingRequests,
    };
}

export function registerDoorTools() {
    navigator.modelContext.registerTool({
        name: 'doors.list',
        description:
            'List every door tracked on the client (mirrored from the latest server snapshot). Each entry includes the door sectorIndex, open/passable flags, any key requirement, the current operator (if someone is possessing the camera), and any pending operator requests awaiting approval.',
        inputSchema: { type: 'object', properties: {} },
        async execute() {
            const doors = [];
            for (const entry of state.doorState.values()) {
                doors.push(snapshotDoor(entry));
            }
            doors.sort((a, b) => a.sectorIndex - b.sectorIndex);
            return textContent({ count: doors.length, doors });
        },
    });

    navigator.modelContext.registerTool({
        name: 'doors.get-state',
        description: 'Return the latest mirrored state for a single door by its sectorIndex.',
        inputSchema: {
            type: 'object',
            properties: {
                sectorIndex: { type: 'integer' },
            },
            required: ['sectorIndex'],
        },
        async execute(args) {
            const sectorIndex = Number(args?.sectorIndex);
            if (!Number.isInteger(sectorIndex)) {
                return textContent({ ok: false, reason: 'sectorIndex must be an integer' });
            }
            const entry = state.doorState.get(sectorIndex);
            if (!entry) return textContent({ ok: false, reason: 'door not found' });
            return textContent({ ok: true, door: snapshotDoor(entry) });
        },
    });

    navigator.modelContext.registerTool({
        name: 'doors.open-in-front',
        description:
            "Press 'use' (equivalent to pressing space). Opens the door the controlled body is facing, if any are in range. Succeeds asynchronously via the next server snapshot — the return value only confirms the input flag was queued.",
        inputSchema: { type: 'object', properties: {} },
        async execute() {
            pressUse();
            return textContent({ ok: true, queued: 'use' });
        },
    });

    navigator.modelContext.registerTool({
        name: 'doors.approve-request',
        description:
            "Approve a pending door-open request. Only meaningful when the local session is currently possessing the door's security camera; the server ignores decisions from non-operators. Find `requestId` values via doors.list or doors.get-state.",
        inputSchema: {
            type: 'object',
            properties: {
                sectorIndex: { type: 'integer' },
                requestId: { type: 'integer' },
            },
            required: ['sectorIndex', 'requestId'],
        },
        async execute(args) {
            const sectorIndex = Number(args?.sectorIndex);
            const requestId = Number(args?.requestId);
            if (!Number.isInteger(sectorIndex) || !Number.isInteger(requestId)) {
                return textContent({ ok: false, reason: 'sectorIndex and requestId must be integers' });
            }
            requestDoorDecision(sectorIndex, requestId, 'open');
            return textContent({ ok: true, sectorIndex, requestId, decision: 'open' });
        },
    });

    navigator.modelContext.registerTool({
        name: 'doors.deny-request',
        description:
            "Deny a pending door-open request (same 'operator-only' caveat as doors.approve-request).",
        inputSchema: {
            type: 'object',
            properties: {
                sectorIndex: { type: 'integer' },
                requestId: { type: 'integer' },
            },
            required: ['sectorIndex', 'requestId'],
        },
        async execute(args) {
            const sectorIndex = Number(args?.sectorIndex);
            const requestId = Number(args?.requestId);
            if (!Number.isInteger(sectorIndex) || !Number.isInteger(requestId)) {
                return textContent({ ok: false, reason: 'sectorIndex and requestId must be integers' });
            }
            requestDoorDecision(sectorIndex, requestId, 'ignore');
            return textContent({ ok: true, sectorIndex, requestId, decision: 'ignore' });
        },
    });
}
