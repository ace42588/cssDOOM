#!/usr/bin/env node
/**
 * Stdio MCP bridge.
 *
 * Spawned by agent runtimes that can only talk to stdio MCP servers
 * (Claude Desktop, Cursor stdio configs, etc.). It opens a single MCP
 * client connection to the running game server's HTTP MCP endpoint and
 * proxies JSON-RPC frames in both directions.
 *
 * The game server is the single source of truth — we never spawn a fresh
 * game instance per stdio agent, because cssDOOM is a multiplayer host
 * and every agent should be a peer in the same world.
 *
 * Env:
 *   MCP_HTTP_URL    — defaults to http://localhost:8787/mcp
 *   MCP_BEARER_TOKEN — sent as Authorization: Bearer <token> if set
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const TARGET_URL = process.env.MCP_HTTP_URL || 'http://localhost:8787/mcp';
const TOKEN = process.env.MCP_BEARER_TOKEN || null;

async function main() {
    const upstream = new StreamableHTTPClientTransport(new URL(TARGET_URL), {
        requestInit: TOKEN ? { headers: { Authorization: `Bearer ${TOKEN}` } } : undefined,
    });
    const downstream = new StdioServerTransport(process.stdin, process.stdout);

    let closed = false;
    function shutdown(reason) {
        if (closed) return;
        closed = true;
        try { upstream.close(); } catch {}
        try { downstream.close(); } catch {}
        if (reason instanceof Error) {
            process.stderr.write(`mcp-stdio-bridge: ${reason.message}\n`);
        }
    }

    upstream.onmessage = (msg) => {
        downstream.send(msg).catch(shutdown);
    };
    upstream.onerror = (err) => {
        process.stderr.write(`mcp-stdio-bridge upstream error: ${err.message}\n`);
    };
    upstream.onclose = () => shutdown(new Error('upstream closed'));

    downstream.onmessage = (msg) => {
        upstream.send(msg).catch(shutdown);
    };
    downstream.onerror = (err) => {
        process.stderr.write(`mcp-stdio-bridge downstream error: ${err.message}\n`);
    };
    downstream.onclose = () => shutdown();

    await upstream.start();
    await downstream.start();

    process.on('SIGINT', () => shutdown());
    process.on('SIGTERM', () => shutdown());
}

main().catch((err) => {
    process.stderr.write(`mcp-stdio-bridge fatal: ${err?.stack || err}\n`);
    process.exit(1);
});
