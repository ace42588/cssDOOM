/**
 * Browser-side network client.
 *
 * Opens a WebSocket to the authoritative game server, streams input
 * snapshots up every frame, and applies world snapshots coming down.
 *
 * The server is the source of truth. The client is a thin renderer:
 * it mutates the shared `state.js` / `player` objects only from
 * incoming snapshots, then the existing renderer modules read those
 * objects and draw. Transient visuals (puffs, hud messages, door
 * state changes, sounds) travel as event lists that we replay through
 * the local DOM renderer / Web Audio hosts.
 */

import { state, player } from '../game/state.js';
import { setMapState } from '../data/maps.js';
import * as rendererFacade from '../renderer/index.js';
import * as audioFacade from '../audio/audio.js';
import { collectInput, input } from '../input/index.js';
import { setMapName } from '../game/services.js';
import { WEAPONS } from '../game/constants.js';
import {
    LOCAL_SESSION,
    possessFor,
    releaseFor,
    getControlledFor,
    setRenderInterp,
} from '../game/possession.js';
import { getSectorAt } from '../game/physics/queries.js';
import { RUN_MULTIPLIER, TURN_SPEED } from '../game/constants.js';

const session = {
    sessionId: null,
    role: 'spectator',
    controlledId: null,
    followTargetId: null,
    tickRateHz: 35,
    serverTimeOffsetMs: 0,
    connected: false,
};

let ws = null;
let inputSeq = 0;
let onMapLoaded = null;
// True between receiving a `mapLoad` and the local rebuild finishing. Any
// `snapshot` that lands inside that window is dropped: there's no DOM to
// drive yet, and the snapshot's `applyThings` would otherwise refill
// `state.things` with bare {thingIndex} stubs that then collide with the
// real entries `spawnThings()` is about to register, breaking thingIndex
// alignment for the rest of the level.
let mapLoading = false;
// Set on every `mapLoad` (and at boot). Forces the next `applyPlayer` that
// carries a `currentWeapon` to push the slot through `renderer.switchWeapon`
// so the weapon sprite shows up — even when the slot is unchanged across
// the level transition.
let weaponNeedsRehydrate = true;

export function getSession() { return session; }

export function connect({ onMapLoad } = {}) {
    onMapLoaded = onMapLoad || null;

    const url = buildWsUrl();
    ws = new WebSocket(url);
    ws.onopen = () => { session.connected = true; };
    ws.onclose = () => { session.connected = false; };
    ws.onerror = () => {};
    ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); }
        catch { return; }
        handleMessage(msg);
    };
}

function buildWsUrl() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/ws`;
}

let lastInputFrameTime = 0;

/** Call once per animation frame — sends the latest local input upstream. */
export function sendInputFrame() {
    collectInput();

    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const deltaTime = lastInputFrameTime ? Math.min(0.1, (now - lastInputFrameTime) / 1000) : 0;
    lastInputFrameTime = now;

    // Client-side prediction: when the local session controls a door
    // (security camera), apply yaw updates locally each frame so the
    // camera tracks mouse/keyboard immediately. Server snapshots still
    // overwrite `viewAngle` authoritatively at the tick cadence.
    predictLocalDoorView(deltaTime);

    if (!ws || ws.readyState !== WebSocket.OPEN) {
        input.turnDelta = 0;
        return;
    }
    const snapshot = {
        type: 'input',
        seq: ++inputSeq,
        input: {
            moveX: input.moveX,
            moveY: input.moveY,
            turn: input.turn,
            turnDelta: input.turnDelta,
            run: input.run,
            fireHeld: input.fireHeld,
            use: drainFlag('use'),
            bodySwap: drainFlag('bodySwap'),
            doorDecision: drainFlag('doorDecision'),
            switchWeapon: drainFlag('switchWeapon'),
        },
    };
    input.turnDelta = 0; // turnDelta is an absolute delta, consume it every frame
    try { ws.send(JSON.stringify(snapshot)); } catch {}
}

function predictLocalDoorView(deltaTime) {
    const entity = getControlledFor(LOCAL_SESSION);
    if (!entity || !entity.__isDoorEntity) return;
    const turnSpeed = input.run ? TURN_SPEED * RUN_MULTIPLIER : TURN_SPEED;
    const delta = (input.turn || 0) * turnSpeed * deltaTime + (input.turnDelta || 0);
    if (delta === 0) return;
    const angle = (entity.viewAngle ?? 0) + delta;
    entity.viewAngle = angle;
    entity.facing = angle + Math.PI / 2;
}

const pendingFlags = {
    use: false,
    bodySwap: null,
    doorDecision: null,
    switchWeapon: null,
};

function drainFlag(name) {
    const value = pendingFlags[name];
    pendingFlags[name] = name === 'use' ? false : null;
    return value;
}

export function pressUse() { pendingFlags.use = true; }
export function requestBodySwap(targetId) { pendingFlags.bodySwap = { targetId }; }
export function requestDoorDecision(sectorIndex, requestId, decision) {
    pendingFlags.doorDecision = { sectorIndex, requestId, decision };
}
export function requestWeaponSwitch(slot) { pendingFlags.switchWeapon = slot; }

/**
 * Ask the server to switch to `mapName`. Used by the menu/level picker.
 * The server is authoritative; once it loads the map it will broadcast a
 * `mapLoad` and a fresh `roleChange` so the local client rebuilds the
 * scene and re-anchors its session.
 */
export function requestLoadMap(mapName) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (typeof mapName !== 'string' || !mapName) return;
    try {
        ws.send(JSON.stringify({ type: 'loadMapRequest', mapName }));
    } catch {}
}

// ── Incoming messages ────────────────────────────────────────────────

function handleMessage(msg) {
    switch (msg.type) {
        case 'welcome':
            session.sessionId = msg.sessionId;
            session.role = msg.role;
            session.controlledId = msg.controlledId;
            session.followTargetId = msg.followTargetId;
            session.tickRateHz = msg.tickRateHz || 35;
            session.serverTimeOffsetMs = (msg.serverTime || 0) - Date.now();
            break;
        case 'mapLoad':
            applyMapLoad(msg.mapName, msg.mapData);
            break;
        case 'roleChange':
            session.role = msg.role;
            session.controlledId = msg.controlledId;
            session.followTargetId = msg.followTargetId;
            break;
        case 'snapshot':
            applySnapshot(msg);
            break;
        case 'notice':
            if (typeof msg.message === 'string' && msg.message) {
                rendererFacade.showHudMessage(msg.message, 4000);
            }
            break;
        case 'bye':
            // server asked us to go away — we leave the socket in whatever
            // state it's in; reload to reconnect
            break;
    }
}

async function applyMapLoad(name, mapData) {
    mapLoading = true;
    weaponNeedsRehydrate = true;
    try {
        setMapState(name, mapData);
        setMapName(name);
        // Wipe per-level world state before the local re-spawn runs.
        //
        // `spawnThings()` (called from `applyServerMap`) APPENDS to
        // `state.things` via `registerThingEntry`. Without this reset the
        // new map's entries get allocated at indices N..N+M-1 (after the
        // old map's), the renderer's `thingDom` map is keyed on those
        // high indices, but the server's snapshots address things at
        // 0..M-1 — so every `updateThingPosition` /
        // `updateEnemyRotation` call lands in a void and enemies appear
        // frozen until the page is reloaded.
        //
        // Door / lift / crusher Maps and the projectile list are
        // level-scoped too; carrying them across maps leaves dangling
        // DOM refs and mismatched sectorIndex keys.
        resetClientWorldState();
        // Stale interpolators reference thing / projectile ids from the
        // previous map. The player interp is dropped too so the next
        // spawn-tick anchors `from` to the new arrival position instead
        // of lerping across the map.
        thingInterp.clear();
        projectileInterp.clear();
        playerInterp = null;
        playerRenderInitialized = false;
        // Server-pushed map loads always rebuild the local scene. A
        // previous "skip if same name" short-circuit broke level-restart
        // and same-map menu picks (nothing rebuilt, so the new entity
        // layout never showed up). Rebuilding for every server `mapLoad`
        // is the simple invariant.
        if (onMapLoaded) {
            await onMapLoaded(name, mapData);
        }
    } finally {
        mapLoading = false;
    }
    // Tell the server the local rebuild is done. The server has been
    // suppressing snapshots for this conn since it sent `mapLoad`; on
    // receipt of this ack it wipes its delta baseline so the next tick
    // arrives as a full "spawn everything" snapshot — including the
    // marine's authoritative spawn z / floorHeight, which would
    // otherwise stay at their default zeros.
    sendMapLoadComplete();
}

function sendMapLoadComplete() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify({ type: 'mapLoadComplete' })); } catch {}
}

function resetClientWorldState() {
    state.things.length = 0;
    state.projectiles.length = 0;
    state.nextProjectileId = 0;
    state.doorState.clear();
    state.liftState.clear();
    state.crusherState.clear();
}

/**
 * Called by the app-level map handler immediately before `spawnThings()`.
 * `applyMapLoad` already cleared world state, but this function is safe
 * to call again as a belt-and-suspenders guarantee that the spawn pass
 * starts from a fresh `state.things = []` (so registered indices line
 * up with server snapshot indices). Exposed because the snapshot gate
 * isn't infallible — for example if a future caller invokes the
 * rebuild outside of `applyMapLoad`.
 */
export function prepareForLocalSpawn() {
    resetClientWorldState();
    thingInterp.clear();
    projectileInterp.clear();
    playerInterp = null;
    playerRenderInitialized = false;
}

// ── Thing position interpolation ─────────────────────────────────────
//
// Server snapshots arrive at `tickRateHz` (~35 Hz). Snapping each thing's
// CSS position on snapshot looks jittery on a 60–144 Hz display, so we
// queue the from→to motion here and let a rAF loop lerp it forward at
// display refresh rate.
//
// Sector reparent is *deferred* until the lerp completes (t reaches 1).
// PVS culls by sector container, and `--light` is inherited from the
// container, so reparenting on snapshot arrival would pop the sprite's
// visibility and lighting at the snapshot threshold — visibly ahead of
// the visual position which is still tweening toward the new sector.
// Holding the parent until the lerp finishes keeps both effects glued
// to the rendered position.
//
// Map<thingIndex, {
//   fromX, fromY, fromFloor, toX, toY, toFloor, t0, dt,
//   pendingSectorIndex,  // sector to reparent into when the lerp ends
// }>
const thingInterp = new Map();

// Allow ~25% extrapolation past the expected snapshot window to hide a
// late packet without snapping to a stale "to" value. Used by the
// per-thing interp where small per-sprite overshoot is invisible.
const INTERP_MAX_T = 1.25;

// For interp sources that drive the entire viewport in lockstep (the
// camera/marine pose and projectiles), extrapolation overshoot becomes
// a visible step-back on the next snapshot — so we never extrapolate
// (`t` clamps at 1.0) and stretch the lerp window to 1.5× the snapshot
// interval. The longer window means a snapshot delayed by network
// jitter still arrives mid-lerp (instead of after the previous lerp
// expired), keeping motion continuous at the cost of ~half a tick of
// added latency.
const RENDER_INTERP_DURATION_FACTOR = 1.5;
function renderInterpDt() {
    return Math.max(16, RENDER_INTERP_DURATION_FACTOR * 1000 / (session.tickRateHz || 35));
}

function currentInterpPos(entry, now) {
    const elapsed = now - entry.t0;
    const t = Math.max(0, Math.min(INTERP_MAX_T, elapsed / entry.dt));
    return {
        x: entry.fromX + (entry.toX - entry.fromX) * t,
        y: entry.fromY + (entry.toY - entry.fromY) * t,
        floor: entry.fromFloor + (entry.toFloor - entry.fromFloor) * t,
    };
}

function tickThingInterp() {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    for (const [thingIndex, entry] of thingInterp) {
        const pos = currentInterpPos(entry, now);
        rendererFacade.updateThingPosition(thingIndex, {
            x: pos.x,
            y: pos.y,
            floorHeight: pos.floor,
        });
        // Once the lerp passes t=1 (visual position reached the snapshot
        // target), commit the deferred sector reparent. Holding the
        // reparent until now keeps PVS and `--light` inheritance glued
        // to the source sector through the lerp; flipping at t≥1 means
        // the new sector's lighting/PVS state takes effect exactly when
        // the sprite is visually in the new sector.
        if (entry.pendingSectorIndex !== undefined &&
            (now - entry.t0) >= entry.dt) {
            rendererFacade.reparentThingToSector(thingIndex, entry.pendingSectorIndex);
            entry.pendingSectorIndex = undefined;
        }
        if ((now - entry.t0) >= entry.dt * INTERP_MAX_T) {
            // Safety: if the entry expires without the deferred reparent
            // having been issued (shouldn't happen — dt < dt*INTERP_MAX_T
            // — but defend against future reordering), apply it now.
            if (entry.pendingSectorIndex !== undefined) {
                rendererFacade.reparentThingToSector(thingIndex, entry.pendingSectorIndex);
            }
            thingInterp.delete(thingIndex);
        }
    }
    requestAnimationFrame(tickThingInterp);
}

if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(tickThingInterp);
}

/**
 * Lerped pose for a single thing — used by `getControlledEye()` so the
 * camera follows possessed/spectated bodies smoothly instead of snapping
 * at the snapshot rate. Returns null when no entry is queued (caller
 * falls back to the snapshot-truth fields on the thing itself).
 */
export function getRenderedThingPose(id) {
    const entry = thingInterp.get(id);
    if (!entry) return null;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    return currentInterpPos(entry, now);
}

// ── Player position interpolation ────────────────────────────────────
//
// `applyPlayer` overwrites `player.x/y/z/angle` from each snapshot. With
// no client-side movement prediction in this codebase, that means even
// the locally-controlled marine moves at snapshot cadence — visibly
// jittery on a 60–144 Hz display. Mirror the thingInterp pattern: keep
// `player.*` as the snapshot target and lerp the rendered pose into
// `playerRender` on rAF.
//
// All four axes (x/y/z/angle) lerp on the same dt so stairs and lifts
// keep the eye height in sync with horizontal motion. (An older CSS
// `transition: --player-z 0.25s ease-out` in camera.css used to smooth
// falling but desynced from the JS-lerped x/y, causing the camera to
// clip through the next stair tread before the height transition
// caught up — see git blame on this comment.)

let playerInterp = null;
let playerRenderInitialized = false;
const playerRender = { x: 0, y: 0, z: 0, floor: 0, angle: 0 };

function shortestArcLerp(fromAngle, toAngle, t) {
    let delta = toAngle - fromAngle;
    delta = ((delta + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    return fromAngle + delta * t;
}

function currentPlayerInterpPose(entry, now) {
    const elapsed = now - entry.t0;
    // No extrapolation for the camera pose — see RENDER_INTERP_DURATION_FACTOR.
    const t = Math.max(0, Math.min(1, elapsed / entry.dt));
    return {
        x: entry.fromX + (entry.toX - entry.fromX) * t,
        y: entry.fromY + (entry.toY - entry.fromY) * t,
        z: entry.fromZ + (entry.toZ - entry.fromZ) * t,
        floor: entry.fromFloor + (entry.toFloor - entry.fromFloor) * t,
        angle: shortestArcLerp(entry.fromAngle, entry.toAngle, t),
    };
}

function tickPlayerInterp() {
    if (playerInterp) {
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const pose = currentPlayerInterpPose(playerInterp, now);
        playerRender.x = pose.x;
        playerRender.y = pose.y;
        playerRender.z = pose.z;
        playerRender.floor = pose.floor;
        playerRender.angle = pose.angle;
        if ((now - playerInterp.t0) >= playerInterp.dt) {
            playerInterp = null;
        }
    }
    requestAnimationFrame(tickPlayerInterp);
}

if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(tickPlayerInterp);
}

/**
 * Camera-facing pose for the local marine. Every field
 * (x/y/z/floor/angle) is interpolated on rAF between snapshots — see
 * the `Player position interpolation` block above for why even z lerps
 * (so the eye height stays glued to horizontal motion on stairs/lifts).
 */
export function getRenderedPlayerPose() {
    return playerRender;
}

setRenderInterp({ getRenderedPlayerPose, getRenderedThingPose });

// ── Projectile position interpolation ────────────────────────────────
//
// Server snapshots arrive at ~35 Hz; projectiles travel fast enough
// that snapping their CSS transform per tick produces visible stutter.
// Mirror the thingInterp shape (Map<id, from→to entry>) and write the
// lerped position to the projectile DOM each rAF.
//
// Map<projectileId, { fromX, fromY, fromZ, toX, toY, toZ, t0, dt }>
const projectileInterp = new Map();

function currentProjectileInterpPos(entry, now) {
    const elapsed = now - entry.t0;
    // No extrapolation — overshoot looks like the projectile flying past
    // its impact point before snapping back. See RENDER_INTERP_DURATION_FACTOR.
    const t = Math.max(0, Math.min(1, elapsed / entry.dt));
    return {
        x: entry.fromX + (entry.toX - entry.fromX) * t,
        y: entry.fromY + (entry.toY - entry.fromY) * t,
        z: entry.fromZ + (entry.toZ - entry.fromZ) * t,
    };
}

function tickProjectileInterp() {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    for (const [id, entry] of projectileInterp) {
        const pos = currentProjectileInterpPos(entry, now);
        rendererFacade.updateProjectilePosition(id, pos);
        if ((now - entry.t0) >= entry.dt) {
            projectileInterp.delete(id);
        }
    }
    requestAnimationFrame(tickProjectileInterp);
}

if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(tickProjectileInterp);
}

function applySnapshot(snap) {
    // Drop snapshots while the local map rebuild is in flight. The
    // websocket can deliver a tick mid-rebuild, and `applyThings` would
    // otherwise create bare entries in a state.things array that
    // `spawnThings()` is about to populate from index 0 — the duplicated
    // entries shift the spawn allocations into a high index range that
    // the renderer's DOM map never sees. The next snapshot after the
    // rebuild finishes carries every field we'd be skipping here.
    if (mapLoading) return;
    // Session-level bookkeeping (role/control can change per tick in
    // principle — the server sends the authoritative values on every snap).
    if (snap.role) session.role = snap.role;
    if (snap.controlledId !== undefined) session.controlledId = snap.controlledId;
    if (snap.followTargetId !== undefined) session.followTargetId = snap.followTargetId;

    applyPlayer(snap.player);
    applyThings(snap.things);
    applyProjectiles(snap.projectiles);
    applyDoors(snap.doors);
    applyLifts(snap.lifts);
    applyCrushers(snap.crushers);
    syncLocalPossession();
    replayEvents(snap.rendererEvents, snap.soundEvents);
}

/**
 * True if this entity can be driven for gameplay / camera purposes, using
 * the same criteria as `possessFor` (mirrors server snapshot application).
 */
function entityIsControllableSnapshot(entity) {
    if (!entity) return false;
    if (entity === player) return !player.isDead && !player.isAiDead;
    if (entity.__isDoorEntity) return true;
    if (!entity.ai) return false;
    if (entity.collected) return false;
    return (entity.hp ?? 0) > 0;
}

/**
 * Keep the local possession map (used by the browser's camera, HUD, and
 * body-swap UI) in sync with the server-authoritative control target.
 *
 * For a player session this is whichever body the server says we own.
 * For a spectator, the "camera view" is the random follow target — we
 * bind the local session to it so `getControlled()` naturally returns
 * the body the third-person camera should track.
 */
function syncLocalPossession() {
    const targetId = session.role === 'spectator'
        ? session.followTargetId
        : session.controlledId;
    const target = resolveEntityById(targetId);
    const currentLocal = getControlledFor(LOCAL_SESSION);

    // If the server id still points at our current ref but the body just
    // died this frame, do not bail early — otherwise we stay bound to a
    // collected thing until the next body-swap packet.
    if (target === currentLocal) {
        if (!currentLocal || entityIsControllableSnapshot(currentLocal)) return;
        releaseFor(LOCAL_SESSION);
        return;
    }

    if (!target) {
        releaseFor(LOCAL_SESSION);
        return;
    }

    if (!entityIsControllableSnapshot(target)) {
        releaseFor(LOCAL_SESSION);
        return;
    }

    if (!possessFor(LOCAL_SESSION, target)) {
        releaseFor(LOCAL_SESSION);
    }
}

function resolveEntityById(id) {
    if (!id) return null;
    if (id === 'player') return player;
    if (typeof id === 'string' && id.startsWith('thing:')) {
        const idx = Number(id.slice('thing:'.length));
        return state.things[idx] || null;
    }
    if (typeof id === 'string' && id.startsWith('door:')) {
        const sectorIndex = Number(id.slice('door:'.length));
        const entry = state.doorState.get(sectorIndex);
        return entry?.doorEntity || null;
    }
    return null;
}

// ── Delta merge helpers ──────────────────────────────────────────────
//
// Every apply* function is now a shallow merge of server-provided fields
// onto local state. Fields the server omitted are left untouched. This
// keeps client-side predicted values (e.g. door viewAngle) sticky across
// ticks where the server hasn't disagreed, and avoids the tick-rate GC
// churn of rebuilding Sets / spreading objects whose content didn't
// actually change.

function applyPlayer(p) {
    if (!p) return;
    const prevX = player.x;
    const prevY = player.y;
    const prevZ = player.z;
    const prevFloor = player.floorHeight;
    const prevAngle = player.angle;
    if (p.x !== undefined) player.x = p.x;
    if (p.y !== undefined) player.y = p.y;
    if (p.z !== undefined) player.z = p.z;
    if (p.angle !== undefined) player.angle = p.angle;
    if (p.floorHeight !== undefined) player.floorHeight = p.floorHeight;

    if (!playerRenderInitialized) {
        // Snap on the first snapshot (or first tick after a map switch /
        // respawn) so the camera doesn't visibly lerp in from (0, 0, 0).
        playerRender.x = player.x;
        playerRender.y = player.y;
        playerRender.z = player.z;
        playerRender.floor = player.floorHeight || 0;
        playerRender.angle = player.angle;
        playerRenderInitialized = true;
        playerInterp = null;
    } else {
        const moved =
            prevX !== player.x ||
            prevY !== player.y ||
            prevZ !== player.z ||
            prevFloor !== player.floorHeight ||
            prevAngle !== player.angle;
        if (moved) {
            const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            const dt = renderInterpDt();
            // "From" is the current rendered pose so motion stays
            // continuous mid-tween — same trick as `updateThing`. z and
            // floor lerp on the same dt as x/y so stair/lift height
            // changes stay aligned with horizontal motion.
            playerInterp = {
                fromX: playerRender.x,
                fromY: playerRender.y,
                fromZ: playerRender.z,
                fromFloor: playerRender.floor,
                fromAngle: playerRender.angle,
                toX: player.x,
                toY: player.y,
                toZ: player.z,
                toFloor: player.floorHeight || 0,
                toAngle: player.angle,
                t0: now,
                dt,
            };
        }
    }
    if (p.health !== undefined) player.health = p.health;
    if (p.armor !== undefined) player.armor = p.armor;
    if (p.armorType !== undefined) player.armorType = p.armorType;
    // Mutate ammo / maxAmmo per-key so the Proxy traps in `state.js` fire
    // and the HUD's subscribeAmmo listener picks up the deltas. Replacing
    // `player.ammo` with a fresh object would swap out the proxy entirely
    // and silently sever every subscriber.
    if (p.ammo) {
        for (const key in p.ammo) player.ammo[key] = p.ammo[key];
    }
    if (p.maxAmmo) {
        for (const key in p.maxAmmo) player.maxAmmo[key] = p.maxAmmo[key];
    }
    // Ownership must land before currentWeapon so the equip() guard
    // (which checks `ownedWeapons.has(slot)`) sees the authoritative set
    // for this snapshot. Otherwise the very first post-mapLoad delta —
    // which carries both fields together — would equip nothing because
    // `ownedWeapons` was still empty from the previous level.
    if (p.ownedWeapons !== undefined) player.ownedWeapons = new Set(p.ownedWeapons);
    if (p.currentWeapon !== undefined) {
        const weaponChanged = p.currentWeapon !== player.currentWeapon;
        player.currentWeapon = p.currentWeapon;
        // Two reasons to (re)issue the renderer switch:
        //   (a) the slot just changed mid-game, or
        //   (b) the local renderer element has no weapon yet — true after
        //       a fresh page load, and after a mapLoad if the slot didn't
        //       change across the transition (server-side per-key delta
        //       still echoes currentWeapon, so we use it as the trigger).
        // Without (b), the gun sprite stayed blank after the first stage
        // because dataset.type was never populated.
        if (weaponChanged || weaponNeedsRehydrate) {
            const weapon = WEAPONS[player.currentWeapon];
            if (weapon && player.ownedWeapons.has(player.currentWeapon)) {
                rendererFacade.switchWeapon(weapon.name, weapon.fireRate);
                weaponNeedsRehydrate = false;
            }
        }
    }
    if (p.collectedKeys !== undefined) player.collectedKeys = new Set(p.collectedKeys);
    if (p.powerups !== undefined) player.powerups = { ...p.powerups };
    if (p.hasBackpack !== undefined) player.hasBackpack = Boolean(p.hasBackpack);
    if (p.isDead !== undefined) player.isDead = Boolean(p.isDead);
    if (p.isAiDead !== undefined) player.isAiDead = Boolean(p.isAiDead);
    if (p.isFiring !== undefined) player.isFiring = Boolean(p.isFiring);
    if (p.__sessionId !== undefined) player.__sessionId = p.__sessionId;
}

function applyThings(block) {
    if (!block) return;
    const { spawn, update, despawn } = block;
    if (despawn && despawn.length) {
        for (const id of despawn) despawnThing(id);
    }
    if (spawn && spawn.length) {
        for (const rec of spawn) spawnThing(rec);
    }
    if (update && update.length) {
        for (const rec of update) updateThing(rec);
    }
}

/**
 * Materialize a thing from a server-sent spawn record. In the common case
 * (first tick after map load) the client already populated `state.things`
 * and the DOM via `spawnThings()` + `buildThings()`, so this function just
 * hydrates the existing skeleton with the server's authoritative fields
 * — identical to an `update`. The `else` branch is reserved for a future
 * runtime-spawn path (e.g. Lost Souls) that doesn't exist today.
 */
function spawnThing(rec) {
    const id = rec.id;
    let dst = state.things[id];
    if (!dst) {
        // No local skeleton. We can't synthesize a DOM element without
        // the map context that `buildThings()` reads from, so we record
        // the gameplay fields and warn. This keeps the engine-side state
        // consistent even if the renderer would be missing a sprite.
        dst = { thingIndex: id };
        state.things[id] = dst;
        // eslint-disable-next-line no-console
        console.warn('[net] delta spawn without local DOM for thing', id, rec.type);
    }
    updateThing(rec);
}

function updateThing(rec) {
    const id = rec.id;
    const dst = state.things[id];
    if (!dst) return;

    const prevX = dst.x;
    const prevY = dst.y;
    const prevFloorHeight = dst.floorHeight;
    const prevFacing = dst.facing;

    if (rec.type !== undefined) dst.type = rec.type;
    if (rec.x !== undefined) dst.x = rec.x;
    if (rec.y !== undefined) dst.y = rec.y;
    if (rec.z !== undefined && rec.z !== null) dst.z = rec.z;
    if (rec.floorHeight !== undefined) dst.floorHeight = rec.floorHeight;
    if (rec.facing !== undefined) dst.facing = rec.facing;
    if (rec.viewAngle !== undefined && rec.viewAngle !== null) dst.viewAngle = rec.viewAngle;
    if (rec.hp !== undefined) dst.hp = rec.hp;
    if (rec.maxHp !== undefined) dst.maxHp = rec.maxHp;
    if (rec.collected !== undefined) dst.collected = Boolean(rec.collected);
    if (rec.aiState !== undefined && dst.ai) dst.ai.state = rec.aiState;
    if (rec.__sessionId !== undefined) dst.__sessionId = rec.__sessionId;

    // On reconnect/reload, first snapshot after map build must hydrate
    // visual state from authoritative world state (not just positions).
    // Without this, corpses/pickups can look "fresh" until a new local
    // renderer event happens.
    if (rec.collected !== undefined && dst.collected) {
        const enemyLike = Boolean(dst.ai) || dst.type === 2035; // barrel
        if (enemyLike) {
            rendererFacade.killEnemy(id, dst.type);
        } else {
            rendererFacade.collectItem(id);
        }
    }

    // Refresh the DOM sprite position so the rendered body tracks the
    // authoritative server state each snapshot. Instead of snapping
    // straight to the new value (which looks like 35 Hz stutter on a
    // higher-Hz display), queue a from→to entry that the interp loop
    // lerps forward each frame.
    const moved =
        prevX !== dst.x ||
        prevY !== dst.y ||
        prevFloorHeight !== dst.floorHeight;

    if (moved) {
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const dt = Math.max(16, 1000 / (session.tickRateHz || 35));
        const existing = thingInterp.get(id);
        // The "from" point is wherever the lerp currently sits — using
        // the rendered position (not the prev snapshot) keeps motion
        // continuous when a snapshot arrives mid-tween.
        let fromX, fromY, fromFloor;
        if (existing) {
            const cur = currentInterpPos(existing, now);
            fromX = cur.x; fromY = cur.y; fromFloor = cur.floor;
        } else {
            fromX = prevX ?? dst.x;
            fromY = prevY ?? dst.y;
            fromFloor = prevFloorHeight ?? dst.floorHeight ?? 0;
        }
        // Compute the target sector but defer the actual reparent until
        // the lerp completes — see the `tickThingInterp` comment for why
        // (PVS gating and `--light` inheritance must follow the rendered
        // position, not the snapshot threshold). If a previous interp had
        // a pending reparent that hadn't fired yet, replace it with the
        // newer one — the latest snapshot wins.
        const targetSector = getSectorAt(dst.x, dst.y);
        const pendingSectorIndex = targetSector ? targetSector.sectorIndex : undefined;
        thingInterp.set(id, {
            fromX, fromY, fromFloor,
            toX: dst.x,
            toY: dst.y,
            toFloor: dst.floorHeight ?? 0,
            t0: now,
            dt,
            pendingSectorIndex,
        });
    }
    if (prevFacing !== dst.facing) {
        rendererFacade.updateEnemyRotation(id, dst);
    }
}

function despawnThing(id) {
    thingInterp.delete(id);
    rendererFacade.removeThing(id);
    delete state.things[id];
}

function applyProjectiles(block) {
    if (!block) return;
    const { spawn, update, despawn } = block;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const dt = renderInterpDt();
    if (despawn && despawn.length) {
        for (const id of despawn) {
            const idx = state.projectiles.findIndex((p) => p.id === id);
            if (idx >= 0) state.projectiles.splice(idx, 1);
            projectileInterp.delete(id);
        }
    }
    if (spawn && spawn.length) {
        for (const rec of spawn) {
            const existing = state.projectiles.find((p) => p.id === rec.id);
            if (existing) {
                existing.x = rec.x; existing.y = rec.y; existing.z = rec.z;
            } else {
                state.projectiles.push({ id: rec.id, x: rec.x, y: rec.y, z: rec.z });
            }
            // Seed the interp at rest at the spawn point so the first
            // `update` lerps cleanly from where the DOM was created.
            // The `tick` loop will write `--x/--y/--z` on the DOM next
            // frame even before the first update arrives.
            projectileInterp.set(rec.id, {
                fromX: rec.x, fromY: rec.y, fromZ: rec.z,
                toX:   rec.x, toY:   rec.y, toZ:   rec.z,
                t0: now, dt,
            });
        }
    }
    if (update && update.length) {
        for (const rec of update) {
            const dst = state.projectiles.find((p) => p.id === rec.id);
            if (!dst) continue;
            const prevX = dst.x, prevY = dst.y, prevZ = dst.z;
            if (rec.x !== undefined) dst.x = rec.x;
            if (rec.y !== undefined) dst.y = rec.y;
            if (rec.z !== undefined) dst.z = rec.z;
            const moved = prevX !== dst.x || prevY !== dst.y || prevZ !== dst.z;
            if (!moved) continue;
            const existing = projectileInterp.get(rec.id);
            let fromX, fromY, fromZ;
            if (existing) {
                const cur = currentProjectileInterpPos(existing, now);
                fromX = cur.x; fromY = cur.y; fromZ = cur.z;
            } else {
                fromX = prevX ?? dst.x;
                fromY = prevY ?? dst.y;
                fromZ = prevZ ?? dst.z;
            }
            projectileInterp.set(rec.id, {
                fromX, fromY, fromZ,
                toX: dst.x, toY: dst.y, toZ: dst.z,
                t0: now, dt,
            });
        }
    }
}

// Note: door/lift/crusher snapshots intentionally exclude immutable
// per-map fields (door.keyRequired, lift.tag/lowerHeight/upperHeight/
// oneWay, crusher.topHeight/crushHeight). Those are populated locally
// by `initDoors/initLifts/initCrushers` from `mapData` after every
// `mapLoad`, so the wire only needs to carry per-tick mutables.

function applyDoors(doors) {
    if (!doors || !doors.length) return;
    for (const d of doors) {
        const entry = state.doorState.get(d.sectorIndex);
        if (!entry) continue;
        if (d.open !== undefined) entry.open = d.open;
        if (d.passable !== undefined) entry.passable = d.passable;

        const doorEntity = entry.doorEntity;
        if (!doorEntity) continue;
        // Mirror server-authoritative operator + pending-request state onto
        // the client's door entity so the operator modal can read it. Each
        // field is only copied when the delta carried it, which lets local
        // client-side prediction (e.g. doorEntity.viewAngle) stay sticky
        // across ticks the server didn't disagree with.
        if (d.operatorSessionId !== undefined) {
            doorEntity.__sessionId = d.operatorSessionId || null;
        }
        if (typeof d.viewAngle === 'number') {
            doorEntity.viewAngle = d.viewAngle;
            doorEntity.facing = d.viewAngle + Math.PI / 2;
        }
        if (d.pendingRequests !== undefined) {
            doorEntity.pendingRequests = Array.isArray(d.pendingRequests)
                ? d.pendingRequests.map((r) => ({
                    id: r.id,
                    interactorId: r.interactorId,
                    interactorLabel: r.interactorLabel,
                    interactorDetails: r.interactorDetails,
                    approachSide: r.approachSide,
                }))
                : [];
        }
    }
}

function applyLifts(lifts) {
    if (!lifts || !lifts.length) return;
    for (const l of lifts) {
        const entry = state.liftState.get(l.sectorIndex);
        if (!entry) continue;
        if (l.currentHeight !== undefined) entry.currentHeight = l.currentHeight;
        if (l.targetHeight !== undefined) entry.targetHeight = l.targetHeight;
        if (l.moving !== undefined) entry.moving = l.moving;
    }
}

function applyCrushers(crushers) {
    if (!crushers || !crushers.length) return;
    for (const c of crushers) {
        const entry = state.crusherState.get(c.sectorIndex);
        if (!entry) continue;
        if (c.active !== undefined) entry.active = c.active;
        if (c.direction !== undefined) entry.direction = c.direction;
        if (c.currentHeight !== undefined) entry.currentHeight = c.currentHeight;
        if (c.damageTimer !== undefined) entry.damageTimer = c.damageTimer;
    }
}

function replayEvents(rendererEvents, soundEvents) {
    const viewerId = session.sessionId;
    if (rendererEvents && rendererEvents.length) {
        for (const ev of rendererEvents) {
            if (ev.forSessionId && ev.forSessionId !== viewerId) continue;
            const fn = rendererFacade[ev.fn];
            if (typeof fn === 'function') {
                try { fn(...(ev.args || [])); } catch {}
            }
        }
    }
    if (soundEvents && soundEvents.length) {
        for (const ev of soundEvents) {
            const name = typeof ev === 'string' ? ev : ev?.sound;
            if (!name) continue;
            if (typeof ev === 'object' && ev?.forSessionId) {
                if (!viewerId || ev.forSessionId !== viewerId) continue;
            }
            try { audioFacade.playSound(name); } catch {}
        }
    }
}
