/**
 * When a spectator attempts to possess a body held by an MCP agent,
 * elicit a short defense from that agent; the challenger then chooses to
 * displace or spectate. Unsupported clients / timeouts / declines → silent
 * displacement (challenger gets the body).
 */

import { randomUUID } from 'node:crypto';

import {
    getControlledFor,
    possessFor,
} from '../src/game/possession.js';
import {
    applyDisplacement,
    entityId,
} from './assignment.js';
import { getConnection, send } from './connections.js';
import { MSG, ROLE } from './net.js';
import { queueRoleChange } from './world/roles.js';
import { getMcpServer } from './mcp/server-registry.js';

function readEnvMs(key, defaultMs) {
    const raw = Number(process.env[key]);
    return Number.isFinite(raw) && raw > 0 ? raw : defaultMs;
}

const DEFENSE_TIMEOUT_MS = readEnvMs('MCP_DEFENSE_TIMEOUT_MS', 6000);
const JOIN_CHALLENGE_TTL_MS = readEnvMs('MCP_JOIN_CHALLENGE_TTL_MS', 15_000);

/** @typedef {{ challengeId: string, joinerSessionId: string, targetSessionId: string, targetEntityId: string, entity: object, expiresAt: number, decisionTimer: ReturnType<typeof setTimeout>|null, settled: boolean }} PendingChallenge */

/** @type {Map<string, PendingChallenge>} */
const pendingByChallengeId = new Map();
/** @type {Map<string, string>} targetSessionId → challengeId */
const activeChallengesByTarget = new Map();

const DEFENSE_FORM_MESSAGE = 'A new player wants the body you currently control. Briefly defend your position (why you should keep playing). The joining player will see this and decide.';

const DEFENSE_SCHEMA = {
    type: 'object',
    properties: {
        justification: {
            type: 'string',
            title: 'Defense',
            description: 'Why you should keep this body (<=400 chars).',
            maxLength: 400,
        },
        intendedAction: {
            type: 'string',
            title: 'Next intent',
            description: "What you're about to do (<=120 chars).",
            maxLength: 120,
        },
    },
    required: ['justification'],
};

function targetAgentMeta(targetConn) {
    const a = targetConn?.agentIdentity;
    return {
        agentId: a?.agentId || 'unknown',
        agentName: a?.agentName || 'MCP agent',
        runtime: a?.runtime ?? null,
    };
}

function clearDecisionTimer(entry) {
    if (entry?.decisionTimer) {
        clearTimeout(entry.decisionTimer);
        entry.decisionTimer = null;
    }
}

function finishMaps(challengeId, targetSessionId) {
    pendingByChallengeId.delete(challengeId);
    const active = activeChallengesByTarget.get(targetSessionId);
    if (active === challengeId) {
        activeChallengesByTarget.delete(targetSessionId);
    }
}

function notifyDisplaced(targetConn, byJoinerSessionId, bodyId) {
    send(targetConn, {
        type: MSG.NOTICE,
        code: 'displaced-by-join',
        message: `A joining player displaced you to spectator (body ${bodyId}, joiner ${byJoinerSessionId.slice(0, 8)}…).`,
    });
}

/**
 * Give `entity` to `joinerConn`, releasing `targetConn` when it still holds the body.
 * @returns {boolean} true if the joiner now controls `entity`.
 */
function promoteJoinerToBody(joinerConn, targetConn, entity, entry) {
    const controlledByTarget = targetConn ? getControlledFor(targetConn.sessionId) : null;
    if (targetConn && controlledByTarget === entity) {
        applyDisplacement(joinerConn, targetConn, entity);
        notifyDisplaced(targetConn, joinerConn.sessionId, entry.targetEntityId);
        return true;
    }
    if (possessFor(joinerConn.sessionId, entity)) {
        joinerConn.role = ROLE.PLAYER;
        joinerConn.controlledId = entityId(entity);
        joinerConn.followTargetId = null;
        return true;
    }
    return false;
}

function sendJoinChallengeToJoiner(joinerConn, fields) {
    send(joinerConn, {
        type: MSG.JOIN_CHALLENGE,
        ...fields,
    });
}

/**
 * @param {import('./connections.js').Connection} joinerConn
 * @param {{ sessionId: string, entity: object, kind?: string }} candidate
 */
export function startChallenge(joinerConn, candidate) {
    if (!joinerConn || !candidate?.sessionId || !candidate.entity) return false;
    if (activeChallengesByTarget.has(candidate.sessionId)) return false;

    const challengeId = randomUUID();
    const expiresAt = Date.now() + JOIN_CHALLENGE_TTL_MS;
    /** @type {PendingChallenge} */
    const entry = {
        challengeId,
        joinerSessionId: joinerConn.sessionId,
        targetSessionId: candidate.sessionId,
        targetEntityId: entityId(candidate.entity),
        entity: candidate.entity,
        expiresAt,
        decisionTimer: null,
        settled: false,
    };
    pendingByChallengeId.set(challengeId, entry);
    activeChallengesByTarget.set(candidate.sessionId, challengeId);

    void runDefensePhase(joinerConn, entry, candidate);
    return true;
}

/**
 * @param {import('./connections.js').Connection} joinerConn
 * @param {PendingChallenge} entry
 * @param {{ sessionId: string, entity: object }} candidate
 */
async function runDefensePhase(joinerConn, entry, candidate) {
    const mcp = getMcpServer(candidate.sessionId);
    if (!mcp) {
        silentDisplace(entry.challengeId, 'error');
        return;
    }

    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), DEFENSE_TIMEOUT_MS);

    let result;
    try {
        result = await mcp.server.elicitInput({
            mode: 'form',
            message: DEFENSE_FORM_MESSAGE,
            requestedSchema: DEFENSE_SCHEMA,
        }, { signal: ac.signal });
    } catch (err) {
        clearTimeout(t);
        const aborted = ac.signal.aborted || err?.name === 'AbortError';
        silentDisplace(entry.challengeId, aborted ? 'timeout' : 'unsupported');
        return;
    }
    clearTimeout(t);

    const still = pendingByChallengeId.get(entry.challengeId);
    if (!still || still.settled) return;

    if (result?.action === 'accept' && result.content && typeof result.content.justification === 'string') {
        const defense = {
            justification: String(result.content.justification).slice(0, 400),
            ...(result.content.intendedAction != null
                ? { intendedAction: String(result.content.intendedAction).slice(0, 120) }
                : {}),
        };
        deliverDefenseAndWait(joinerConn, still, defense);
        return;
    }

    const reason = (result?.action === 'decline' || result?.action === 'cancel') ? 'declined' : 'error';
    silentDisplace(entry.challengeId, reason);
}

/**
 * @param {import('./connections.js').Connection} joinerConn
 * @param {PendingChallenge} entry
 * @param {{ justification: string, intendedAction?: string }} defense
 */
function deliverDefenseAndWait(joinerConn, entry, defense) {
    const targetConn = getConnection(entry.targetSessionId);
    if (!targetConn) {
        silentDisplace(entry.challengeId, 'error');
        return;
    }

    sendJoinChallengeToJoiner(joinerConn, {
        challengeId: entry.challengeId,
        targetEntityId: entry.targetEntityId,
        targetAgent: targetAgentMeta(targetConn),
        defense,
        defenseState: 'accepted',
        expiresAt: entry.expiresAt,
        autoResolved: false,
    });

    const msLeft = Math.max(0, entry.expiresAt - Date.now());
    entry.decisionTimer = setTimeout(() => {
        const cur = pendingByChallengeId.get(entry.challengeId);
        if (!cur || cur.settled) return;
        const jc = getConnection(entry.joinerSessionId);
        if (jc) void resolveChallenge(entry.challengeId, jc, 'spectate', 'timeout');
    }, Math.max(msLeft, 1));
}

/**
 * @param {'displace'|'spectate'} decision
 * @param {'timeout'|undefined} [fromTimeout]
 */
export function resolveChallenge(challengeId, joinerConn, decision, fromTimeout) {
    const entry = pendingByChallengeId.get(challengeId);
    if (!entry || entry.settled) return false;
    if (!joinerConn || joinerConn.sessionId !== entry.joinerSessionId) return false;
    if (Date.now() > entry.expiresAt && fromTimeout !== 'timeout') return false;

    entry.settled = true;
    clearDecisionTimer(entry);

    if (decision === 'spectate') {
        finishMaps(challengeId, entry.targetSessionId);
        const joiner = getConnection(entry.joinerSessionId);
        if (joiner) {
            send(joiner, {
                type: MSG.NOTICE,
                code: 'join-challenge-resolved',
                message: fromTimeout === 'timeout'
                    ? 'Join challenge expired — you remain a spectator.'
                    : 'You remain a spectator for this join challenge.',
            });
        }
        return true;
    }

    const joiner = getConnection(entry.joinerSessionId);
    if (!joiner) {
        finishMaps(challengeId, entry.targetSessionId);
        return false;
    }

    const targetConn = getConnection(entry.targetSessionId);
    const promoted = promoteJoinerToBody(joiner, targetConn, entry.entity, entry);

    finishMaps(challengeId, entry.targetSessionId);
    if (promoted) {
        send(joiner, {
            type: MSG.NOTICE,
            code: 'join-challenge-resolved',
            message: 'You displaced the MCP agent and took control of the body.',
        });
        queueRoleChange(joiner.sessionId);
        if (targetConn) queueRoleChange(targetConn.sessionId);
    }
    return promoted;
}

/**
 * @param {'declined'|'timeout'|'unsupported'|'error'} defenseState
 */
function silentDisplace(challengeId, defenseState) {
    const entry = pendingByChallengeId.get(challengeId);
    if (!entry || entry.settled) return;

    entry.settled = true;
    clearDecisionTimer(entry);

    const joiner = getConnection(entry.joinerSessionId);
    const targetConn = getConnection(entry.targetSessionId);

    if (joiner) {
        const meta = targetConn ? targetAgentMeta(targetConn) : {
            agentId: 'unknown',
            agentName: 'MCP agent',
            runtime: null,
        };
        const promoted = promoteJoinerToBody(joiner, targetConn, entry.entity, entry);
        if (promoted) {
            sendJoinChallengeToJoiner(joiner, {
                challengeId: entry.challengeId,
                targetEntityId: entry.targetEntityId,
                targetAgent: meta,
                defense: null,
                defenseState,
                expiresAt: entry.expiresAt,
                autoResolved: true,
            });
            queueRoleChange(joiner.sessionId);
            if (targetConn) queueRoleChange(targetConn.sessionId);
        }
    }

    finishMaps(challengeId, entry.targetSessionId);
}

/** Joiner or target disconnected, or map reset — abandon challenge without promoting joiner (except target gone during wait: handled separately). */
export function cancelChallengesInvolvingSession(sessionId) {
    const affected = [...pendingByChallengeId.entries()].filter(
        ([, e]) => e.joinerSessionId === sessionId || e.targetSessionId === sessionId,
    );
    for (const [cid, e] of affected) {
        if (e.settled) continue;
        if (e.joinerSessionId === sessionId) {
            e.settled = true;
            clearDecisionTimer(e);
            finishMaps(cid, e.targetSessionId);
            continue;
        }
        if (e.targetSessionId === sessionId) {
            silentDisplace(cid, 'error');
        }
    }
}

/** Map transition: drop pending challenges without changing possession. */
export function cancelAllChallenges() {
    for (const [cid, e] of [...pendingByChallengeId.entries()]) {
        if (e.settled) continue;
        e.settled = true;
        clearDecisionTimer(e);
        finishMaps(cid, e.targetSessionId);
    }
}
