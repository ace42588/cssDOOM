/**
 * Multiplayer game server — HTTP + WebSocket bootstrap.
 *
 * Starts the authoritative world, accepts WS connections, routes inputs
 * into the world's per-session input buffers, and broadcasts snapshots
 * every other tick (~17 Hz). All game logic lives under `../src/game`
 * and runs unchanged here thanks to the renderer/audio/services facades.
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';

import {
    installEngineHosts,
    useGameServices,
    loadMap,
    startLoop,
    buildDeltasForTick,
    buildRoleChangePayload,
    drainPendingRoleChanges,
    queueRoleChange,
    getTickRateHz,
    getMapPayload,
    requestMapLoad,
    resetBaseline,
} from './world.js';
import {
    addConnection,
    bumpActivity,
    removeConnection,
    getConnection,
    listConnections,
    send,
} from './connections.js';
import {
    assignOnJoin,
    releaseOnDisconnect,
} from './assignment.js';
import { sanitizeInput, MSG, ALLOWED_MAPS } from './net.js';
import {
    createSgnlServices,
    registerSession,
    unregisterSession,
    emitSessionEstablished,
    initSgnl,
} from './sgnl/index.js';
import { installMcp } from './mcp/index.js';

const PORT = Number(process.env.PORT) || 8787;

function hasMeaningfulInputActivity(prev, next) {
    const hasNonZeroAxis = (
        next.moveX !== 0
        || next.moveY !== 0
        || next.turn !== 0
        || next.turnDelta !== 0
    );
    if (hasNonZeroAxis) return true;
    if (prev.run !== next.run) return true;
    if (prev.fireHeld !== next.fireHeld) return true;
    if (prev.use !== next.use) return true;
    if (prev.switchWeapon !== next.switchWeapon) return true;
    if ((prev.bodySwap?.targetId ?? null) !== (next.bodySwap?.targetId ?? null)) return true;
    if (
        (prev.doorDecision?.sectorIndex ?? null) !== (next.doorDecision?.sectorIndex ?? null)
        || (prev.doorDecision?.requestId ?? null) !== (next.doorDecision?.requestId ?? null)
        || (prev.doorDecision?.decision ?? null) !== (next.doorDecision?.decision ?? null)
    ) {
        return true;
    }
    return false;
}

async function main() {
    installEngineHosts();
    useGameServices(createSgnlServices());
    await loadMap('E1M1');
    void initSgnl('E1M1');

    let mcp = null;
    const httpServer = http.createServer((req, res) => {
        if (req.url === '/healthz') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('ok');
            return;
        }
        if (mcp && req.url && new URL(req.url, 'http://x').pathname === mcp.path) {
            void mcp.handleMcpRequest(req, res);
            return;
        }
        res.writeHead(404);
        res.end();
    });

    const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
    wss.on('connection', handleConnection);

    mcp = installMcp(httpServer);

    startLoop({ onTick: ({ shouldSnapshot }) => {
        if (!shouldSnapshot) return;
        broadcastSnapshot();
    }});

    httpServer.listen(PORT, () => {
        // eslint-disable-next-line no-console
        console.log(`[server] cssDOOM multiplayer listening on :${PORT}  (ws /ws, mcp ${mcp.path}, tickRate ${getTickRateHz()} Hz)`);
    });
}

function handleConnection(ws) {
    const conn = addConnection(ws);
    registerSession(conn.sessionId);
    emitSessionEstablished(conn.sessionId);
    const { role, controlledId, followTargetId } = assignOnJoin(conn);
    conn.role = role;
    conn.controlledId = controlledId;
    conn.followTargetId = followTargetId;

    const { name: mapName, mapData } = getMapPayload();
    send(conn, {
        type: MSG.WELCOME,
        sessionId: conn.sessionId,
        role: conn.role,
        controlledId: conn.controlledId,
        followTargetId: conn.followTargetId,
        mapName,
        tickRateHz: getTickRateHz(),
        serverTime: Date.now(),
    });
    send(conn, { type: MSG.MAP_LOAD, mapName, mapData });

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); }
        catch { return; }
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === MSG.INPUT) {
            const seq = Number(msg.seq) || 0;
            if (seq < conn.lastInputSeq) return;
            conn.lastInputSeq = seq;
            const nextInput = sanitizeInput(msg.input);
            if (hasMeaningfulInputActivity(conn.input, nextInput)) {
                bumpActivity(conn);
            }
            conn.input = nextInput;
            return;
        }

        if (msg.type === MSG.LOAD_MAP_REQUEST) {
            const requested = typeof msg.mapName === 'string' ? msg.mapName : '';
            if (!ALLOWED_MAPS.has(requested)) return;
            bumpActivity(conn);
            void requestMapLoad(requested);
            return;
        }

        if (msg.type === MSG.MAP_LOAD_COMPLETE) {
            // Client finished rebuilding its scene from the most recent
            // mapLoad. Wipe any baseline accrued from snapshots the
            // client may have ignored during the rebuild window so the
            // next tick lands as a clean full-state delta.
            conn.pendingMapLoad = false;
            resetBaseline(conn);
            bumpActivity(conn);
            return;
        }
    });

    ws.on('close', () => {
        const existing = getConnection(conn.sessionId);
        if (!existing) return;
        releaseOnDisconnect(existing);
        removeConnection(conn.sessionId);
        unregisterSession(conn.sessionId);
    });

    ws.on('error', () => {
        // `close` will fire afterwards and do the cleanup.
    });
}

function broadcastSnapshot() {
    const buildDelta = buildDeltasForTick();
    for (const conn of listConnections()) {
        // While a connection is mid-mapLoad we MUST NOT advance its
        // baseline: the client is rebuilding its scene and silently
        // dropping incoming snapshots. Sending+committing a delta here
        // would leave the server convinced the client knows state X
        // when in fact the next snapshot the client actually applies
        // would only contain diffs against X — hiding spawn-time
        // values like player.z / floorHeight forever.
        if (conn.pendingMapLoad) continue;
        send(conn, buildDelta(conn));
    }
    // Role-change announcements remain explicit: the snapshot delta does
    // also carry role/controlledId/followTargetId when they flip, but the
    // menu/spectator UI still listens for the dedicated `roleChange`
    // message as the authoritative event.
    for (const sessionId of drainPendingRoleChanges()) {
        const conn = getConnection(sessionId);
        if (!conn) continue;
        // If the conn is still rebuilding from a mapLoad, hold the role
        // change for the next broadcast — the client wouldn't apply it
        // anyway and we'd lose the announcement on drain.
        if (conn.pendingMapLoad) {
            queueRoleChange(sessionId);
            continue;
        }
        send(conn, buildRoleChangePayload(conn));
    }
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[server] fatal', err);
    process.exit(1);
});
