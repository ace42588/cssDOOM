import assert from 'node:assert/strict';

import {
    ClientInputMessageSchema,
    JoinChallengeDecisionMessageSchema,
    JoinChallengeMessageSchema,
    LoadMapRequestMessageSchema,
    MSG,
    MapLoadMessageSchema,
    NoticeMessageSchema,
    RoleChangeMessageSchema,
    SnapshotMessageSchema,
    WelcomeMessageSchema,
    sanitizeInput,
} from '../src/net/protocol.js';

const input = sanitizeInput({
    moveX: 99,
    moveY: -99,
    turn: '0.5',
    turnDelta: '1.25',
    run: 1,
    fireHeld: '',
    use: true,
    bodySwap: { targetId: 'thing:1' },
    doorDecision: { sectorIndex: '7', requestId: '9', decision: 'open' },
    switchWeapon: 44.8,
});
assert.equal(input.moveX, 1);
assert.equal(input.moveY, -1);
assert.equal(input.turn, 0.5);
assert.equal(input.turnDelta, 1.25);
assert.equal(input.run, true);
assert.equal(input.fireHeld, false);
assert.deepEqual(input.bodySwap, { targetId: 'thing:1' });
assert.deepEqual(input.doorDecision, { sectorIndex: 7, requestId: 9, decision: 'open' });
assert.equal(input.switchWeapon, 9);

assert.equal(ClientInputMessageSchema.safeParse({
    type: MSG.INPUT,
    seq: '10',
    input: { moveX: 0.25 },
}).success, true);

assert.equal(LoadMapRequestMessageSchema.safeParse({
    type: MSG.LOAD_MAP_REQUEST,
    mapName: 'E1M1',
}).success, true);
assert.equal(LoadMapRequestMessageSchema.safeParse({
    type: MSG.LOAD_MAP_REQUEST,
    mapName: 'BAD',
}).success, false);

assert.equal(WelcomeMessageSchema.safeParse({
    type: MSG.WELCOME,
    sessionId: 's',
    role: 'player',
    controlledId: 'player',
    followTargetId: null,
    mapName: 'E1M1',
    tickRateHz: 70,
    serverTime: Date.now(),
}).success, true);

assert.equal(RoleChangeMessageSchema.safeParse({
    type: MSG.ROLE_CHANGE,
    role: 'spectator',
    controlledId: null,
    followTargetId: 'player',
}).success, true);

assert.equal(MapLoadMessageSchema.safeParse({
    type: MSG.MAP_LOAD,
    mapName: 'E1M1',
    mapData: { vertices: [] },
}).success, true);

assert.equal(SnapshotMessageSchema.safeParse({
    type: MSG.SNAPSHOT,
    tick: 1,
    player: { health: 100 },
    things: { spawn: [{ id: 1 }], update: [], despawn: [] },
    doors: [{ sectorIndex: 4, open: true }],
    rendererEvents: [],
    soundEvents: ['pistol'],
}).success, true);

assert.equal(NoticeMessageSchema.safeParse({
    type: MSG.NOTICE,
    message: 'hello',
}).success, true);

assert.equal(JoinChallengeMessageSchema.safeParse({
    type: MSG.JOIN_CHALLENGE,
    challengeId: 'c1',
    targetEntityId: 'player',
    targetAgent: { agentId: 'a', agentName: 'n', runtime: null },
    defense: { justification: 'keep' },
    defenseState: 'accepted',
    expiresAt: Date.now() + 5000,
}).success, true);

assert.equal(JoinChallengeDecisionMessageSchema.safeParse({
    type: MSG.JOIN_CHALLENGE_DECISION,
    challengeId: 'c1',
    decision: 'displace',
}).success, true);

console.log('protocol schemas: ok');

