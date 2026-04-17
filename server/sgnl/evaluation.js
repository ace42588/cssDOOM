/**
 * SGNL access evaluation — server-side.
 *
 * Calls SGNL Access Evaluations (`POST /access/v2/evaluations`) and returns
 * allow/deny results for gameplay actions. Fail-open by default: if config
 * or the upstream call is missing/broken we allow the action and let the
 * game keep running.
 *
 * Env:
 *   SGNL_EVAL_URL     — full URL to the evaluations endpoint
 *   SGNL_EVAL_TOKEN   — Bearer token used in the Authorization header
 */

import { randomUUID } from 'node:crypto';

const ALLOW_CACHE_TTL_MS = 30_000;
const allowDecisionCache = new Map();

function getCachedAllow(key) {
    const cached = allowDecisionCache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
        allowDecisionCache.delete(key);
        return null;
    }
    return cached;
}

function cacheAllow(key, reasons) {
    allowDecisionCache.set(key, {
        decision: 'Allow',
        reasons: Array.isArray(reasons) ? reasons : [],
        expiresAt: Date.now() + ALLOW_CACHE_TTL_MS,
    });
}

async function parseJsonSafe(response) {
    try { return await response.json(); }
    catch { return null; }
}

export async function evaluateAccess(principalId, assetId, action) {
    const url = process.env.SGNL_EVAL_URL || '';
    const token = process.env.SGNL_EVAL_TOKEN || '';
    if (!url || !token || !principalId || !assetId || !action) {
        return { allowed: true, skipped: true };
    }

    const cacheKey = `${principalId}|${assetId}|${action}`;
    const cachedAllow = getCachedAllow(cacheKey);
    if (cachedAllow) {
        return {
            allowed: true,
            decision: cachedAllow.decision,
            reasons: cachedAllow.reasons,
            cached: true,
        };
    }

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'X-Request-Id': randomUUID(),
            },
            body: JSON.stringify({
                principal: { id: principalId },
                queries: [{ assetId, action }],
            }),
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            console.warn('[sgnl-eval] access evaluation failed', response.status, errorText);
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
        console.warn('[sgnl-eval] access evaluation error', error?.message || error);
        return { allowed: true };
    }
}
