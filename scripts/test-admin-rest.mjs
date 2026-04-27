/**
 * Smoke test for the admin REST API (bearer auth, reads, reset, kill session, door mode).
 *
 * Run: node scripts/test-admin-rest.mjs
 */

import assert from 'node:assert/strict';
import http from 'node:http';

import { WebSocket, WebSocketServer } from 'ws';

import {
    installEngineHosts,
    useGameServices,
    loadMap,
    startLoop,
    stopLoop,
} from '../server/world.js';
import { createSgnlServices } from '../server/sgnl/index.js';
import { getDoorControlMode } from '../server/settings/door-control.js';
import { installAdmin } from '../server/admin/index.js';
import { openWebSocketGameSession } from '../server/session-lifecycle.js';
import { MSG } from '../server/net.js';
import { getConnection } from '../server/connections.js';
import { DOOR_CONTROL_MODE } from '../src/game/constants.js';

const TOKEN = 'test-admin-bearer-token-for-ci';

async function jsonFetch(port, path, { method = 'GET', headers = {}, body } = {}) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
            ...headers,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; }
    catch { data = text; }
    return { res, data };
}

async function main() {
    const prevAdmin = process.env.ADMIN_BEARER_TOKEN;
    process.env.ADMIN_BEARER_TOKEN = TOKEN;

    installEngineHosts();
    useGameServices({ ...createSgnlServices(), getDoorControlMode });
    await loadMap('E1M1');

    const admin = installAdmin(null);
    const httpServer = http.createServer((req, res) => {
        if (req.url === '/healthz') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('ok');
            return;
        }
        if (req.url) {
            const pathname = new URL(req.url, 'http://x').pathname;
            if (pathname === admin.path || pathname.startsWith(`${admin.path}/`)) {
                void admin.handleAdminRequest(req, res);
                return;
            }
        }
        res.writeHead(404);
        res.end();
    });

    const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
    wss.on('connection', (ws) => {
        openWebSocketGameSession(ws);
    });

    startLoop({ onTick: () => {} });

    const { port, closeAll } = await new Promise((resolve, reject) => {
        httpServer.listen(0, () => {
            try {
                const addr = httpServer.address();
                const p = typeof addr === 'object' && addr ? addr.port : null;
                if (!p) throw new Error('no port');
                resolve({
                    port: p,
                    closeAll: () => new Promise((res) => {
                        stopLoop();
                        wss.close(() => {
                            httpServer.close(() => res());
                        });
                    }),
                });
            } catch (e) { reject(e); }
        });
        httpServer.on('error', reject);
    });

    const auth = { Authorization: `Bearer ${TOKEN}` };

    try {
        const noAuth = await jsonFetch(port, '/admin/world');
        assert.equal(noAuth.res.status, 401);

        const badAuth = await jsonFetch(port, '/admin/world', {
            headers: { Authorization: 'Bearer wrong-token' },
        });
        assert.equal(badAuth.res.status, 401);

        const prev = process.env.ADMIN_BEARER_TOKEN;
        delete process.env.ADMIN_BEARER_TOKEN;
        const disabled = await jsonFetch(port, '/admin/world', { headers: auth });
        assert.equal(disabled.res.status, 503);
        assert.equal(disabled.data?.error, 'admin api disabled');
        process.env.ADMIN_BEARER_TOKEN = prev;

        const world = await jsonFetch(port, '/admin/world', { headers: auth });
        assert.equal(world.res.status, 200);
        assert.equal(world.data.mapName, 'E1M1');
        assert.ok(Array.isArray(world.data.players));
        assert.equal(world.data.self, null);
        assert.ok(Array.isArray(world.data.actors));
        assert.ok(Array.isArray(world.data.doors));

        const players = await jsonFetch(port, '/admin/players', { headers: auth });
        assert.equal(players.res.status, 200);
        assert.ok(Array.isArray(players.data.players));
        assert.ok(players.data.players.every((p) => p.self === false));

        const entities = await jsonFetch(port, '/admin/entities', { headers: auth });
        assert.equal(entities.res.status, 200);
        assert.ok(Array.isArray(entities.data.actors));
        assert.ok(entities.data.actors.some((a) => a.kind === 'marine'));
        assert.ok(Array.isArray(entities.data.doors));

        const badDoor = await jsonFetch(port, '/admin/door-control-mode', {
            method: 'PUT',
            headers: auth,
            body: { mode: 'not-a-mode' },
        });
        assert.equal(badDoor.res.status, 400);

        const orig = getDoorControlMode();
        const other = orig === DOOR_CONTROL_MODE.PLAYER ? DOOR_CONTROL_MODE.STANDARD : DOOR_CONTROL_MODE.PLAYER;
        const putDoor = await jsonFetch(port, '/admin/door-control-mode', {
            method: 'PUT',
            headers: auth,
            body: { mode: other },
        });
        assert.equal(putDoor.res.status, 200);
        assert.equal(putDoor.data.mode, other);
        const getDoor = await jsonFetch(port, '/admin/door-control-mode', { headers: auth });
        assert.equal(getDoor.res.status, 200);
        assert.equal(getDoor.data.mode, other);
        await jsonFetch(port, '/admin/door-control-mode', {
            method: 'PUT',
            headers: auth,
            body: { mode: orig },
        });

        const { sessionId, ws } = await new Promise((resolve, reject) => {
            const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`);
            const t = setTimeout(() => reject(new Error('ws timeout')), 5000);
            sock.on('message', (raw) => {
                let msg;
                try { msg = JSON.parse(raw.toString()); }
                catch { return; }
                if (msg?.type === MSG.WELCOME) {
                    clearTimeout(t);
                    resolve({ sessionId: msg.sessionId, ws: sock });
                }
            });
            sock.on('error', (e) => {
                clearTimeout(t);
                reject(e);
            });
        });
        assert.ok(typeof sessionId === 'string');
        assert.ok(getConnection(sessionId));

        const del = await jsonFetch(port, `/admin/sessions/${encodeURIComponent(sessionId)}`, {
            method: 'DELETE',
            headers: auth,
        });
        assert.equal(del.res.status, 200);
        assert.equal(del.data.ok, true);
        assert.equal(del.data.sessionId, sessionId);

        for (let i = 0; i < 50; i++) {
            if (!getConnection(sessionId)) break;
            await new Promise((r) => setTimeout(r, 10));
        }
        assert.equal(getConnection(sessionId), null);
        ws.terminate();

        await new Promise((r) => setTimeout(r, 20));

        const bogus = await jsonFetch(port, '/admin/sessions/00000000-0000-4000-8000-000000000000', {
            method: 'DELETE',
            headers: auth,
        });
        assert.equal(bogus.res.status, 404);

        const countEnemies = (list) => list.filter((a) => a && a.kind !== 'marine').length;
        const beforeEnemies = countEnemies(entities.data.actors);
        const reset = await jsonFetch(port, '/admin/reset', { method: 'POST', headers: auth });
        assert.equal(reset.res.status, 200);
        assert.equal(reset.data.ok, true);
        const entitiesAfter = await jsonFetch(port, '/admin/entities', { headers: auth });
        assert.ok(countEnemies(entitiesAfter.data.actors) >= beforeEnemies);
    } finally {
        await closeAll();
        if (prevAdmin === undefined) delete process.env.ADMIN_BEARER_TOKEN;
        else process.env.ADMIN_BEARER_TOKEN = prevAdmin;
    }

    // eslint-disable-next-line no-console
    console.log('admin REST smoke tests passed');
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
});
