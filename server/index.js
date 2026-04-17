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
    buildSnapshotBatch,
    buildRoleChangePayload,
    drainPendingRoleChanges,
    getTickRateHz,
    getMapPayload,
} from './world.js';
import {
    addConnection,
    removeConnection,
    getConnection,
    listConnections,
    send,
} from './connections.js';
import {
    assignOnJoin,
    releaseOnDisconnect,
} from './assignment.js';
import { sanitizeInput, MSG } from './net.js';
import {
    createSgnlServices,
    registerSession,
    unregisterSession,
    emitSessionEstablished,
    initSgnl,
} from './sgnl/index.js';

const PORT = Number(process.env.PORT) || 8787;

async function main() {
    installEngineHosts();
    useGameServices(createSgnlServices());
    await loadMap('E1M1');
    void initSgnl('E1M1');

    const httpServer = http.createServer((req, res) => {
        if (req.url === '/healthz') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('ok');
            return;
        }
        res.writeHead(404);
        res.end();
    });

    const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
    wss.on('connection', handleConnection);

    startLoop({ onTick: ({ shouldSnapshot }) => {
        if (!shouldSnapshot) return;
        broadcastSnapshot();
    }});

    httpServer.listen(PORT, () => {
        // eslint-disable-next-line no-console
        console.log(`[server] cssDOOM multiplayer listening on :${PORT}  (ws /ws, tickRate ${getTickRateHz()} Hz)`);
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
            conn.input = sanitizeInput(msg.input);
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
    const snapshotFor = buildSnapshotBatch();
    for (const conn of listConnections()) {
        send(conn, snapshotFor(conn));
    }
    for (const sessionId of drainPendingRoleChanges()) {
        const conn = getConnection(sessionId);
        if (!conn) continue;
        send(conn, buildRoleChangePayload(conn));
    }
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[server] fatal', err);
    process.exit(1);
});
