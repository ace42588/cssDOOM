/**
 * Maps game `sessionId` (Connection id) → live `McpServer` wrapper so server
 * code can call `server.server.elicitInput` for join challenges without a
 * circular import with `server/mcp/index.js`.
 */

/** @type {Map<string, import('@modelcontextprotocol/sdk/server/mcp.js').McpServer>} */
const mcpServersByGameSessionId = new Map();

export function registerMcpServerForSession(gameSessionId, mcpServer) {
    if (typeof gameSessionId === 'string' && gameSessionId && mcpServer) {
        mcpServersByGameSessionId.set(gameSessionId, mcpServer);
    }
}

export function unregisterMcpServerForSession(gameSessionId) {
    if (typeof gameSessionId === 'string' && gameSessionId) {
        mcpServersByGameSessionId.delete(gameSessionId);
    }
}

/** @returns {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer|null} */
export function getMcpServer(gameSessionId) {
    if (typeof gameSessionId !== 'string' || !gameSessionId) return null;
    return mcpServersByGameSessionId.get(gameSessionId) || null;
}
