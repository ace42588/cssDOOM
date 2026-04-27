export const session = {
    sessionId: null,
    role: 'spectator',
    controlledId: null,
    followTargetId: null,
    tickRateHz: 35,
    serverTimeOffsetMs: 0,
    connected: false,
};

export function getSession() {
    return session;
}

export function applyWelcome(msg) {
    session.sessionId = msg.sessionId;
    session.role = msg.role;
    session.controlledId = msg.controlledId;
    session.followTargetId = msg.followTargetId;
    session.tickRateHz = msg.tickRateHz || 35;
    session.serverTimeOffsetMs = (msg.serverTime || 0) - Date.now();
}

export function applyRoleChange(msg) {
    session.role = msg.role;
    session.controlledId = msg.controlledId;
    session.followTargetId = msg.followTargetId;
}

