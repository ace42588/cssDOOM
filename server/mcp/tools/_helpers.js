/**
 * Shared response/error helpers for MCP tools.
 */

import { bumpActivity, getConnection } from '../../connections.js';

export function textResult(obj, sessionId = null) {
    const payload = { ...obj, sessionId: sessionId ?? null };
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

export function ok(extra = {}, sessionId = null) {
    return textResult({ ok: true, ...extra }, sessionId);
}

export function err(reason, extra = {}, sessionId = null) {
    return textResult({ ok: false, reason, ...extra }, sessionId);
}

/**
 * Resolve the calling session's `Connection`. Tools that mutate input use
 * this to find the conn whose `input` they should write into.
 */
export function requireConn(sessionId) {
    if (!sessionId) {
        return { conn: null, error: err('no session id bound to this MCP call', {}, null) };
    }
    const conn = getConnection(sessionId);
    if (!conn) {
        return { conn: null, error: err('session no longer connected', {}, sessionId) };
    }
    bumpActivity(conn);
    return { conn, error: null };
}
