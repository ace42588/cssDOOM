/**
 * Engine services facade — environment-neutral entry point for the side
 * effects the engine wants to signal to its host: access evaluations
 * (e.g. door opens), "game state dirty" notifications for downstream
 * identity/telemetry systems, and heartbeats.
 *
 * Browser default installs no-op stubs (the engine runs fully locally in
 * single-player prototyping). Server installs implementations that talk to
 * SGNL (access evaluations, CAEP, SCIM). Keeping this a facade means the
 * engine modules (`src/game/mechanics/doors.js`, `src/game/index.js`,
 * `src/game/lifecycle.js`) never import SGNL clients directly — they run
 * unchanged on both sides.
 */

let services = {};

export function setGameServices(impl) {
    services = impl || {};
}

export function getGameServices() {
    return services;
}

// ── Access ─────────────────────────────────────────────────────────────

/**
 * Evaluate whether a controller is allowed to perform an action on an asset.
 * Returns a promise resolving to `{allowed, decision?, reasons?, skipped?}`.
 * `controllerId` identifies the requesting body (e.g. session id or 'local');
 * the host is responsible for mapping it to a principal.
 *
 * Fail-open default: if no implementation is installed, return allowed.
 */
export async function evaluateAccess(controllerId, assetId, action) {
    if (!services.evaluateAccess) return { allowed: true, skipped: true };
    try {
        return await services.evaluateAccess(controllerId, assetId, action);
    } catch {
        return { allowed: true, skipped: true };
    }
}

// ── SCIM / game-state push ─────────────────────────────────────────────

export function markGameStateDirty() {
    services.markGameStateDirty?.();
}

export function markPlayerDirty() {
    services.markPlayerDirty?.();
}

export function markAllDirty() {
    services.markAllDirty?.();
}

export async function flushNow() {
    await services.flushNow?.();
}

export function tickHeartbeat(deltaTime) {
    services.tickHeartbeat?.(deltaTime);
}

// ── Level lifecycle ───────────────────────────────────────────────────

export function setMapName(name) {
    services.setMapName?.(name);
}
