/**
 * WebMCP tools for driving the marine (or whichever body the local session
 * currently controls). Each tool either:
 *   - reads server-replicated state (`player`, possession pose), or
 *   - feeds the client's input pipeline (the MCP input provider in
 *     `../input-source.js`, or the same helpers used by keyboard/mouse).
 *
 * No tool directly mutates game state; the authoritative server sees these
 * inputs on the normal WebSocket channel at the next `sendInputFrame()`.
 */

import { player } from '../../game/state.js';
import { pressUse, requestWeaponSwitch } from '../../net/client.js';
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

function textContent(obj) {
    return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

function ok(extra = {}) {
    return textContent({ ok: true, ...extra });
}

export function registerMarineTools() {
    navigator.modelContext.registerTool({
        name: 'marine.get-state',
        description:
            'Return the current pose and stats of the marine plus the pose of whichever body the local session is currently driving (marine or possessed monster/door).',
        inputSchema: { type: 'object', properties: {} },
        async execute() {
            const pose = getControlledPose();
            return textContent({
                marine: {
                    x: player.x,
                    y: player.y,
                    z: player.z,
                    angle: player.angle,
                    health: player.health,
                    armor: player.armor,
                    armorType: player.armorType,
                    ammo: { ...player.ammo },
                    maxAmmo: { ...player.maxAmmo },
                    currentWeapon: player.currentWeapon,
                    ownedWeapons: [...player.ownedWeapons],
                    collectedKeys: [...player.collectedKeys],
                    powerups: { ...player.powerups },
                    isDead: Boolean(player.isDead),
                    isFiring: Boolean(player.isFiring),
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
        name: 'marine.set-move',
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
        name: 'marine.stop',
        description: 'Zero all rate-based movement and turn intent. Does not release fire.',
        inputSchema: { type: 'object', properties: {} },
        async execute() {
            stopIntent();
            return ok();
        },
    });

    navigator.modelContext.registerTool({
        name: 'marine.turn-by',
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
        name: 'marine.turn-to',
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
        name: 'marine.move-to',
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
        name: 'marine.fire',
        description:
            'Press and hold the fire button. If durationMs > 0 is given, fire auto-releases after that duration (max 10000 ms); otherwise call marine.stop-fire.',
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
        name: 'marine.stop-fire',
        description: 'Release the fire button.',
        inputSchema: { type: 'object', properties: {} },
        async execute() {
            stopFire();
            return ok();
        },
    });

    navigator.modelContext.registerTool({
        name: 'marine.switch-weapon',
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
        name: 'marine.use',
        description:
            "Press 'use' (spacebar). Opens the door the marine is facing, activates switches, and triggers linedef specials at short range.",
        inputSchema: { type: 'object', properties: {} },
        async execute() {
            pressUse();
            return ok();
        },
    });
}
