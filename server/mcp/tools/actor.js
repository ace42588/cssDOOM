/**
 * MCP tools for driving whatever body the calling session controls.
 *
 * Mirrors `src/mcp/tools/actor.js` (browser WebMCP) but mutates the
 * server-side `conn.input` of the agent's own session. Every tool is
 * input-parity with a human player — no engine state is touched directly,
 * so the same validation, key gates, and AI rules apply.
 *
 * Movement intents (moveX/moveY/turn/run) persist on `conn.input` until
 * overwritten or zeroed. `holdMs` schedules an auto-zero so a short
 * "step forward" pulse doesn't become a runaway input if the agent stops
 * polling. One-shot fields (use, switchWeapon, bodySwap, doorDecision)
 * are consumed once per tick by `processConnectionInputs` in `server/world.js`.
 */

import { z } from 'zod';

import { getMarineActor, state } from '../../../src/game/state.js';
import { getControlledFor } from '../../../src/game/possession.js';
import { getThingIndex } from '../../../src/game/things/registry.js';
import {
    snapshotActor,
    listActors,
    isLiveActor,
} from '../../../src/game/snapshot.js';
import { rolePromptFor } from '../role.js';
import { textResult, ok, err, requireConn } from './_helpers.js';
import { normalizePossessTargetId } from '../../../src/game/entity/id.js';

function clampUnit(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(-1, Math.min(1, n));
}

function clampDuration(ms, max) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.max(0, Math.min(max, n));
}

const moveClearTimers = new Map();
const fireClearTimers = new Map();

function clearMoveTimer(sessionId) {
    const t = moveClearTimers.get(sessionId);
    if (t) {
        clearTimeout(t);
        moveClearTimers.delete(sessionId);
    }
}

function clearFireTimer(sessionId) {
    const t = fireClearTimers.get(sessionId);
    if (t) {
        clearTimeout(t);
        fireClearTimers.delete(sessionId);
    }
}

function zeroMoveIntent(input) {
    input.moveX = 0;
    input.moveY = 0;
    input.turn = 0;
    input.run = false;
}

/**
 * Distance origin for the calling session: the actor it drives, or the
 * marine if the session is a spectator / hasn't been assigned a body.
 * Keeps `distanceToOrigin` meaningful for pure spectators.
 */
function originForSession(sessionId) {
    const controlled = sessionId ? getControlledFor(sessionId) : null;
    const anchor = controlled || getMarineActor();
    if (!anchor) return {};
    return { originX: anchor.x, originY: anchor.y };
}

export function registerActorTools(server, ctx) {
    server.registerTool(
        'actor-get-state',
        {
            title: 'Get actor state',
            description:
                "Return the unified snapshot for a single actor. With no `id`, returns whichever body this session currently controls (null if spectator). Pass `id: 'actor:<slot>'` or `id: 'thing:<idx>'` to inspect any actor on the map. Record shape: { id, type, kind, label, pose, vitals, loadout?, inventory?, ai?, controller, onDeath, attributes, distanceToOrigin }.",
            inputSchema: {
                id: z.string().optional().describe("Optional actor id: 'actor:<slot>' | 'thing:<idx>' | 'marine' | 'player'. Omit for the caller's controlled body."),
            },
        },
        async (args) => {
            const { conn, error } = requireConn(ctx.getSessionId());
            if (error) return error;
            const origin = originForSession(conn.sessionId);
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
                    return err('invalid id (use actor:<slot>, thing:<idx>, marine, or player)', {}, conn.sessionId);
                }
                if (!target) return err('not found', {}, conn.sessionId);
            } else {
                target = getControlledFor(conn.sessionId);
            }
            const actor = target ? snapshotActor(target, origin) : null;
            return textResult({
                actor,
                role: conn.role,
                controlledId: conn.controlledId,
            }, conn.sessionId);
        },
    );

    server.registerTool(
        'actor-list',
        {
            title: 'List actors',
            description:
                "List actors (marine + monsters, live or dead) matching a filter. Filter: { kind?: 'marine'|'enemy'|'any', alive?: boolean, hostile?: boolean, controlled?: boolean, maxDistance?: number, limit?: number }. Each entry is a full actor snapshot record. Sorted by distance from the caller's controlled body (marine if the caller is a spectator). Agents can treat `alive && hostile` entries as current threats; `controlled === true` entries are held by a player session.",
            inputSchema: {
                kind: z.enum(['marine', 'enemy', 'any']).optional(),
                alive: z.boolean().optional(),
                hostile: z.boolean().optional(),
                controlled: z.boolean().optional(),
                maxDistance: z.number().optional(),
                limit: z.number().int().optional(),
            },
        },
        async (args) => {
            const sid = ctx.getSessionId();
            const filter = {
                ...originForSession(sid),
                ...(args?.kind ? { kind: args.kind } : {}),
                ...(args?.alive !== undefined ? { alive: args.alive } : {}),
                ...(args?.hostile !== undefined ? { hostile: args.hostile } : {}),
                ...(args?.controlled !== undefined ? { controlled: args.controlled } : {}),
                ...(Number.isFinite(args?.maxDistance) ? { maxDistance: Number(args.maxDistance) } : {}),
                ...(Number.isInteger(args?.limit) && args.limit > 0 ? { limit: args.limit } : {}),
            };
            const actors = listActors(filter);
            return textResult({ count: actors.length, actors }, sid);
        },
    );

    server.registerTool(
        'actor-set-move',
        {
            title: 'Set move intent',
            description:
                'Set the per-tick movement intent for the controlled body. Fields are clamped to [-1, 1]. holdMs > 0 auto-zeros the intent after that many ms (max 5000) so a pulse cannot stick if the agent stops polling.',
            inputSchema: {
                moveX: z.number().optional().describe('Strafe (-1 left, 1 right).'),
                moveY: z.number().optional().describe('Forward/backward (1 forward, -1 backward).'),
                turn: z.number().optional().describe('Rate-based yaw (-1 left, 1 right).'),
                run: z.boolean().optional().describe('Hold the run modifier.'),
                holdMs: z.number().optional().describe('Auto-clear after this many ms (max 5000). 0 = until next call.'),
            },
        },
        async (args) => {
            const { conn, error } = requireConn(ctx.getSessionId());
            if (error) return error;
            const a = args || {};
            conn.input.moveX = clampUnit(a.moveX ?? 0);
            conn.input.moveY = clampUnit(a.moveY ?? 0);
            conn.input.turn = clampUnit(a.turn ?? 0);
            conn.input.run = Boolean(a.run);
            clearMoveTimer(conn.sessionId);
            const hold = clampDuration(a.holdMs, 5000);
            if (hold > 0) {
                const sid = conn.sessionId;
                const timer = setTimeout(() => {
                    moveClearTimers.delete(sid);
                    if (conn.input) zeroMoveIntent(conn.input);
                }, hold);
                moveClearTimers.set(sid, timer);
            }
            return ok({ applied: { moveX: conn.input.moveX, moveY: conn.input.moveY, turn: conn.input.turn, run: conn.input.run } }, conn.sessionId);
        },
    );

    server.registerTool(
        'actor-stop',
        {
            title: 'Stop movement',
            description: 'Zero all rate-based movement and turn intent. Does not release fire (use actor-stop-fire for that).',
            inputSchema: {},
        },
        async () => {
            const { conn, error } = requireConn(ctx.getSessionId());
            if (error) return error;
            zeroMoveIntent(conn.input);
            clearMoveTimer(conn.sessionId);
            return ok({}, conn.sessionId);
        },
    );

    server.registerTool(
        'actor-turn-by',
        {
            title: 'Apply yaw delta',
            description:
                'Apply an absolute yaw delta (radians) on the next tick. Positive = counter-clockwise (left). Angle convention: 0 = north. turnDelta is one-shot and consumed every tick. Pose angles returned by actor-get-state / world snapshots are normalized to [-π, π].',
            inputSchema: {
                radians: z.number().describe('Delta yaw in radians.'),
            },
        },
        async (args) => {
            const { conn, error } = requireConn(ctx.getSessionId());
            if (error) return error;
            const radians = Number(args?.radians);
            if (!Number.isFinite(radians)) return err('radians must be a number', {}, conn.sessionId);
            conn.input.turnDelta = (Number(conn.input.turnDelta) || 0) + radians;
            return ok({ radians }, conn.sessionId);
        },
    );

    server.registerTool(
        'actor-fire',
        {
            title: 'Fire weapon',
            description:
                "Press and hold the fire button. If durationMs > 0, fire auto-releases after that duration (max 10000 ms). Fire routes to the controlled body's current weapon/attack — marine weapons when possessing the marine, the monster's intrinsic attack when possessing an enemy.",
            inputSchema: {
                durationMs: z.number().optional().describe('Hold for this many ms (0 = until actor-stop-fire).'),
            },
        },
        async (args) => {
            const { conn, error } = requireConn(ctx.getSessionId());
            if (error) return error;
            conn.input.fireHeld = true;
            clearFireTimer(conn.sessionId);
            const hold = clampDuration(args?.durationMs, 10000);
            if (hold > 0) {
                const sid = conn.sessionId;
                const timer = setTimeout(() => {
                    fireClearTimers.delete(sid);
                    if (conn.input) conn.input.fireHeld = false;
                }, hold);
                fireClearTimers.set(sid, timer);
            }
            return ok({ holdMs: hold }, conn.sessionId);
        },
    );

    server.registerTool(
        'actor-stop-fire',
        {
            title: 'Release fire',
            description: 'Release the fire button.',
            inputSchema: {},
        },
        async () => {
            const { conn, error } = requireConn(ctx.getSessionId());
            if (error) return error;
            conn.input.fireHeld = false;
            clearFireTimer(conn.sessionId);
            return ok({}, conn.sessionId);
        },
    );

    server.registerTool(
        'actor-use',
        {
            title: 'Press use',
            description:
                "Press 'use' (spacebar). Edge-triggered: opens the door the controlled body is facing, hits switches, triggers linedef specials at short range. Consumed once per call.",
            inputSchema: {},
        },
        async () => {
            const { conn, error } = requireConn(ctx.getSessionId());
            if (error) return error;
            conn.input.use = true;
            return ok({}, conn.sessionId);
        },
    );

    server.registerTool(
        'actor-switch-weapon',
        {
            title: 'Switch weapon',
            description:
                "Request the server switch the controlled body to the given weapon slot. Slots 1-7 are the marine arsenal (1=Fist, 2=Pistol, 3=Shotgun, 4=Chaingun, 5=Rocket, 6=Plasma, 7=BFG). Server only honors slots the actor owns; most monster bodies only own one intrinsic slot and ignore this.",
            inputSchema: {
                slot: z.number().int().min(1).max(7).describe('Weapon slot.'),
            },
        },
        async (args) => {
            const { conn, error } = requireConn(ctx.getSessionId());
            if (error) return error;
            const slot = Number(args?.slot);
            if (!Number.isInteger(slot) || slot < 1 || slot > 9) return err('slot must be an integer 1..9', {}, conn.sessionId);
            conn.input.switchWeapon = Math.max(1, Math.min(9, slot));
            return ok({ slot: conn.input.switchWeapon }, conn.sessionId);
        },
    );

    server.registerTool(
        'actor-possess',
        {
            title: 'Possess body',
            description:
                "Queue a body-swap for the next tick. targetId: `actor:<slot>` (any actor — marine slot 0 or spawned monsters), `thing:<idx>` (legacy thing-only hostile), `door:<sectorIndex>`, or `marine`/`player` as a shorthand for the marine. Server validates targets; rejected swaps are dropped silently on the tick. Subsequent actor-* tools drive the possessed body.",
            inputSchema: {
                targetId: z.string().describe('actor:<slot> | thing:<idx> | door:<sectorIndex> | marine | player'),
            },
        },
        async (args) => {
            const { conn, error } = requireConn(ctx.getSessionId());
            if (error) return error;
            const parsed = normalizePossessTargetId(args?.targetId);
            if (!parsed) return err('invalid targetId (use actor:<slot>, thing:<idx>, door:<sectorIndex>, marine, or player)', {}, conn.sessionId);

            if (parsed.bodySwap === 'actor:0' || parsed.bodySwap === 'player') {
                conn.input.bodySwap = { targetId: 'actor:0' };
                const role = rolePromptFor(getMarineActor());
                return ok({ requested: parsed.requested, role }, conn.sessionId);
            }

            if (parsed.bodySwap.startsWith('actor:')) {
                const id = Number(parsed.bodySwap.slice('actor:'.length));
                if (!Number.isInteger(id) || id <= 0) return err('invalid actor index', {}, conn.sessionId);
                const thing = state.actors[id];
                if (!thing) return err('not found', {}, conn.sessionId);
                if (!isLiveActor(thing)) return err('actor not possessable (dead, collected, or non-AI)', {}, conn.sessionId);
                conn.input.bodySwap = { targetId: `actor:${id}` };
                const role = rolePromptFor(thing);
                return ok({ requested: `actor:${id}`, role }, conn.sessionId);
            }

            if (parsed.bodySwap.startsWith('thing:')) {
                const id = Number(parsed.bodySwap.slice('thing:'.length));
                if (!Number.isInteger(id) || id < 0) return err('invalid thing index', {}, conn.sessionId);
                const thing = state.things[id];
                if (!thing) return err('not found', {}, conn.sessionId);
                if (!isLiveActor(thing)) return err('actor not possessable (dead, collected, or non-AI)', {}, conn.sessionId);
                const idx = getThingIndex(thing);
                if (idx < 0) return err('thing has no stable index', {}, conn.sessionId);
                conn.input.bodySwap = { targetId: `thing:${idx}` };
                const role = rolePromptFor(thing);
                return ok({ requested: `thing:${idx}`, role }, conn.sessionId);
            }

            const sectorIndex = Number(parsed.bodySwap.slice('door:'.length));
            if (!Number.isInteger(sectorIndex)) return err('invalid door sector index', {}, conn.sessionId);
            const entry = state.doorState.get(sectorIndex);
            if (!entry || !entry.doorEntity) return err('door not found', {}, conn.sessionId);
            conn.input.bodySwap = { targetId: `door:${sectorIndex}` };
            const role = rolePromptFor(entry.doorEntity);
            return ok({ requested: `door:${sectorIndex}`, role }, conn.sessionId);
        },
    );
}

/** Cleanup hook used by sessions.js when an MCP session closes. */
export function disposeActorSession(sessionId) {
    clearMoveTimer(sessionId);
    clearFireTimer(sessionId);
}
