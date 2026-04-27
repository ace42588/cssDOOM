/**
 * Browser-side network client.
 *
 * Owns the WebSocket transport and delegates map rebuilds, input frames,
 * session metadata, interpolation, and snapshot application to focused
 * modules.
 */

import * as rendererFacade from '../renderer/index.js';
import {
    buildAndSendInputFrame,
    pressUse,
    requestBodySwap,
    requestDoorDecision,
    requestWeaponSwitch,
} from './input-sync.js';
import {
    applyRoleChange,
    applyWelcome,
    getSession,
    session,
} from './session.js';
import {
    applyMapLoad,
    configureMapSync,
    resetForLocalSpawn,
} from './map-sync.js';
import {
    applySnapshot,
    markWeaponNeedsRehydrate,
} from './snapshot-apply.js';
import {
    getRenderedPlayerPose,
    getRenderedThingPose,
} from './interpolation.js';
import {
    JoinChallengeMessageSchema,
    MapLoadMessageSchema,
    MSG,
    NoticeMessageSchema,
    RoleChangeMessageSchema,
    SnapshotMessageSchema,
    WelcomeMessageSchema,
} from './protocol.js';

export {
    getSession,
    pressUse,
    requestBodySwap,
    requestDoorDecision,
    requestWeaponSwitch,
    getRenderedPlayerPose,
    getRenderedThingPose,
};

let ws = null;

export function connect({ onMapLoad } = {}) {
    configureMapSync({ onMapLoad });

    const url = buildWsUrl();
    ws = new WebSocket(url);
    ws.onopen = () => { session.connected = true; };
    ws.onclose = () => { session.connected = false; };
    ws.onerror = () => {};
    ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); }
        catch { return; }
        handleMessage(msg);
    };
}

function buildWsUrl() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/ws`;
}

export function sendInputFrame() {
    buildAndSendInputFrame({
        isOpen: () => Boolean(ws && ws.readyState === WebSocket.OPEN),
        sendJson: (message) => {
            try { ws.send(JSON.stringify(message)); } catch {}
        },
    });
}

export function requestLoadMap(mapName) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (typeof mapName !== 'string' || !mapName) return;
    try {
        ws.send(JSON.stringify({ type: 'loadMapRequest', mapName }));
    } catch {}
}

export function sendJoinChallengeDecision(challengeId, decision) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (typeof challengeId !== 'string' || !challengeId) return;
    if (decision !== 'displace' && decision !== 'spectate') return;
    try {
        ws.send(JSON.stringify({
            type: MSG.JOIN_CHALLENGE_DECISION,
            challengeId,
            decision,
        }));
    } catch {}
}

function handleMessage(msg) {
    switch (msg.type) {
        case 'welcome':
            applyParsed(msg, WelcomeMessageSchema, applyWelcome);
            break;
        case 'mapLoad':
            applyParsed(msg, MapLoadMessageSchema, (parsed) => {
                void applyMapLoad(parsed.mapName, parsed.mapData, {
                    onBeforeRebuild: markWeaponNeedsRehydrate,
                    sendMapLoadComplete,
                });
            });
            break;
        case 'roleChange':
            applyParsed(msg, RoleChangeMessageSchema, applyRoleChange);
            break;
        case 'snapshot':
            applyParsed(msg, SnapshotMessageSchema, applySnapshot);
            break;
        case 'notice':
            applyParsed(msg, NoticeMessageSchema, (parsed) => {
                if (parsed.message) {
                    rendererFacade.showHudMessage(parsed.message, 4000);
                }
            });
            break;
        case 'joinChallenge':
            applyParsed(msg, JoinChallengeMessageSchema, (parsed) => {
                import('../ui/join-challenge.js').then((m) => {
                    m.handleJoinChallenge(parsed);
                });
            });
            break;
        case 'bye':
            break;
    }
}

function applyParsed(msg, schema, fn) {
    const parsed = schema.safeParse(msg);
    if (!parsed.success) return;
    fn(parsed.data);
}

function sendMapLoadComplete() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify({ type: 'mapLoadComplete' })); } catch {}
}

export function prepareForLocalSpawn() {
    resetForLocalSpawn();
}
