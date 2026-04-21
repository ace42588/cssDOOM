/**
 * WebMCP tools for driving whatever body the local session controls. Each tool
 * either reads server-replicated state (marine via `getMarine()`, possession pose), or feeds
 * the client's input pipeline (`../input-source.js`). No tool directly mutates
 * authoritative game state; the server sees inputs on the next `sendInputFrame()`.
 */

import { getMarine, state } from '../../game/state.js';
import { ENEMIES } from '../../game/constants.js';
import { pressUse, requestWeaponSwitch, requestBodySwap } from '../../net/client.js';
import {
    setIntent,
    stopIntent,
    nudgeTurnDelta,
    fireForDuration,
    stopFire,
    getControlledPose,
    turnTo,
    moveTo,
} from '../input-source.js';
import { normalizePossessTargetId } from '../../game/entity/id.js';

function textContent(obj) {
    return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

function ok(extra = {}) {
    return textContent({ ok: true, ...extra });
}

function isLiveEnemy(thing) {
    if (!thing) return false;
    if (thing.collected) return false;
    if ((thing.hp ?? 0) <= 0) return false;
    return Boolean(thing.ai) && ENEMIES.has(thing.type);
}

export function registerActorTools() {
    navigator.modelContext.registerTool({
        name: 'actor.get-state',
        description:
            'Return the current pose and stats of the marine plus the pose of whichever body the local session is currently driving (marine or possessed monster/door).',
        inputSchema: { type: 'object', properties: {} },
        async execute() {
            const pose = getControlledPose();
            return textContent({
                marine: {
                    x: getMarine().x,
                    y: getMarine().y,
                    z: getMarine().z,
                    angle: getMarine().viewAngle,
                    health: getMarine().hp,
                    armor: getMarine().armor,
                    armorType: getMarine().armorType,
                    ammo: { ...getMarine().ammo },
                    maxAmmo: { ...getMarine().maxAmmo },
                    currentWeapon: getMarine().currentWeapon,
                    ownedWeapons: [...getMarine().ownedWeapons],
                    collectedKeys: [...getMarine().collectedKeys],
                    powerups: { ...getMarine().powerups },
                    isDead: getMarine().deathMode === 'gameover',
                    isFiring: Boolean(getMarine().isFiring),
                },
                controlled: {
                    kind: pose.kind,
                    x: pose.x,
                    y: pose.y,
                    angle: pose.angle,
                },
            });
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
                if (!isLiveEnemy(thing)) {
                    return textContent({ ok: false, reason: 'enemy not live/possessable from client view' });
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
                if (!isLiveEnemy(thing)) {
                    return textContent({ ok: false, reason: 'enemy not live/possessable from client view' });
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
