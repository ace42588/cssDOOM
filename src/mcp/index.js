/**
 * WebMCP entry point.
 *
 * Registers the browser-side tools that let AI agents drive the game
 * through the W3C `navigator.modelContext` interface.
 *
 * The tools are strictly input-parity with a human player: every mutation
 * travels through the existing WebSocket input channel to the authoritative
 * server (`sendInputFrame()` in `src/net/client.js`). Nothing here mutates
 * server-owned state directly, so the same validation, key gates, AI, and
 * (optionally) SGNL evaluations a human player sees apply to agents too.
 *
 * Chrome 146+ ships `navigator.modelContext` natively behind a flag. For
 * every other browser we lazy-install `@mcp-b/webmcp-polyfill` so the
 * same `registerTool()` surface is available.
 */

import { initMcpInputSource } from './input-source.js';
import { registerMarineTools } from './tools/marine.js';
import { registerEnemyTools } from './tools/enemies.js';
import { registerDoorTools } from './tools/doors.js';

let initialized = false;

/**
 * Initialize the WebMCP interface. Idempotent; safe to call from the app
 * entry point. Returns a promise so callers can await the polyfill load if
 * they care.
 */
export async function initMcpInterface() {
    if (initialized) return;
    initialized = true;

    if (typeof navigator === 'undefined') return;

    if (!('modelContext' in navigator)) {
        try {
            const mod = await import('@mcp-b/webmcp-polyfill');
            mod.initializeWebMCPPolyfill();
        } catch (err) {
            console.warn('[mcp] WebMCP polyfill failed to load; MCP tools disabled.', err);
            return;
        }
    }

    if (!('modelContext' in navigator)) {
        console.warn('[mcp] navigator.modelContext still unavailable after polyfill; MCP tools disabled.');
        return;
    }

    initMcpInputSource();

    try {
        registerMarineTools();
        registerEnemyTools();
        registerDoorTools();
    } catch (err) {
        console.warn('[mcp] failed to register tools', err);
        return;
    }

    if (typeof console !== 'undefined') {
        const count = navigator.modelContextTesting?.listTools?.().length;
        console.log(`[mcp] WebMCP tools registered${typeof count === 'number' ? ` (${count})` : ''}.`);
    }
}
