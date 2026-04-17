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
import {
    LOCAL_SESSION,
    possessFor,
    releaseFor,
    getControlledFor,
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
let mapBuiltFor = null;

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
        case 'bye':
            // server asked us to go away — we leave the socket in whatever
            // state it's in; reload to reconnect
            break;
    }
}

async function applyMapLoad(name, mapData) {
    setMapState(name, mapData);
    setMapName(name);
    if (mapBuiltFor === name) return;
    mapBuiltFor = name;
    if (onMapLoaded) {
        await onMapLoaded(name, mapData);
    }
}

function applySnapshot(snap) {
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
    if (target === currentLocal) return;
    if (!target) {
        releaseFor(LOCAL_SESSION);
        return;
    }
    possessFor(LOCAL_SESSION, target);
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

function applyPlayer(p) {
    if (!p) return;
    player.x = p.x; player.y = p.y; player.z = p.z;
    player.angle = p.angle;
    player.floorHeight = p.floorHeight;
    player.health = p.health;
    player.armor = p.armor;
    player.armorType = p.armorType;
    player.ammo = { ...p.ammo };
    player.maxAmmo = { ...p.maxAmmo };
    player.currentWeapon = p.currentWeapon;
    player.ownedWeapons = new Set(p.ownedWeapons || []);
    player.collectedKeys = new Set(p.collectedKeys || []);
    player.powerups = { ...p.powerups };
    player.hasBackpack = Boolean(p.hasBackpack);
    player.isDead = Boolean(p.isDead);
    player.isAiDead = Boolean(p.isAiDead);
    player.isFiring = Boolean(p.isFiring);
    if (p.__sessionId !== undefined) player.__sessionId = p.__sessionId;
}

function applyThings(things) {
    if (!things) return;
    // Server snapshots include every thing by index. Resize to match.
    state.things.length = things.length;
    for (let i = 0; i < things.length; i++) {
        const src = things[i];
        let dst = state.things[i];
        if (!dst) {
            dst = { thingIndex: i };
            state.things[i] = dst;
        }
        const prevX = dst.x;
        const prevY = dst.y;
        const prevFloorHeight = dst.floorHeight;
        const prevFacing = dst.facing;

        dst.thingIndex = i;
        dst.type = src.type;
        dst.x = src.x; dst.y = src.y;
        if (src.z !== null) dst.z = src.z;
        dst.floorHeight = src.floorHeight;
        dst.facing = src.facing;
        if (src.viewAngle !== null) dst.viewAngle = src.viewAngle;
        dst.hp = src.hp;
        dst.maxHp = src.maxHp;
        dst.collected = Boolean(src.collected);
        if (dst.ai) dst.ai.state = src.aiState;
        dst.__sessionId = src.__sessionId ?? null;

        // Refresh the DOM sprite position so the rendered body tracks the
        // authoritative server state each snapshot. Without this the sprite
        // stays anchored at wherever `buildScene()` first placed it — which
        // both hides movement and mis-aligns hit detection with what the
        // local player sees.
        const moved =
            prevX !== dst.x ||
            prevY !== dst.y ||
            prevFloorHeight !== dst.floorHeight;

        if (moved) {
            rendererFacade.updateThingPosition(i, {
                x: dst.x,
                y: dst.y,
                floorHeight: dst.floorHeight ?? 0,
            });
            const sector = getSectorAt(dst.x, dst.y);
            if (sector) rendererFacade.reparentThingToSector(i, sector.sectorIndex);
        }
        if (prevFacing !== dst.facing) {
            rendererFacade.updateEnemyRotation(i, dst);
        }
    }
}

function applyProjectiles(projectiles) {
    if (!projectiles) return;
    const byId = new Map();
    for (const p of state.projectiles) byId.set(p.id, p);
    const next = [];
    for (const src of projectiles) {
        let dst = byId.get(src.id);
        if (!dst) dst = { id: src.id };
        dst.x = src.x; dst.y = src.y; dst.z = src.z;
        next.push(dst);
    }
    state.projectiles = next;
}

function applyDoors(doors) {
    if (!doors) return;
    for (const d of doors) {
        const entry = state.doorState.get(d.sectorIndex);
        if (!entry) continue;
        entry.open = d.open;
        entry.passable = d.passable;
        entry.keyRequired = d.keyRequired;

        // Mirror server-authoritative operator + pending-request state onto
        // the client's door entity so the operator modal can read it.
        const doorEntity = entry.doorEntity;
        if (doorEntity) {
            doorEntity.__sessionId = d.operatorSessionId || null;
            if (typeof d.viewAngle === 'number') {
                doorEntity.viewAngle = d.viewAngle;
                doorEntity.facing = d.viewAngle + Math.PI / 2;
            }
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
    if (!lifts) return;
    for (const l of lifts) {
        const entry = state.liftState.get(l.sectorIndex);
        if (!entry) continue;
        entry.currentHeight = l.currentHeight;
        entry.targetHeight = l.targetHeight;
        entry.lowerHeight = l.lowerHeight;
        entry.upperHeight = l.upperHeight;
        entry.moving = l.moving;
        entry.oneWay = l.oneWay;
        if (l.tag !== null) entry.tag = l.tag;
    }
}

function applyCrushers(crushers) {
    if (!crushers) return;
    for (const c of crushers) {
        const entry = state.crusherState.get(c.sectorIndex);
        if (!entry) continue;
        entry.active = c.active;
        entry.direction = c.direction;
        entry.currentHeight = c.currentHeight;
        entry.topHeight = c.topHeight;
        entry.crushHeight = c.crushHeight;
        entry.damageTimer = c.damageTimer;
    }
}

function replayEvents(rendererEvents, soundEvents) {
    if (rendererEvents && rendererEvents.length) {
        for (const ev of rendererEvents) {
            const fn = rendererFacade[ev.fn];
            if (typeof fn === 'function') {
                try { fn(...(ev.args || [])); } catch {}
            }
        }
    }
    if (soundEvents && soundEvents.length) {
        for (const name of soundEvents) {
            try { audioFacade.playSound(name); } catch {}
        }
    }
}
