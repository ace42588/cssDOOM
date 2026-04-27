/**
 * MCP input source.
 *
 * Registers a single `collectInput` provider so WebMCP tools can contribute
 * to the per-frame input snapshot that `sendInputFrame()` forwards to the
 * authoritative server. Tools never mutate game state directly; they adjust
 * the fields below, and the server sees them as just another input stream
 * on par with the keyboard, mouse, touch, or gamepad modules.
 *
 * Two layers:
 *   1. Low-level intent: tools set `moveX/moveY/turn/run` with an optional
 *      auto-expiry so a pulse of movement clears itself even if the agent
 *      forgets to call `actor.stop` (WebMCP) / `actor-stop` (HTTP MCP).
 *   2. High-level steering: `turnTo` / `moveTo` drive the low-level state
 *      across successive animation frames until the goal is reached or a
 *      timeout elapses.
 *
 * `fireHeld` is written directly to the unified `input` object (same path
 * the keyboard/mouse use), because `collectInput` does not merge it from
 * providers.
 */

import { registerInputProvider, input } from '../input/index.js';
import { getMarineActor } from '../game/state.js';

const marine = () => getMarineActor();
import { getControlledFor, LOCAL_SESSION } from '../game/possession.js';

const intent = {
    moveX: 0,
    moveY: 0,
    turn: 0,
    turnDelta: 0,
    run: false,
    holdUntil: 0,
};

let initialized = false;
let fireClearTimer = null;

function now() {
    return (typeof performance !== 'undefined' ? performance.now() : Date.now());
}

function clampUnit(v) {
    if (!Number.isFinite(v)) return 0;
    return Math.max(-1, Math.min(1, v));
}

function clampDuration(ms, fallback, max) {
    if (!Number.isFinite(ms)) return fallback;
    return Math.max(0, Math.min(max, ms));
}

/**
 * Install the MCP input provider. Idempotent; safe to call from module init.
 */
export function initMcpInputSource() {
    if (initialized) return;
    initialized = true;

    registerInputProvider(() => {
        if (intent.holdUntil && now() >= intent.holdUntil) {
            intent.moveX = 0;
            intent.moveY = 0;
            intent.turn = 0;
            intent.run = false;
            intent.holdUntil = 0;
        }
        const contribution = {
            moveX: intent.moveX,
            moveY: intent.moveY,
            turn: intent.turn,
            turnDelta: intent.turnDelta,
            run: intent.run,
        };
        // turnDelta is a one-shot absolute yaw bump — consume each frame.
        intent.turnDelta = 0;
        return contribution;
    });
}

// ── Low-level intent ────────────────────────────────────────────────────

/**
 * Replace the per-frame intent. `holdMs` > 0 auto-clears the intent so a
 * short "walk forward 500 ms" pulse doesn't become a runaway input.
 */
export function setIntent({ moveX, moveY, turn, run, holdMs } = {}) {
    intent.moveX = clampUnit(moveX ?? 0);
    intent.moveY = clampUnit(moveY ?? 0);
    intent.turn = clampUnit(turn ?? 0);
    intent.run = Boolean(run);
    const hold = clampDuration(holdMs ?? 0, 0, 5000);
    intent.holdUntil = hold > 0 ? now() + hold : 0;
}

/** Zero all rate-based intent. Does not touch `fireHeld`. */
export function stopIntent() {
    intent.moveX = 0;
    intent.moveY = 0;
    intent.turn = 0;
    intent.run = false;
    intent.holdUntil = 0;
}

/** Add an absolute yaw bump applied on the next frame. */
export function nudgeTurnDelta(radians) {
    if (!Number.isFinite(radians)) return;
    intent.turnDelta += radians;
}

/** Hold fire. If `durationMs > 0`, auto-release after that long. */
export function fireForDuration(durationMs) {
    input.fireHeld = true;
    if (fireClearTimer) {
        clearTimeout(fireClearTimer);
        fireClearTimer = null;
    }
    const hold = clampDuration(durationMs ?? 0, 0, 10000);
    if (hold > 0) {
        fireClearTimer = setTimeout(() => {
            input.fireHeld = false;
            fireClearTimer = null;
        }, hold);
    }
}

/** Release fire. */
export function stopFire() {
    input.fireHeld = false;
    if (fireClearTimer) {
        clearTimeout(fireClearTimer);
        fireClearTimer = null;
    }
}

// ── Pose readout ────────────────────────────────────────────────────────

/**
 * Pose of whatever body the local session currently drives (marine, possessed
 * monster, or door camera). Angle is in the player convention (0 = north,
 * CCW positive), matching `updateLocation()` in movement/system.js.
 */
export function getControlledPose() {
    const entity = getControlledFor(LOCAL_SESSION) || marine();
    if (entity === marine()) {
        const m = marine();
        return { entity, x: m.x, y: m.y, angle: m.viewAngle, kind: 'marine' };
    }
    if (entity.__isDoorEntity) {
        return { entity, x: entity.x, y: entity.y, angle: entity.viewAngle ?? 0, kind: 'door' };
    }
    const angle = typeof entity.viewAngle === 'number'
        ? entity.viewAngle
        : ((entity.facing ?? 0) - Math.PI / 2);
    return { entity, x: entity.x, y: entity.y, angle, kind: 'enemy' };
}

// ── Steering ────────────────────────────────────────────────────────────

const TURN_TOLERANCE_RAD = 0.05;      // ~2.9°
const MOVE_TOLERANCE_UNITS = 32;      // DOOM map units
const DEFAULT_STEER_TIMEOUT_MS = 5000;
const MAX_STEER_TIMEOUT_MS = 15000;
const MAX_TURN_PER_FRAME_RAD = 0.25;  // ~14°/frame (clamps huge corrections)

function normalizeAngle(a) {
    const TAU = Math.PI * 2;
    return ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
}

/**
 * Bearing from (x,y) toward (tx,ty) in the player angle convention where
 * forward = (-sin(angle), cos(angle)).
 */
function bearingTo(x, y, tx, ty) {
    return Math.atan2(x - tx, ty - y);
}

function awaitFrame() {
    return new Promise((resolve) => {
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => resolve());
        } else {
            setTimeout(resolve, 16);
        }
    });
}

/**
 * Rotate the controlled body until it faces the given angle or the given
 * point. Returns { ok, finalAngle, reason? }.
 */
export async function turnTo({ angle, x, y, tolerance = TURN_TOLERANCE_RAD, timeoutMs = DEFAULT_STEER_TIMEOUT_MS } = {}) {
    const deadline = now() + clampDuration(timeoutMs, DEFAULT_STEER_TIMEOUT_MS, MAX_STEER_TIMEOUT_MS);
    while (now() < deadline) {
        const pose = getControlledPose();
        const target = typeof angle === 'number'
            ? angle
            : bearingTo(pose.x, pose.y, x, y);
        const diff = normalizeAngle(target - pose.angle);
        if (Math.abs(diff) <= tolerance) {
            intent.turn = 0;
            return { ok: true, finalAngle: pose.angle };
        }
        const step = Math.sign(diff) * Math.min(Math.abs(diff), MAX_TURN_PER_FRAME_RAD);
        intent.turnDelta += step;
        await awaitFrame();
    }
    const pose = getControlledPose();
    return { ok: false, reason: 'timeout', finalAngle: pose.angle };
}

/**
 * Straight-line movement toward (x, y). Turns toward the target each frame
 * and walks forward when roughly aligned. No pathfinding: walls will stop
 * progress and cause a timeout return.
 */
export async function moveTo({
    x,
    y,
    run = false,
    tolerance = MOVE_TOLERANCE_UNITS,
    timeoutMs = DEFAULT_STEER_TIMEOUT_MS,
} = {}) {
    const deadline = now() + clampDuration(timeoutMs, DEFAULT_STEER_TIMEOUT_MS, MAX_STEER_TIMEOUT_MS);
    let lastDist = Infinity;
    let stuckTicks = 0;

    while (now() < deadline) {
        const pose = getControlledPose();
        const dx = x - pose.x;
        const dy = y - pose.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= tolerance) {
            stopIntent();
            return { ok: true, distanceRemaining: dist };
        }

        const target = bearingTo(pose.x, pose.y, x, y);
        const diff = normalizeAngle(target - pose.angle);

        const turnStep = Math.sign(diff) * Math.min(Math.abs(diff), MAX_TURN_PER_FRAME_RAD);
        intent.turnDelta += turnStep;

        const aligned = Math.abs(diff) < Math.PI / 3;
        intent.moveX = 0;
        intent.moveY = aligned ? 1 : 0.25;
        intent.turn = 0;
        intent.run = Boolean(run);
        intent.holdUntil = now() + 200; // keep refreshing; provider auto-clears if we stop

        if (dist > lastDist - 0.5) stuckTicks += 1; else stuckTicks = 0;
        lastDist = dist;
        if (stuckTicks > 45) {
            stopIntent();
            return { ok: false, reason: 'stuck', distanceRemaining: dist };
        }

        await awaitFrame();
    }
    stopIntent();
    const pose = getControlledPose();
    const dx = x - pose.x;
    const dy = y - pose.y;
    return { ok: false, reason: 'timeout', distanceRemaining: Math.hypot(dx, dy) };
}
