/**
 * Engine services facade — environment-neutral entry point for the side
 * effects the engine wants to signal to its host: access evaluations
 * (e.g. door opens), per-entity "dirty" notifications for downstream
 * identity/telemetry systems (SCIM push), and heartbeats.
 *
 * The browser installs no-op stubs (simulation is server-side; the client has
 * nothing to push). The server installs implementations that talk to SGNL
 * (access evaluations, CAEP, SCIM). Keeping this a facade means the
 * engine modules (`src/engine/mechanics/doors.js`, `src/engine/index.js`,
 * `src/engine/lifecycle.js`) never import SGNL clients directly — they run
 * unchanged on both sides.
 *
 * SCIM dirty-flag API:
 *
 *   markEntityDirty(kind, id)   — request a SCIM push for a single
 *                                  entity. `kind` is one of
 *                                  'player' | 'actor' | 'door' | 'lift'
 *                                  | 'crusher' | 'pickup'. `id` is the
 *                                  canonical asset id (matches what the
 *                                  SGNL gRPC adapter emits), e.g.
 *                                  `door:42` (sector index) or `player:<session>`.
 *   markPlayerDirty(sessionId?) — convenience wrapper for the connected
 *                                  player's SCIM resource.
 *   markMapChanged(name)        — the engine loaded a new map; the host
 *                                  should rebaseline per-entity state.
 *   flushNow()                  — force a dispatch pass right now.
 *   tickHeartbeat(deltaTime)    — periodic poll so the host can sweep
 *                                  continuously-changing entities (AI
 *                                  positions, player movement).
 *
 * Door access mode (multiplayer / host):
 *
 *   getDoorControlMode()        — returns `standard` | `sgnl` | `player`
 *                                  (see `DOOR_CONTROL_MODE` in constants).
 *                                  Defaults to `player` when no host hook.
 */

import { DOOR_CONTROL_MODE } from './constants.js';

let services = {};

export function setGameServices(impl) {
    services = impl || {};
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

/**
 * Which door gating path `toggleDoor` uses. Host supplies the server setting;
 * browser default is `player` (human operator when possessing the door, else open).
 */
export function getDoorControlMode() {
    const mode = services.getDoorControlMode?.();
    return mode || DOOR_CONTROL_MODE.PLAYER;
}

// ── SCIM / per-entity push ─────────────────────────────────────────────

/**
 * Request a SCIM push for a single entity. Host implementations rate-limit
 * (typically 1Hz per entity) and dedupe by content hash, so callers can
 * invoke this freely on every meaningful state transition.
 */
export function markEntityDirty(kind, id) {
    services.markEntityDirty?.(kind, id);
}

/**
 * Convenience wrapper for marking the current player session dirty.
 * `sessionId` is optional when the host maps a default session.
 */
export function markPlayerDirty(sessionId) {
    services.markPlayerDirty?.(sessionId);
}

/**
 * Signal that a new map was loaded. Hosts should rebaseline their SCIM
 * resource bookkeeping (new door/lift/pickup ids, drop stale ones).
 */
export function markMapChanged(mapName) {
    services.markMapChanged?.(mapName);
}

/** Force a dispatch pass right now (respecting per-entity rate limits). */
export async function flushNow() {
    await services.flushNow?.();
}

/**
 * Called once per frame / tick with the elapsed time in seconds so the
 * host can sweep high-churn entities (AI actors, player movement) into
 * the dirty set on a regular cadence.
 */
export function tickHeartbeat(deltaTime) {
    services.tickHeartbeat?.(deltaTime);
}

// ── Level lifecycle ───────────────────────────────────────────────────

export function setMapName(name) {
    services.setMapName?.(name);
}
