/**
 * Renderer facade — the single entry point for the game layer.
 *
 * This module is **environment-neutral**: it imports no DOM modules and runs
 * unchanged on Node (server) and in the browser. All functions forward to a
 * swappable host object installed via `setRendererHost(host)`:
 *
 *   - Browser entry [index.js](index.js) installs the DOM host from
 *     `src/renderer/dom/host.js` (via `createDomRendererHost()`).
 *   - The server (`server/world.js`) installs a recording host from
 *     `src/renderer/recording-host.js` that buffers each call as
 *     `{fn, args}` for inclusion in the next broadcast snapshot, so the
 *     engine's visual intentions (puffs, explosions, door state changes,
 *     hud messages, weapon switches) can be replayed on clients.
 *   - The default host is a no-op — it lets the engine run without any
 *     visuals attached (useful for headless unit tests).
 *
 * Game code should never import from renderer sub-modules directly; doing so
 * would pull DOM access into the engine bundle.
 */

/** @type {Partial<Record<string, Function>>} */
let host = {};

/**
 * Install a renderer host. Pass `null` or `undefined` to reset to no-op.
 * Safe to call multiple times (e.g., swap a recording host for a DOM host).
 */
export function setRendererHost(impl) {
    host = impl || {};
}

/** Access the currently installed host (for advanced use — e.g. draining events). */
export function getRendererHost() {
    return host;
}

// ── Camera / HUD ──────────────────────────────────────────────────────
export function updateCamera(...args) { return host.updateCamera?.(...args); }
export function updateHud(...args) { return host.updateHud?.(...args); }
export function clearWeaponSlots(...args) { return host.clearWeaponSlots?.(...args); }
export function showHudMessage(...args) { return host.showHudMessage?.(...args); }

// ── Culling ──────────────────────────────────────────────────────────
export function startCullingLoop(...args) { return host.startCullingLoop?.(...args); }
export function updateCulling(...args) { return host.updateCulling?.(...args); }

// ── Effects ──────────────────────────────────────────────────────────
export function triggerFlash(...args) { return host.triggerFlash?.(...args); }
/** Hurt / death overlays for the marine — scoped to one viewer in multiplayer. */
export function triggerViewerFlash(className, forSessionId, duration = 300) {
    return host.triggerViewerFlash?.(className, forSessionId, duration)
        ?? host.triggerFlash?.(className, duration);
}
export function showPowerup(...args) { return host.showPowerup?.(...args); }
export function flickerPowerup(...args) { return host.flickerPowerup?.(...args); }
export function hidePowerup(...args) { return host.hidePowerup?.(...args); }

// ── Sprites / things ─────────────────────────────────────────────────
export function setEnemyState(...args) { return host.setEnemyState?.(...args); }
export function resetEnemy(...args) { return host.resetEnemy?.(...args); }
export function killEnemy(...args) { return host.killEnemy?.(...args); }
export function updateEnemyRotation(...args) { return host.updateEnemyRotation?.(...args); }
export function updateThingPosition(...args) { return host.updateThingPosition?.(...args); }
export function reparentThingToSector(...args) { return host.reparentThingToSector?.(...args); }
export function collectItem(...args) { return host.collectItem?.(...args); }
export function removeThing(...args) { return host.removeThing?.(...args); }
export function setThingVisible(...args) { return host.setThingVisible?.(...args); }
export function createPuff(...args) { return host.createPuff?.(...args); }
export function createExplosion(...args) { return host.createExplosion?.(...args); }
export function createTeleportFog(...args) { return host.createTeleportFog?.(...args); }
export function createProjectile(...args) { return host.createProjectile?.(...args); }
export function updateProjectilePosition(...args) { return host.updateProjectilePosition?.(...args); }
export function removeProjectile(...args) { return host.removeProjectile?.(...args); }

// ── Player visuals ───────────────────────────────────────────────────
export function setPlayerDead(...args) { return host.setPlayerDead?.(...args); }
export function setViewerPlayerDead(dead, forSessionId) {
    return host.setViewerPlayerDead?.(dead, forSessionId)
        ?? host.setPlayerDead?.(dead);
}
export function clearKeys(...args) { return host.clearKeys?.(...args); }
export function setPlayerMoving(...args) { return host.setPlayerMoving?.(...args); }
export function collectKey(...args) { return host.collectKey?.(...args); }

// ── Weapon visuals ───────────────────────────────────────────────────
export function isWeaponSwitching(...args) {
    // Must always return a boolean — combat code short-circuits if a switch
    // animation is currently playing (browser), and on server we want the
    // engine to proceed without ever gating on a visual animation.
    return Boolean(host.isWeaponSwitching?.(...args));
}
export function switchWeapon(...args) { return host.switchWeapon?.(...args); }
export function startFiring(...args) { return host.startFiring?.(...args); }
export function stopFiring(...args) { return host.stopFiring?.(...args); }

// ── Doors / lifts / crushers / switches ──────────────────────────────
export function buildDoor(...args) { return host.buildDoor?.(...args); }
export function setDoorState(...args) { return host.setDoorState?.(...args); }
export function buildLift(...args) { return host.buildLift?.(...args); }
export function setLiftState(...args) { return host.setLiftState?.(...args); }
export function buildCrusher(...args) { return host.buildCrusher?.(...args); }
export function setCrusherOffset(...args) { return host.setCrusherOffset?.(...args); }
export function toggleSwitchState(...args) { return host.toggleSwitchState?.(...args); }

// ── Surfaces ────────────────────────────────────────────────────────
export function lowerTaggedFloor(...args) { return host.lowerTaggedFloor?.(...args); }
