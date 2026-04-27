/**
 * Maps game `sessionId` (Connection id) → MCP Streamable HTTP transport so
 * admin code can close the transport without importing `mcp/index.js`
 * (avoids circular imports with `session-lifecycle.js`).
 *
 * Only HTTP MCP sessions call `registerMcpTransportForGameSession`; stdio
 * MCP and other headless clients are never registered here.
 */

/** @type {Map<string, { close: () => void }>} */
const transportByGameSessionId = new Map();

export function registerMcpTransportForGameSession(gameSessionId, transport) {
    if (typeof gameSessionId === 'string' && gameSessionId && transport && typeof transport.close === 'function') {
        transportByGameSessionId.set(gameSessionId, transport);
    }
}

export function unregisterMcpTransportForGameSession(gameSessionId) {
    if (typeof gameSessionId === 'string' && gameSessionId) {
        transportByGameSessionId.delete(gameSessionId);
    }
}

/**
 * Close the MCP HTTP transport for this game session, if any.
 * @returns {boolean} true if a transport was found and close() was invoked
 */
export function closeMcpHttpSessionForGameSession(gameSessionId) {
    if (typeof gameSessionId !== 'string' || !gameSessionId) return false;
    const transport = transportByGameSessionId.get(gameSessionId);
    if (!transport) return false;
    transportByGameSessionId.delete(gameSessionId);
    try { transport.close(); } catch {}
    return true;
}
