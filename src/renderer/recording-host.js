/**
 * Recording renderer host — buffers every renderer call into a list of
 * `{ fn, args, forSessionId? }` events (`forSessionId` limits replay to one client). Used by the server to ship transient visuals
 * (puffs, explosions, hud messages, door/lift/crusher state changes,
 * weapon switches, sprite state transitions) alongside each snapshot.
 *
 * Clients receive the events inside a snapshot and replay them through the
 * real DOM host, preserving the visual feel of the single-player engine
 * without the server ever touching a DOM.
 *
 * Only a subset of the facade API produces visible transients — the rest
 * (e.g. `updateCamera`, `updateHud`, `updateCulling`, `startCullingLoop`,
 * `updateThingPosition`, `updateEnemyRotation`) is either derivable from
 * the snapshot itself or is purely a rendering loop concern on the client.
 * Those calls are accepted but dropped.
 */

// Renderer calls the client **should** replay on every snapshot.
const RECORDED = new Set([
    // HUD messages (access denials, pickup notifications)
    'showHudMessage',
    'clearWeaponSlots',
    // Effects
    'triggerFlash',
    'showPowerup', 'flickerPowerup', 'hidePowerup',
    // Sprite state / death / respawn (animation triggers, not position)
    'setEnemyState',
    'resetEnemy',
    'killEnemy',
    'collectItem',
    // One-shot visual effects
    'createPuff',
    'createExplosion',
    'createTeleportFog',
    'createProjectile',
    'removeProjectile',
    // Player visuals
    'setPlayerDead',
    'setPlayerMoving',
    'collectKey',
    'clearKeys',
    // Weapons
    'switchWeapon',
    'startFiring',
    'stopFiring',
    // Structural state changes (door/lift/crusher/switch)
    'setDoorState',
    'setLiftState',
    'setCrusherOffset',
    'toggleSwitchState',
    'lowerTaggedFloor',
]);

/**
 * Deep-clone values we expect to pass over the wire. Only handles the shapes
 * the renderer facade actually receives (primitives, plain objects, small
 * arrays, Sets/Maps of primitives). Complex / circular inputs are dropped.
 */
function sanitizeArg(value, depth = 0) {
    if (value === null || value === undefined) return value;
    const type = typeof value;
    if (type === 'number' || type === 'string' || type === 'boolean') return value;
    if (depth > 3) return undefined;
    if (Array.isArray(value)) return value.map((v) => sanitizeArg(v, depth + 1));
    if (type === 'object') {
        const out = {};
        for (const key of Object.keys(value)) {
            const v = value[key];
            const vt = typeof v;
            if (vt === 'function' || vt === 'symbol') continue;
            out[key] = sanitizeArg(v, depth + 1);
        }
        return out;
    }
    return undefined;
}

/**
 * Create a recording renderer host.
 *
 * Returns an object with:
 *   - all recorded facade methods (each appends `{fn, args}` to a buffer)
 *   - no-op stubs for non-recorded facade methods
 *   - `drainEvents()` — returns and clears the current buffer
 *   - `discardEvents()` — clears the buffer without returning
 */
export function createRecordingRendererHost() {
    /** @type {Array<{fn: string, args: any[]}>} */
    let buffer = [];

    const record = (fn) => (...args) => {
        buffer.push({ fn, args: args.map((a) => sanitizeArg(a)) });
    };

    const host = {
        // Always-on queries
        isWeaponSwitching: () => false,

        drainEvents() {
            if (buffer.length === 0) return [];
            const out = buffer;
            buffer = [];
            return out;
        },

        discardEvents() {
            buffer = [];
        },
    };

    for (const fn of RECORDED) {
        host[fn] = record(fn);
    }

    // First-person marine feedback — only the session driving `player` should
    // replay these (see `src/net/client.js` snapshot replay filtering).
    host.triggerViewerFlash = (className, forSessionId, duration = 300) => {
        buffer.push({
            fn: 'triggerFlash',
            args: [sanitizeArg(className), sanitizeArg(duration)],
            forSessionId: typeof forSessionId === 'string' ? forSessionId : undefined,
        });
    };
    host.setViewerPlayerDead = (dead, forSessionId) => {
        buffer.push({
            fn: 'setPlayerDead',
            args: [sanitizeArg(dead)],
            forSessionId: typeof forSessionId === 'string' ? forSessionId : undefined,
        });
    };

    // Accept-and-drop the per-frame client-local facade calls. We don't
    // record them (snapshots already carry the necessary state) but we do
    // want the host to satisfy the facade shape so nothing throws.
    const dropped = [
        'updateCamera', 'updateHud', 'startCullingLoop', 'updateCulling',
        'updateEnemyRotation', 'updateThingPosition', 'reparentThingToSector',
        'updateProjectilePosition',
        'buildDoor', 'buildLift', 'buildCrusher',
        // Sprite visibility is a per-viewer decision (each client hides the
        // body it personally controls so the camera isn't inside its own
        // sprite). Broadcasting the server's bookkeeping call would hide
        // the possessed enemy for *every* client, so we drop it here and
        // let each client's local `possessFor` call do the hiding.
        'setThingVisible',
    ];
    for (const fn of dropped) {
        host[fn] = () => {};
    }

    return host;
}
