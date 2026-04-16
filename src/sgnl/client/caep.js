/**
 * Push a CAEP Session Established SET to an SGNL (or other SSF) receiver.
 * Configure VITE_CAEP_RECEIVER_URL and VITE_CAEP_BEARER_TOKEN in `.env` (Vite exposes only `VITE_*`).
 * Optional: VITE_CAEP_SET_ISS (default: location.origin), VITE_CAEP_SET_AUD (default: https://sgnl.ai).
 * Optional: VITE_CAEP_SUBJECT_EMAIL — if set, sub_id / event.subject use email format (matches SGNL CAEP JSONPath defaults).
 *
 * Local dev: the receiver URL is not called from the browser (avoids CORS). Vite proxies POST /__caep/ssf
 * to VITE_CAEP_RECEIVER_URL. For `vite preview` on localhost, set VITE_CAEP_USE_LOCAL_PROXY=true.
 * Production: set VITE_CAEP_USE_DIRECT_URL=true if the app origin is allowed by the receiver; otherwise
 * terminate TLS at your own host and proxy the same path server-side.
 */

const CAEP_PROXY_PATH = '/__caep/ssf';

function resolveCaepPostUrl() {
    const direct = import.meta.env.VITE_CAEP_RECEIVER_URL;
    if (!direct) return '';
    if (import.meta.env.VITE_CAEP_USE_DIRECT_URL === 'true') return direct;
    const useViteProxy =
        import.meta.env.DEV || import.meta.env.VITE_CAEP_USE_LOCAL_PROXY === 'true';
    return useViteProxy ? CAEP_PROXY_PATH : direct;
}

const CAEP_SESSION_ESTABLISHED =
    'https://schemas.openid.net/secevent/caep/event-type/session-established';

const ANON_SUB_KEY = 'cssdoom-caep-sub-id';

function b64urlUtf8(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = btoa(bin);
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function getOrCreateAnonymousSubjectId() {
    try {
        let id = sessionStorage.getItem(ANON_SUB_KEY);
        if (!id) {
            id = crypto.randomUUID();
            sessionStorage.setItem(ANON_SUB_KEY, id);
        }
        return id;
    } catch {
        return crypto.randomUUID();
    }
}

function buildUnsignedSetJwt(payloadObj) {
    const header = { alg: 'none', typ: 'JWT' };
    const headerPart = b64urlUtf8(JSON.stringify(header));
    const payloadPart = b64urlUtf8(JSON.stringify(payloadObj));
    return `${headerPart}.${payloadPart}.`;
}

/**
 * POSTs an unsigned SET (JWT alg:none) to the configured receiver. No-op if URL or token missing.
 */
export async function emitCaepSessionEstablished() {
    const url = resolveCaepPostUrl();
    const token = import.meta.env.VITE_CAEP_BEARER_TOKEN;
    if (!url || !token) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const iss =
        import.meta.env.VITE_CAEP_SET_ISS ||
        (typeof location !== 'undefined' ? location.origin : 'https://cssdoom.local');
    const aud = import.meta.env.VITE_CAEP_SET_AUD || 'https://sgnl.ai';

    const email = import.meta.env.VITE_CAEP_SUBJECT_EMAIL?.trim();
    const subId = email
        ? { format: 'email', email }
        : { format: 'opaque', id: getOrCreateAnonymousSubjectId() };

    const payload = {
        iss,
        aud,
        iat: nowSec,
        jti: crypto.randomUUID(),
        txn: 8675309,
        sub_id: subId,
        events: {
            [CAEP_SESSION_ESTABLISHED]: {
                event_timestamp: nowSec,
            },
        },
    };

    const body = buildUnsignedSetJwt(payload);

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
        },
        body,
    });

    if (!res.ok && import.meta.env.DEV) {
        console.warn('[caep] Session established push failed', res.status, await res.text().catch(() => ''));
    }
}
