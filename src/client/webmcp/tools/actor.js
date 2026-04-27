/**
 * WebMCP tools for driving whatever body the local session controls.
 *
 * Mirrors `server/mcp/tools/actor.js` (same tool names, identical record
 * shapes) but operates on the client side: reads the server-replicated
 * actor state through the shared `src/engine/snapshot.js` helper, and
 * pushes inputs through `../input-source.js` + `src/client/net/client.js`.
 * No tool directly mutates authoritative game state; the server sees
 * inputs on the next `sendInputFrame()`.
 */

import { getControlled } from '../../../engine/possession.js';
import { state, getMarineActor } from '../../../engine/state.js';
import { snapshotActor, listActors, isLiveActor } from '../../../engine/snapshot.js';
import { pressUse, requestWeaponSwitch, requestBodySwap } from '../../net/client.js';
import {
    setIntent,
    stopIntent,
    nudgeTurnDelta,
    fireForDuration,
    stopFire,
    turnTo,
    moveTo,
} from '../input-source.js';
import { normalizePossessTargetId } from '../../../engine/actors/ids.js';

function textContent(obj) {
    return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

function ok(extra = {}) {
    return textContent({ ok: true, ...extra });
}

/**
 * Distance origin for the local session: the actor it drives, or the
 * marine if the local session is a spectator / pre-assignment. Keeps
 * `distanceToOrigin` meaningful even without a controlled body.
 */
function originForLocalSession() {
    const anchor = getControlled() || getMarineActor();
    if (!anchor) return {};
    return { originX: anchor.x, originY: anchor.y };
}

export function registerActorTools() {
    navigator.modelContext.registerTool({
        name: 'actor.get-state',
        description:
            "Return the unified actor snapshot for a single actor. With no `id`, returns whichever body the local session currently controls (null when spectating). Pass `id: 'actor:<slot>'` or `id: 'thing:<idx>'` to inspect any actor on the map. Record matches the server `actor-get-state` shape: { id, type, kind, label, pose, vitals, loadout?, inventory?, ai?, controller, onDeath, attributes, distanceToOrigin }.",
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: "Optional: 'actor:<slot>' | 'thing:<idx>' | 'marine' | 'player'." },
            },
        },
        async execute(args) {
            const rawId = args?.id;
            let target = null;
            if (typeof rawId === 'string' && rawId.length > 0) {
                const lower = rawId.toLowerCase();
                if (lower === 'marine' || lower === 'player') {
                    target = getMarineActor();
                } else if (rawId.startsWith('actor:')) {
                    target = state.actors[Number(rawId.slice('actor:'.length))] || null;
                } else if (rawId.startsWith('thing:')) {
                    target = state.things[Number(rawId.slice('thing:'.length))] || null;
                } else {
                    return textContent({ ok: false, reason: 'invalid id (use actor:<slot>, thing:<idx>, marine, or player)' });
                }
            } else {
                target = getControlled();
            }
            const actor = target ? snapshotActor(target, originForLocalSession()) : null;
            return textContent({ actor });
        },
    });

    navigator.modelContext.registerTool({
        name: 'actor.list',
        description:
            "List actors matching an optional filter. Filter fields: { kind?: 'marine'|'enemy'|'any', alive?: boolean, hostile?: boolean, controlled?: boolean, maxDistance?: number, limit?: number }. Mirrors `actor-list` server-side. Records are the same unified actor shape returned by `actor.get-state`. Sorted by distance from the local session's controlled body (marine fallback for spectators).",
        inputSchema: {
            type: 'object',
            properties: {
                kind: { type: 'string', enum: ['marine', 'enemy', 'any'] },
                alive: { type: 'boolean' },
                hostile: { type: 'boolean' },
                controlled: { type: 'boolean' },
                maxDistance: { type: 'number' },
                limit: { type: 'integer' },
            },
        },
        async execute(args) {
            const filter = {
                ...originForLocalSession(),
                ...(args?.kind ? { kind: args.kind } : {}),
                ...(args?.alive !== undefined ? { alive: args.alive } : {}),
                ...(args?.hostile !== undefined ? { hostile: args.hostile } : {}),
                ...(args?.controlled !== undefined ? { controlled: args.controlled } : {}),
                ...(Number.isFinite(args?.maxDistance) ? { maxDistance: Number(args.maxDistance) } : {}),
                ...(Number.isInteger(args?.limit) && args.limit > 0 ? { limit: args.limit } : {}),
            };
            const actors = listActors(filter);
            return textContent({ count: actors.length, actors });
        },
    });

    navigator.modelContext.registerTool({
        name: 'actor.set-move',
        description:
            'Set the per-frame movement intent for the controlled body. Fields are clamped to [-1, 1]. Pass holdMs > 0 to auto-clear after that duration (max 5000 ms) so short pulses do not stick.',
        inputSchema: {
            type: 'object',
            properties: {
                moveX: { type: 'number', description: 'Strafe (-1 left, 1 right).' },
                moveY: { type: 'number', description: 'Forward/backward (1 forward, -1 backward).' },
                turn: { type: 'number', description: 'Rate-based yaw (-1 left, 1 right).' },
                run: { type: 'boolean', description: 'Hold the run modifier.' },
                holdMs: { type: 'number', description: 'How long to hold the intent in ms (max 5000). 0 or omitted = until next call.' },
            },
        },
        async execute(args) {
            setIntent(args || {});
            return ok();
        },
    });

    navigator.modelContext.registerTool({
        name: 'actor.stop',
        description: 'Zero all rate-based movement and turn intent. Does not release fire.',
        inputSchema: { type: 'object', properties: {} },
        async execute() {
            stopIntent();
            return ok();
        },
    });

    navigator.modelContext.registerTool({
        name: 'actor.turn-by',
        description:
            'Apply an absolute yaw delta (radians) on the next frame. Positive = counter-clockwise (left). Angle convention: 0 = north.',
        inputSchema: {
            type: 'object',
            properties: {
                radians: { type: 'number', description: 'Delta yaw in radians.' },
            },
            required: ['radians'],
        },
        async execute(args) {
            const radians = Number(args?.radians);
            if (!Number.isFinite(radians)) {
                return textContent({ ok: false, reason: 'radians must be a number' });
            }
            nudgeTurnDelta(radians);
            return ok({ radians });
        },
    });

    navigator.modelContext.registerTool({
        name: 'actor.turn-to',
        description:
            'Rotate the controlled body to face the given absolute angle (radians, 0 = north) OR to look at the given (x, y) point. Returns when aligned within tolerance or after timeoutMs.',
        inputSchema: {
            type: 'object',
            properties: {
                angle: { type: 'number', description: 'Target angle in radians (ignored if x/y given).' },
                x: { type: 'number', description: 'Target X to face (requires y).' },
                y: { type: 'number', description: 'Target Y to face (requires x).' },
                tolerance: { type: 'number', description: 'Radians of slack before returning (default 0.05).' },
                timeoutMs: { type: 'number', description: 'Give up after this many ms (default 5000, max 15000).' },
            },
        },
        async execute(args) {
            const result = await turnTo(args || {});
            return textContent(result);
        },
    });

    navigator.modelContext.registerTool({
        name: 'actor.move-to',
        description:
            'Walk the controlled body in a straight line toward (x, y). Turns toward the target and walks forward each frame; no pathfinding, so walls cause a stuck/timeout return.',
        inputSchema: {
            type: 'object',
            properties: {
                x: { type: 'number' },
                y: { type: 'number' },
                run: { type: 'boolean', description: 'Hold the run modifier while moving.' },
                tolerance: { type: 'number', description: 'Arrival distance in map units (default 32).' },
                timeoutMs: { type: 'number', description: 'Give up after this many ms (default 5000, max 15000).' },
            },
            required: ['x', 'y'],
        },
        async execute(args) {
            const result = await moveTo(args || {});
            return textContent(result);
        },
    });

    navigator.modelContext.registerTool({
        name: 'actor.fire',
        description:
            'Press and hold the fire button. If durationMs > 0 is given, fire auto-releases after that duration (max 10000 ms); otherwise call actor.stop-fire.',
        inputSchema: {
            type: 'object',
            properties: {
                durationMs: { type: 'number', description: 'How long to hold fire in ms (0 = until stop-fire).' },
            },
        },
        async execute(args) {
            fireForDuration(args?.durationMs ?? 0);
            return ok();
        },
    });

    navigator.modelContext.registerTool({
        name: 'actor.stop-fire',
        description: 'Release the fire button.',
        inputSchema: { type: 'object', properties: {} },
        async execute() {
            stopFire();
            return ok();
        },
    });

    navigator.modelContext.registerTool({
        name: 'actor.switch-weapon',
        description:
            'Request that the server switch the marine to the given weapon slot (1=Fist, 2=Pistol, 3=Shotgun, 4=Chaingun, 5=Rocket, 6=Plasma, 7=BFG). Server only honors slots the marine owns.',
        inputSchema: {
            type: 'object',
            properties: {
                slot: { type: 'integer', minimum: 1, maximum: 7 },
            },
            required: ['slot'],
        },
        async execute(args) {
            const slot = Number(args?.slot);
            if (!Number.isInteger(slot) || slot < 1 || slot > 7) {
                return textContent({ ok: false, reason: 'slot must be an integer 1..7' });
            }
            requestWeaponSwitch(slot);
            return ok({ slot });
        },
    });

    navigator.modelContext.registerTool({
        name: 'actor.use',
        description:
            "Press 'use' (spacebar). Opens the door the controlled body is facing, activates switches, and triggers linedef specials at short range.",
        inputSchema: { type: 'object', properties: {} },
        async execute() {
            pressUse();
            return ok();
        },
    });

    navigator.modelContext.registerTool({
        name: 'actor.possess',
        description:
            'Queue a body-swap for the next frame. targetId: thing:N (enemy id from enemies.list), door:N (sectorIndex from doors.list), or marine / player for the marine. Server validates on the tick.',
        inputSchema: {
            type: 'object',
            properties: {
                targetId: { type: 'string', description: 'thing:N | door:N | marine | player' },
            },
            required: ['targetId'],
        },
        async execute(args) {
            const parsed = normalizePossessTargetId(args?.targetId);
            const tid = parsed?.bodySwap ?? null;
            if (!tid) return textContent({ ok: false, reason: 'invalid targetId' });
            if (tid === 'actor:0' || tid === 'player') {
                requestBodySwap('actor:0');
                return ok({ requested: tid });
            }
            if (tid.startsWith('actor:')) {
                const id = Number(tid.slice('actor:'.length));
                if (!Number.isInteger(id) || id <= 0) {
                    return textContent({ ok: false, reason: 'invalid actor index' });
                }
                const thing = state.actors[id];
                if (!thing) return textContent({ ok: false, reason: 'not found' });
                if (!isLiveActor(thing)) {
                    return textContent({ ok: false, reason: 'actor not possessable (dead, collected, or non-AI)' });
                }
                requestBodySwap(tid);
                return ok({ requested: tid });
            }
            if (tid.startsWith('thing:')) {
                const id = Number(tid.slice('thing:'.length));
                if (!Number.isInteger(id) || id < 0) {
                    return textContent({ ok: false, reason: 'invalid thing index' });
                }
                const thing = state.things[id];
                if (!thing) return textContent({ ok: false, reason: 'not found' });
                if (!isLiveActor(thing)) {
                    return textContent({ ok: false, reason: 'actor not possessable (dead, collected, or non-AI)' });
                }
                requestBodySwap(tid);
                return ok({ requested: tid });
            }
            const sectorIndex = Number(tid.slice('door:'.length));
            if (!Number.isInteger(sectorIndex)) {
                return textContent({ ok: false, reason: 'invalid door sector index' });
            }
            const entry = state.doorState.get(sectorIndex);
            if (!entry || !entry.doorEntity) {
                return textContent({ ok: false, reason: 'door not found' });
            }
            requestBodySwap(tid);
            return ok({ requested: tid });
        },
    });
}
