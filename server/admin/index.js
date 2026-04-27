/**
 * Bearer-authenticated admin REST API (not exposed via MCP).
 */

import { timingSafeEqual } from 'node:crypto';

import {
    snapshotWorld,
    listPlayers,
    listActors,
    listDoors,
} from '../views/world.js';
import { resetCurrentMap } from '../world/maps.js';
import { terminateSession } from '../session-lifecycle.js';
import {
    getDoorControlMode,
    setDoorControlMode,
} from '../settings/door-control.js';
import { DOOR_CONTROL_MODE } from '../../src/game/constants.js';

const DEFAULT_PATH = '/admin';

const VALID_DOOR_MODES = new Set(Object.values(DOOR_CONTROL_MODE));

function getAdminBearerToken() {
    const t = process.env.ADMIN_BEARER_TOKEN;
    return typeof t === 'string' && t.length > 0 ? t : null;
}

function sendJson(res, status, body) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
}

function timingSafeBearerEqual(expected, received) {
    try {
        const a = Buffer.from(expected, 'utf8');
        const b = Buffer.from(received, 'utf8');
        if (a.length !== b.length) return false;
        return timingSafeEqual(a, b);
    } catch {
        return false;
    }
}

function extractBearer(authorizationHeader) {
    if (typeof authorizationHeader !== 'string') return null;
    const m = /^Bearer\s+(\S+)$/i.exec(authorizationHeader.trim());
    return m ? m[1] : null;
}

function adminDisabled(res) {
    sendJson(res, 503, { error: 'admin api disabled' });
}

function unauthorized(res) {
    sendJson(res, 401, { error: 'unauthorized' });
}

function notFound(res, message = 'not found') {
    sendJson(res, 404, { error: message });
}

async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    if (chunks.length === 0) return undefined;
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw.length === 0) return undefined;
    try { return JSON.parse(raw); } catch { return undefined; }
}

/**
 * Mount admin HTTP handling. Caller delegates matching requests to
 * `handleAdminRequest` (same pattern as `installMcp`).
 *
 * @returns {{ path: string, handleAdminRequest: (req: import('http').IncomingMessage, res: import('http').ServerResponse) => Promise<void> }}
 */
export function installAdmin(_httpServer, { path = DEFAULT_PATH } = {}) {
    void _httpServer;

    async function handleAdminRequest(req, res) {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        if (url.pathname !== path && !url.pathname.startsWith(`${path}/`)) {
            notFound(res, 'admin path mismatch');
            return;
        }

        const expectedToken = getAdminBearerToken();
        if (!expectedToken) {
            adminDisabled(res);
            return;
        }

        const token = extractBearer(req.headers.authorization || '');
        if (!token || !timingSafeBearerEqual(expectedToken, token)) {
            unauthorized(res);
            return;
        }

        const subPath = url.pathname === path ? '/' : url.pathname.slice(path.length);
        const normalized = subPath.startsWith('/') ? subPath : `/${subPath}`;

        try {
            if (req.method === 'GET' && normalized === '/world') {
                sendJson(res, 200, snapshotWorld(null));
                return;
            }
            if (req.method === 'GET' && normalized === '/players') {
                sendJson(res, 200, { players: listPlayers(null) });
                return;
            }
            if (req.method === 'GET' && normalized === '/entities') {
                sendJson(res, 200, {
                    actors: listActors(),
                    doors: listDoors(),
                });
                return;
            }
            if (req.method === 'POST' && normalized === '/reset') {
                const result = await resetCurrentMap();
                if (result.ok) {
                    sendJson(res, 200, { ok: true, mapName: result.mapName });
                    return;
                }
                if (result.reason === 'transition-in-flight') {
                    sendJson(res, 409, { ok: false, reason: result.reason });
                    return;
                }
                sendJson(res, 503, { ok: false, reason: result.reason });
                return;
            }
            if (req.method === 'DELETE' && normalized.startsWith('/sessions/')) {
                const sessionId = decodeURIComponent(normalized.slice('/sessions/'.length));
                if (!sessionId || sessionId.includes('/')) {
                    notFound(res, 'invalid session id');
                    return;
                }
                const killed = terminateSession(sessionId, { reason: 'admin' });
                if (!killed) {
                    notFound(res, 'session not found');
                    return;
                }
                sendJson(res, 200, {
                    ok: true,
                    sessionId: killed.sessionId,
                    kind: killed.kind,
                });
                return;
            }
            if (req.method === 'GET' && normalized === '/door-control-mode') {
                sendJson(res, 200, { mode: getDoorControlMode() });
                return;
            }
            if (req.method === 'PUT' && normalized === '/door-control-mode') {
                const body = await readJsonBody(req);
                const mode = body && typeof body === 'object' ? body.mode : undefined;
                if (typeof mode !== 'string' || !VALID_DOOR_MODES.has(mode)) {
                    sendJson(res, 400, { error: 'invalid or missing mode' });
                    return;
                }
                try {
                    setDoorControlMode(mode);
                } catch (e) {
                    sendJson(res, 400, { error: String(e?.message || e) });
                    return;
                }
                sendJson(res, 200, { mode: getDoorControlMode() });
                return;
            }
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[admin] handler error', err);
            sendJson(res, 500, { error: 'internal error' });
            return;
        }

        res.statusCode = 405;
        res.setHeader('Allow', 'GET, POST, PUT, DELETE');
        res.end();
    }

    return { path, handleAdminRequest };
}
