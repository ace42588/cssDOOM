/**
 * CAEP Session Established emitter — server-side.
 *
 * Pushes an unsigned SET (JWT alg:none) describing a newly-established
 * session to the configured CAEP receiver. Unlike the browser flavour,
 * the server emits one event per WebSocket connection, identified by an
 * opaque session id (or an email pulled from config / per-session
 * metadata).
 *
 * Env:
 *   CAEP_RECEIVER_URL   — full URL to POST the SET to
 *   CAEP_BEARER_TOKEN   — Bearer token in the Authorization header
 *   CAEP_SET_ISS        — optional `iss` claim (default: https://cssdoom.local)
 *   CAEP_SET_AUD        — optional `aud` claim (default: https://sgnl.ai)
 *   CAEP_SUBJECT_EMAIL  — optional default subject email (email-format sub_id)
 */

import { randomUUID } from 'node:crypto';

const CAEP_SESSION_ESTABLISHED =
    'https://schemas.openid.net/secevent/caep/event-type/session-established';

function b64urlUtf8(str) {
    return Buffer.from(str, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function buildUnsignedSetJwt(payloadObj) {
    const header = { alg: 'none', typ: 'JWT' };
    return `${b64urlUtf8(JSON.stringify(header))}.${b64urlUtf8(JSON.stringify(payloadObj))}.`;
}

/**
 * Emit a CAEP `session-established` event for one subject.
 * `subject` may be `{ email }` or `{ opaqueId }`. No-op if env is missing.
 */
export async function emitCaepSessionEstablished(subject = {}) {
    const url = process.env.CAEP_RECEIVER_URL || '';
    const token = process.env.CAEP_BEARER_TOKEN || '';
    if (!url || !token) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const iss = process.env.CAEP_SET_ISS || 'https://cssdoom.local';
    const aud = process.env.CAEP_SET_AUD || 'https://sgnl.ai';

    const email = subject.email || process.env.CAEP_SUBJECT_EMAIL?.trim();
    const sub_id = email
        ? { format: 'email', email }
        : { format: 'opaque', id: subject.opaqueId || randomUUID() };

    const payload = {
        iss,
        aud,
        iat: nowSec,
        jti: randomUUID(),
        txn: 8675309,
        sub_id,
        events: {
            [CAEP_SESSION_ESTABLISHED]: {
                event_timestamp: nowSec,
            },
        },
    };

    const body = buildUnsignedSetJwt(payload);

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            },
            body,
        });
        if (!res.ok) {
            const errorText = await res.text().catch(() => '');
            console.warn('[caep] session-established push failed', res.status, errorText);
        }
    } catch (error) {
        console.warn('[caep] session-established push error', error?.message || error);
    }
}
