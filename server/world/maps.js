import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { currentMap } from '../../src/data/maps.js';
import {
    getNextMap,
    getSecretExitMap,
    loadMapHeadless,
} from '../../src/game/lifecycle.js';
import {
    assignOnJoin,
    getPendingMarinePromotionSessionId,
} from '../assignment.js';
import { startChallenge } from '../join-challenge.js';
import { listConnections } from '../connections.js';
import { MSG } from '../net.js';
import { send } from '../connections.js';
import {
    findMarineControllerSessionId,
    queueRoleChange,
} from './roles.js';
import { cancelAllChallenges } from '../join-challenge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MAP_DIR = path.resolve(__dirname, '..', '..', 'public', 'maps');

let rendererHost = null;
let audioHost = null;
let currentMapData = null;
let exitInFlight = false;

export function setMapLoadEventHosts(hosts = {}) {
    rendererHost = hosts.rendererHost || null;
    audioHost = hosts.audioHost || null;
}

export async function loadMap(name = 'E1M1', options = {}) {
    currentMapData = await readMapJson(name);
    await loadMapHeadless(name, async () => currentMapData, options);
    rendererHost?.discardEvents?.();
    audioHost?.discardSounds?.();
    return { name: currentMap || name, mapData: currentMapData };
}

export function getMapPayload() {
    return { name: currentMap, mapData: currentMapData };
}

async function readMapJson(name) {
    const file = path.join(MAP_DIR, `${name}.json`);
    const buf = await readFile(file, 'utf8');
    return JSON.parse(buf);
}

export async function handleSwitchExit(action) {
    if (!action) return;
    if (exitInFlight) return;
    if (action.kind !== 'exit' && action.kind !== 'secretExit') return;
    const nextMap = action.kind === 'secretExit' ? getSecretExitMap() : getNextMap();
    if (!nextMap) return;
    exitInFlight = true;
    try {
        await runLevelTransition(nextMap, { fullReset: false });
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[server] switch-triggered map load failed', err);
    } finally {
        exitInFlight = false;
    }
}

export async function requestMapLoad(name) {
    if (typeof name !== 'string' || !name) return;
    if (exitInFlight) return;
    exitInFlight = true;
    try {
        await runLevelTransition(name, { fullReset: false });
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[server] menu-triggered map load failed', err);
    } finally {
        exitInFlight = false;
    }
}

/**
 * Hard reset: reload the currently loaded map with `fullReset: true`
 * (marine inventory/health reset, all things respawned). Keeps connections;
 * re-runs join assignment like a map change.
 *
 * @returns {Promise<{ ok: true, mapName: string } | { ok: false, reason: 'transition-in-flight' }>}
 */
export async function resetCurrentMap() {
    if (exitInFlight) {
        return { ok: false, reason: 'transition-in-flight' };
    }
    const name = currentMap;
    if (typeof name !== 'string' || !name) {
        return { ok: false, reason: 'no-map' };
    }
    exitInFlight = true;
    try {
        await runLevelTransition(name, { fullReset: true });
        return { ok: true, mapName: name };
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[server] admin hard reset failed', err);
        throw err;
    } finally {
        exitInFlight = false;
    }
}

async function runLevelTransition(nextMap, loadOptions) {
    const prevMarineSessionId = findMarineControllerSessionId();
    const promotedSessionId = getPendingMarinePromotionSessionId();
    const { name: mapName, mapData } = await loadMap(nextMap, loadOptions);
    cancelAllChallenges();

    // Assignment order: killer-promoted session first (so they win the
    // marine spot), then the previous marine controller (so sticky MCP
    // reconnects still keep their body on a non-death reset), then
    // everyone else in connection order.
    const all = [...listConnections()];
    const headIds = [];
    if (promotedSessionId) headIds.push(promotedSessionId);
    if (prevMarineSessionId && prevMarineSessionId !== promotedSessionId) {
        headIds.push(prevMarineSessionId);
    }
    const head = headIds
        .map((sid) => all.find((c) => c.sessionId === sid))
        .filter(Boolean);
    const others = all.filter((c) => !headIds.includes(c.sessionId));
    for (const conn of [...head, ...others]) {
        const assignment = assignOnJoin(conn);
        conn.role = assignment.role;
        conn.controlledId = assignment.controlledId;
        conn.followTargetId = assignment.followTargetId;
        queueRoleChange(conn.sessionId);
        if (assignment.displaceCandidate) {
            startChallenge(conn, assignment.displaceCandidate);
        }
    }

    for (const conn of listConnections()) {
        conn.pendingMapLoad = true;
        send(conn, { type: MSG.MAP_LOAD, mapName, mapData });
    }
}
