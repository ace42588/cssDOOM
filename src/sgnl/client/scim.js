import { player, state } from '../../game/state.js';

const SCIM_PROXY_PATH = '/__scim/v2';
const PLAYER_SCHEMA = 'urn:cssdoom:params:scim:schemas:extension:player:2.0:Player';
const GAME_STATE_SCHEMA = 'urn:cssdoom:params:scim:schemas:extension:state:2.0:GameState';
const SCIM_CORE_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCIM_CORRELATION_KEY = 'cssdoom-scim-correlation-id';
const HEARTBEAT_SECONDS = 5;

let scimBaseUrl = '';
let scimToken = '';
let scimEnabled = false;
let scimInitialized = false;
let correlationId = '';
let currentMapName = 'E1M1';

let playerResourceId = '';
let gameStateResourceId = '';

let playerDirty = false;
let gameStateDirty = false;
let pushInFlight = false;
let queuedPush = false;
let heartbeatElapsed = 0;
let lastPlayerHash = '';
let lastGameStateHash = '';

function normalizeBaseUrl(baseUrl) {
    return baseUrl.replace(/\/+$/, '');
}

function resolveScimBaseUrl() {
    const direct = import.meta.env.VITE_SCIM_PUSH_URL;
    if (!direct) return '';
    if (import.meta.env.VITE_SCIM_USE_DIRECT_URL === 'true') return normalizeBaseUrl(direct);
    const useViteProxy = import.meta.env.DEV || import.meta.env.VITE_SCIM_USE_LOCAL_PROXY === 'true';
    return useViteProxy ? SCIM_PROXY_PATH : normalizeBaseUrl(direct);
}

function getOrCreateCorrelationId() {
    try {
        let id = sessionStorage.getItem(SCIM_CORRELATION_KEY);
        if (!id) {
            id = crypto.randomUUID();
            sessionStorage.setItem(SCIM_CORRELATION_KEY, id);
        }
        return id;
    } catch {
        return crypto.randomUUID();
    }
}

function toSortedArray(values) {
    return [...values].sort((left, right) => (left > right ? 1 : left < right ? -1 : 0));
}

function safeJsonStringify(value) {
    const seen = new WeakSet();
    return JSON.stringify(value, (_key, fieldValue) => {
        if (typeof fieldValue === 'function') return undefined;
        if (fieldValue && typeof fieldValue === 'object') {
            if (seen.has(fieldValue)) return undefined;
            seen.add(fieldValue);
        }
        return fieldValue;
    });
}

function nowIsoString() {
    return new Date().toISOString();
}

function mapDoorStateEntry(entry) {
    return {
        sectorIndex: entry.sectorIndex,
        open: Boolean(entry.open),
        passable: Boolean(entry.passable),
        ...(entry.keyRequired ? { keyRequired: entry.keyRequired } : {}),
    };
}

function mapLiftStateEntry(entry) {
    return {
        sectorIndex: entry.sectorIndex,
        ...(Number.isFinite(entry.tag) ? { tag: entry.tag } : {}),
        currentHeight: entry.currentHeight,
        targetHeight: entry.targetHeight,
        lowerHeight: entry.lowerHeight,
        upperHeight: entry.upperHeight,
        moving: Boolean(entry.moving),
        oneWay: Boolean(entry.oneWay),
    };
}

function mapCrusherStateEntry(entry) {
    return {
        sectorIndex: entry.sectorIndex,
        active: Boolean(entry.active),
        direction: entry.direction,
        currentHeight: entry.currentHeight,
        topHeight: entry.topHeight,
        crushHeight: entry.crushHeight,
        damageTimer: entry.damageTimer,
    };
}

function snapshotPlayerPayload() {
    const updatedAt = nowIsoString();
    const playerState = {
        mapName: currentMapName,
        correlationId,
        displayName: 'Doom Marine',
        position: {
            x: player.x,
            y: player.y,
            z: player.z,
            angle: player.angle,
        },
        vitals: {
            health: player.health,
            armor: player.armor,
            armorType: player.armorType,
            isDead: player.isDead,
            ...(Number.isFinite(player.deathTime) && player.deathTime > 0
                ? { deathTime: player.deathTime }
                : {}),
        },
        ammo: {
            bullets: player.ammo.bullets,
            shells: player.ammo.shells,
            rockets: player.ammo.rockets,
            cells: player.ammo.cells,
        },
        maxAmmo: {
            bullets: player.maxAmmo.bullets,
            shells: player.maxAmmo.shells,
            rockets: player.maxAmmo.rockets,
            cells: player.maxAmmo.cells,
        },
        inventory: {
            hasBackpack: player.hasBackpack,
            currentWeapon: player.currentWeapon,
            ownedWeapons: toSortedArray(player.ownedWeapons),
            collectedKeys: toSortedArray(player.collectedKeys),
        },
        powerups: Object.entries(player.powerups).map(([name, remainingSeconds]) => ({
            name,
            remainingSeconds,
        })),
        updatedAt,
    };

    return {
        schemas: [SCIM_CORE_USER_SCHEMA, PLAYER_SCHEMA],
        userName: `player:${correlationId}`,
        active: true,
        [PLAYER_SCHEMA]: playerState,
    };
}

function snapshotGameStatePayload() {
    const updatedAt = nowIsoString();
    const doorState = [...state.doorState.values()].map(mapDoorStateEntry);
    const liftState = [...state.liftState.values()].map(mapLiftStateEntry);
    const crusherState = [...state.crusherState.values()].map(mapCrusherStateEntry);

    const gameStatePayload = {
        mapName: currentMapName,
        correlationId,
        skillLevel: state.skillLevel,
        thingCount: state.things.length,
        projectileCount: state.projectiles.length,
        nextProjectileId: state.nextProjectileId,
        doorState,
        liftState,
        crusherState,
        thingsSnapshot: safeJsonStringify(state.things),
        projectilesSnapshot: safeJsonStringify(state.projectiles),
        updatedAt,
    };

    return {
        schemas: [SCIM_CORE_USER_SCHEMA, GAME_STATE_SCHEMA],
        userName: `state:${correlationId}`,
        active: true,
        [GAME_STATE_SCHEMA]: gameStatePayload,
    };
}

async function parseJsonSafe(response) {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

async function scimRequest(method, path, body) {
    const response = await fetch(`${scimBaseUrl}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${scimToken}`,
            'Content-Type': 'application/scim+json',
            Accept: 'application/scim+json, application/json',
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        if (import.meta.env.DEV) {
            const errorText = await response.text().catch(() => '');
            console.warn(`[scim] ${method} ${path} failed`, response.status, errorText);
        }
        return null;
    }

    return parseJsonSafe(response);
}

async function createPlayerResource() {
    const payload = snapshotPlayerPayload();
    const responseBody = await scimRequest('POST', '/Users', payload);
    if (!responseBody) return false;

    playerResourceId = responseBody.id || correlationId;
    lastPlayerHash = JSON.stringify(payload);
    playerDirty = false;
    return true;
}

async function createGameStateResource() {
    const payload = snapshotGameStatePayload();
    //const responseBody = await scimRequest('POST', '/Users', payload);
    //if (!responseBody) return false;

    gameStateResourceId = responseBody.id || correlationId;
    lastGameStateHash = JSON.stringify(payload);
    gameStateDirty = false;
    return true;
}

async function ensureResourcesCreated() {
    if (!playerResourceId) {
        const created = await createPlayerResource();
        if (!created) return false;
    }
    if (!gameStateResourceId) {
        const created = await createGameStateResource();
        if (!created) return false;
    }
    return true;
}

async function pushPlayerIfDirty() {
    if (!playerDirty || !playerResourceId) return;
    const payload = snapshotPlayerPayload();
    const nextHash = JSON.stringify(payload);
    if (nextHash === lastPlayerHash) {
        playerDirty = false;
        return;
    }

    const updated = await scimRequest('PUT', `/Users/${encodeURIComponent(playerResourceId)}`, payload);
    if (!updated) return;
    lastPlayerHash = nextHash;
    playerDirty = false;
}

async function pushGameStateIfDirty() {
    if (!gameStateDirty || !gameStateResourceId) return;
    const payload = snapshotGameStatePayload();
    const nextHash = JSON.stringify(payload);
    if (nextHash === lastGameStateHash) {
        gameStateDirty = false;
        return;
    }

    //const updated = await scimRequest('PUT', `/Users/${encodeURIComponent(gameStateResourceId)}`, payload);
    if (!updated) return;
    lastGameStateHash = nextHash;
    gameStateDirty = false;
}

async function pushDirtyResources() {
    if (!scimEnabled || !scimInitialized) return;
    if (pushInFlight) {
        queuedPush = true;
        return;
    }

    pushInFlight = true;
    try {
        const ready = await ensureResourcesCreated();
        if (!ready) return;
        await pushPlayerIfDirty();
        await pushGameStateIfDirty();
    } finally {
        pushInFlight = false;
        if (queuedPush) {
            queuedPush = false;
            void pushDirtyResources();
        }
    }
}

export function setScimMapName(mapName) {
    if (typeof mapName === 'string' && mapName.length > 0) {
        currentMapName = mapName;
        markPlayerDirty();
        markGameStateDirty();
    }
}

export async function initScimPush(initialMapName = 'E1M1') {
    scimBaseUrl = resolveScimBaseUrl();
    scimToken = import.meta.env.VITE_SCIM_BEARER_TOKEN || '';
    scimEnabled = Boolean(scimBaseUrl && scimToken);
    if (!scimEnabled) return;

    correlationId = getOrCreateCorrelationId();
    setScimMapName(initialMapName);
    playerDirty = true;
    gameStateDirty = true;
    scimInitialized = true;
    heartbeatElapsed = 0;

    await pushDirtyResources();
}

export function markPlayerDirty() {
    if (!scimEnabled || !scimInitialized) return;
    playerDirty = true;
}

export function markGameStateDirty() {
    if (!scimEnabled || !scimInitialized) return;
    gameStateDirty = true;
}

export function markAllScimDirty() {
    markPlayerDirty();
    markGameStateDirty();
}

export async function flushScimNow() {
    if (!scimEnabled || !scimInitialized) return;
    heartbeatElapsed = 0;
    await pushDirtyResources();
}

export function tickScimHeartbeat(deltaTime) {
    if (!scimEnabled || !scimInitialized) return;
    heartbeatElapsed += deltaTime;
    if (heartbeatElapsed < HEARTBEAT_SECONDS) return;
    heartbeatElapsed = 0;

    if (playerDirty || gameStateDirty) {
        void pushDirtyResources();
    }
}
