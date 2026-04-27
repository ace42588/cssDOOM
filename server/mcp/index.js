/**
 * Embedded MCP server for the cssDOOM multiplayer host.
 *
 * Mounts the Streamable HTTP transport on the existing Node `httpServer`
 * at the `/mcp` path. Each MCP client connection gets its own
 * `McpServer` instance + a fresh game session in `server/connections.js`,
 * so MCP-driven agents become real peers in the multiplayer world
 * alongside human WebSocket clients.
 *
 * The same factory is exported for stdio use by `stdio-bridge.js`.
 */

import { randomUUID, createHash } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { openMcpSession, closeMcpSession } from './sessions.js';
import { registerWorldTools } from './tools/world.js';
import { registerPlayerTools } from './tools/players.js';
import { registerActorTools } from './tools/actor.js';
import { registerEnemyTools } from './tools/enemies.js';
import { registerDoorTools } from './tools/doors.js';
import { registerStaticResources } from './resources.js';
import { registerPrompts } from './prompts.js';
import { registerSessionTools } from './tools/session.js';
import {
    registerMcpServerForSession,
    unregisterMcpServerForSession,
} from './server-registry.js';
import {
    registerMcpTransportForGameSession,
    unregisterMcpTransportForGameSession,
} from './http-transport-by-game.js';

const DEFAULT_PATH = '/mcp';

const SERVER_INFO = {
    name: 'cssdoom-mcp',
    title: 'cssDOOM Game MCP',
    version: '0.1.0',
};

const SERVER_INSTRUCTIONS = `Drive a peer actor session in cssDOOM multiplayer.

Every peer — human WS client or MCP agent — controls one *actor*: the marine, any hostile monster, or a door camera. On connect you are auto-assigned whatever actor is free: the map's player-start body (marine) if available, else any live hostile monster you can displace, else spectator. Use world-get-state to read the unified world (self.controlledActor + actors / doors / players), actor-* to drive your body (move/turn/fire/use), actor-possess to swap bodies (actor:N, thing:N, door:N, or marine/player), actor-list / actor-get-state for the authoritative read of any actor, doors-* for door state, and players-list / players-peers to find other connected players. enemies-list / enemies-get-state remain as convenience wrappers over actor-list ({ kind: 'enemy' }). Read cssdoom://role/current for role guidance after connect or role changes. All actions are input-parity with a human player; the server enforces the same key gates, AI, and possession rules.

Join challenge: If a new player would be a spectator while you (MCP) hold a body, the server may send an MCP form elicitation asking you to defend your position. Respond promptly with a short justification. If your client does not advertise elicitation.form, you decline, or the elicitation times out (see env MCP_DEFENSE_TIMEOUT_MS), you are silently bumped to spectator and the joiner takes the body. Joining MCP clients resolve the choice with session-resolve-join after world-poll-events reports joinChallenge. See cssdoom://docs/join-challenge.

HTTP transport: your client MUST echo the Mcp-Session-Id response header on every subsequent POST/GET/DELETE. If the sessionId field in tool JSON responses changes between consecutive calls, your transport is re-initializing — fix your client. On reconnect within ~60s with the same agent identity (initialize metadata / fingerprint), the server tries to re-attach you to your previous controlled body when it is still free.

WebSocket human clients still get an idle warning at 30s and disconnect at 60s; MCP sessions are not dropped for idleness — they end when the MCP transport closes.

Read the agent guide first via the resource cssdoom://docs/agent-guide. Other reference docs:
  cssdoom://docs/coordinate-system  — angle/axis/distance conventions
  cssdoom://docs/recipes            — copy-pasteable patterns
  cssdoom://docs/gameplay-rules     — what the engine enforces
  cssdoom://docs/tool-index         — full tool list with routing table
  cssdoom://docs/join-challenge     — MCP displacement when the server is full
  cssdoom://role/current            — current body role + behavior hints

Bootstrapping prompts: play-the-game, hunt-a-peer, operate-a-door.`;

/**
 * Build a fresh MCP server bound to a brand-new game session.
 * Returns `{ server, gameSessionId, dispose }`. The caller wires it up to
 * a transport and disposes it on transport close.
 */
export function buildMcpServerForNewSession({ displayName, agentIdentity } = {}) {
    const conn = openMcpSession({ displayName, agentIdentity });
    const sessionId = conn.sessionId;

    const server = new McpServer(SERVER_INFO, {
        instructions: SERVER_INSTRUCTIONS,
        capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false },
            prompts: { listChanged: false },
        },
    });
    registerMcpServerForSession(sessionId, server);

    const ctx = {
        getSessionId: () => sessionId,
    };

    registerWorldTools(server, ctx);
    registerPlayerTools(server, ctx);
    registerActorTools(server, ctx);
    registerEnemyTools(server, ctx);
    registerDoorTools(server, ctx);
    registerSessionTools(server, ctx);
    registerStaticResources(server, ctx);
    registerPrompts(server, ctx);

    return {
        server,
        gameSessionId: sessionId,
        async dispose() {
            unregisterMcpServerForSession(sessionId);
            try { await server.close(); } catch {}
            closeMcpSession(sessionId);
        },
    };
}

// ── HTTP transport mount ──────────────────────────────────────────────

/**
 * mcpSessionId → { transport, mcp } where `mcp` is the result of
 * `buildMcpServerForNewSession`. Stateful mode keeps one transport per
 * MCP client across requests so SSE streams and replay work.
 */
const httpSessions = new Map();

function getBearerToken() {
    const t = process.env.MCP_BEARER_TOKEN;
    return typeof t === 'string' && t.length > 0 ? t : null;
}

function unauthorized(res) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'unauthorized' }));
}

function badRequest(res, message) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: message }));
}

function notFound(res, message) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: message }));
}

/**
 * Mount the MCP HTTP transport onto the given Node httpServer.
 *
 * Returns the path the transport listens at, and a `handleMcpRequest`
 * function the caller is expected to invoke from its existing request
 * handler before any other routing for that path. The wiring order is:
 *
 *   httpServer.on('request', (req, res) => {
 *     if (matchesMcpPath(req)) return handleMcpRequest(req, res);
 *     // ... other routes ...
 *   });
 *
 * This avoids fighting the existing `httpServer = http.createServer((req, res) => …)`
 * handler in `server/index.js` — we just give that handler something to
 * delegate to, instead of trying to add a second `request` listener.
 */
export function installMcp(httpServer, { path = DEFAULT_PATH } = {}) {
    void httpServer; // we only need the request handler hook
    const expectedToken = getBearerToken();

    async function handleMcpRequest(req, res) {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        if (url.pathname !== path) {
            notFound(res, 'mcp path mismatch');
            return;
        }

        if (expectedToken) {
            const auth = req.headers.authorization || '';
            const expected = `Bearer ${expectedToken}`;
            if (auth !== expected) return unauthorized(res);
        }

        const mcpSessionId = req.headers['mcp-session-id'];

        if (req.method === 'POST') {
            const body = await readJsonBody(req);
            if (body === undefined) return badRequest(res, 'expected JSON body');

            // Existing session?
            if (typeof mcpSessionId === 'string' && httpSessions.has(mcpSessionId)) {
                const entry = httpSessions.get(mcpSessionId);
                await entry.transport.handleRequest(req, res, body);
                return;
            }

            // New session must be an `initialize` request.
            if (!isInitializeRequest(body)) {
                return badRequest(res, 'no MCP session — must initialize first');
            }

            await openHttpSession(req, res, body);
            return;
        }

        if (req.method === 'GET' || req.method === 'DELETE') {
            if (typeof mcpSessionId !== 'string' || !httpSessions.has(mcpSessionId)) {
                return notFound(res, 'unknown MCP session');
            }
            const entry = httpSessions.get(mcpSessionId);
            await entry.transport.handleRequest(req, res);
            return;
        }

        res.statusCode = 405;
        res.setHeader('Allow', 'GET, POST, DELETE');
        res.end();
    }

    return { path, handleMcpRequest };
}

async function openHttpSession(req, res, body) {
    const agentIdentity = buildAgentIdentity(req, body);
    const displayName = agentIdentity?.agentName || agentIdentity?.agentId || 'mcp-http';
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
            httpSessions.set(id, { transport, mcp });
        },
        onsessionclosed: async (id) => {
            const entry = httpSessions.get(id);
            httpSessions.delete(id);
            if (entry) {
                unregisterMcpTransportForGameSession(entry.mcp?.gameSessionId);
                try { await entry.mcp.dispose(); } catch {}
            }
        },
    });

    transport.onclose = () => {
        const id = transport.sessionId;
        if (typeof id !== 'string') return;
        const entry = httpSessions.get(id);
        if (!entry) return;
        httpSessions.delete(id);
        unregisterMcpTransportForGameSession(entry.mcp?.gameSessionId);
        void entry.mcp.dispose();
    };

    let mcp;
    try {
        mcp = buildMcpServerForNewSession({ displayName, agentIdentity });
        registerMcpTransportForGameSession(mcp.gameSessionId, transport);
        await mcp.server.connect(transport);
        await transport.handleRequest(req, res, body);
    } catch (err) {
        if (mcp?.gameSessionId) unregisterMcpTransportForGameSession(mcp.gameSessionId);
        throw err;
    }
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

function isInitializeRequest(body) {
    if (Array.isArray(body)) return body.some(isInitializeRequest);
    return Boolean(body && typeof body === 'object' && body.method === 'initialize');
}

function buildAgentIdentity(req, body) {
    const hints = extractIdentityHints(req, body);
    const firstSeenAt = Date.now();
    const fingerprint = buildFingerprint(hints);
    const agentId = cleanString(hints.agentId) || `fp:${fingerprint}`;
    const agentName = cleanString(hints.agentName) || cleanString(hints.clientName) || agentId;
    const runtime = cleanString(hints.runtime) || cleanString(hints.userAgent) || null;

    return {
        source: cleanString(hints.agentId) ? 'client' : 'fingerprint',
        agentId,
        agentName,
        fingerprint,
        runtime,
        clientName: cleanString(hints.clientName) || null,
        clientVersion: cleanString(hints.clientVersion) || null,
        firstSeenAt,
    };
}

function extractIdentityHints(req, body) {
    const initialize = getInitializePayload(body);
    const params = initialize?.params || {};
    const clientInfo = (params && typeof params === 'object' && params.clientInfo && typeof params.clientInfo === 'object')
        ? params.clientInfo
        : {};
    const metadata = readMetadata(params);
    const headers = req?.headers || {};

    return {
        agentId: readCandidate([
            metadata.agentId,
            metadata.agent_id,
            headers['x-mcp-agent-id'],
            headers['x-agent-id'],
        ]),
        agentName: readCandidate([
            metadata.agentName,
            metadata.agent_name,
            headers['x-mcp-agent-name'],
            headers['x-agent-name'],
        ]),
        runtime: readCandidate([
            metadata.runtime,
            metadata.environment,
            headers['x-mcp-runtime'],
        ]),
        clientName: readCandidate([
            clientInfo.name,
            metadata.clientName,
            metadata.client_name,
        ]),
        clientVersion: readCandidate([
            clientInfo.version,
            metadata.clientVersion,
            metadata.client_version,
        ]),
        userAgent: readCandidate([headers['user-agent']]),
        remoteAddress: getRemoteAddress(req),
    };
}

function getInitializePayload(body) {
    if (Array.isArray(body)) {
        for (const entry of body) {
            if (entry && typeof entry === 'object' && entry.method === 'initialize') return entry;
        }
        return null;
    }
    if (body && typeof body === 'object' && body.method === 'initialize') return body;
    return null;
}

function readMetadata(params) {
    if (!params || typeof params !== 'object') return {};
    const roots = [
        params.agent,
        params.metadata,
        params.clientMetadata,
        params._meta,
    ];
    for (const candidate of roots) {
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
            return candidate;
        }
    }
    return {};
}

function readCandidate(values) {
    for (const value of values) {
        const cleaned = cleanString(value);
        if (cleaned) return cleaned;
    }
    return null;
}

function cleanString(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function getRemoteAddress(req) {
    const xff = req?.headers?.['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim().length > 0) {
        const [first] = xff.split(',');
        const candidate = first.trim();
        if (candidate) return candidate;
    }
    return cleanString(req?.socket?.remoteAddress) || 'unknown';
}

function buildFingerprint(hints) {
    const source = [
        hints.remoteAddress || '',
        hints.userAgent || '',
        hints.clientName || '',
        hints.clientVersion || '',
        hints.runtime || '',
    ].join('|');
    return createHash('sha256').update(source).digest('hex').slice(0, 16);
}

