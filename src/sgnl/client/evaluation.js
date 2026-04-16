/**
 * SGNL access evaluation client.
 *
 * Calls SGNL Access Evaluations (`POST /access/v2/evaluations`) and returns
 * allow/deny results for gameplay actions.
 */

const EVAL_PROXY_PATH = '/__sgnl/access';
const ALLOW_CACHE_TTL_MS = 30_000;

const allowDecisionCache = new Map();

function resolveEvalUrl() {
    const direct = import.meta.env.VITE_SGNL_EVAL_URL;
    if (!direct) return '';
    if (import.meta.env.VITE_SGNL_EVAL_USE_DIRECT_URL === 'true') return direct;
    const useViteProxy =
        import.meta.env.DEV || import.meta.env.VITE_SGNL_EVAL_USE_LOCAL_PROXY === 'true';
    return useViteProxy ? EVAL_PROXY_PATH : direct;
}

function getCachedAllow(cacheKey) {
    const cached = allowDecisionCache.get(cacheKey);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
        allowDecisionCache.delete(cacheKey);
        return null;
    }
    return cached;
}

function cacheAllow(cacheKey, reasons) {
    allowDecisionCache.set(cacheKey, {
        decision: 'Allow',
        reasons: Array.isArray(reasons) ? reasons : [],
        expiresAt: Date.now() + ALLOW_CACHE_TTL_MS,
    });
}

async function parseJsonSafe(response) {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

/**
 * Evaluate access for one principal + asset + action.
 * Returns fail-open allow when config is missing or network errors occur.
 */
export async function evaluateAccess(principalId, assetId, action) {
    const url = resolveEvalUrl();
    const token = import.meta.env.VITE_SGNL_EVAL_TOKEN;
    if (!url || !token || !principalId || !assetId || !action) {
        return { allowed: true, skipped: true };
    }

    const cacheKey = `${principalId}|${assetId}|${action}`;
    const cachedAllow = getCachedAllow(cacheKey);
    if (cachedAllow) {
        return { allowed: true, decision: cachedAllow.decision, reasons: cachedAllow.reasons, cached: true };
    }

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'X-Request-Id': crypto.randomUUID(),
            },
            body: JSON.stringify({
                principal: { id: principalId },
                queries: [{ assetId, action }],
            }),
        });

        if (!response.ok) {
            if (import.meta.env.DEV) {
                const errorText = await response.text().catch(() => '');
                console.warn('[sgnl-eval] access evaluation failed', response.status, errorText);
            }
            return { allowed: true };
        }

        const body = await parseJsonSafe(response);
        const decisionEntry = body?.decisions?.find(entry =>
            entry?.assetId === assetId && entry?.action === action
        ) || body?.decisions?.[0];
        const decision = decisionEntry?.decision;
        const reasons = Array.isArray(decisionEntry?.reasons) ? decisionEntry.reasons : [];

        if (decision === 'Deny') {
            return { allowed: false, decision, reasons };
        }

        if (decision === 'Allow') {
            cacheAllow(cacheKey, reasons);
        }

        return { allowed: true, decision, reasons };
    } catch (error) {
        if (import.meta.env.DEV) console.warn('[sgnl-eval] access evaluation error', error);
        return { allowed: true };
    }
}
