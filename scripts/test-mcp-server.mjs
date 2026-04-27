/**
 * Headless smoke test for the server-side MCP interface.
 *
 * Boots the game world in-process (no HTTP, no WebSocket), wires an MCP
 * client to an MCP server using a paired in-memory transport, and asserts
 * that tool calls mutate the right `Connection.input` fields and trigger
 * possession / door-decision flows.
 *
 * Run:  node scripts/test-mcp-server.mjs
 */

import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import {
    installEngineHosts,
    useGameServices,
    loadMap,
} from '../server/world.js';
import { getConnection } from '../server/connections.js';
import { createSgnlServices } from '../server/sgnl/index.js';
import { state, getMarineActor } from '../src/engine/state.js';
import { ENEMIES } from '../src/engine/constants.js';
import { getActorIndex } from '../src/engine/things/registry.js';
import { buildMcpServerForNewSession } from '../server/mcp/index.js';
import { openMcpSession, closeMcpSession } from '../server/mcp/sessions.js';
import { tickIdleChecks } from '../server/idle.js';
import { emptyInput } from '../server/net.js';
import { updateMovementFor } from '../src/engine/movement/system.js';
import { getControlledFor } from '../src/engine/possession.js';
import { poseOf } from '../src/engine/actors/capabilities.js';
import { rolePromptFor } from '../server/mcp/role.js';
import { normalizeAngle } from '../src/engine/math/angle.js';

class InMemoryTransport {
    constructor(name) {
        this.name = name;
        this.peer = null;
        this.onmessage = undefined;
        this.onclose = undefined;
        this.onerror = undefined;
    }
    static pair() {
        const a = new InMemoryTransport('a');
        const b = new InMemoryTransport('b');
        a.peer = b;
        b.peer = a;
        return [a, b];
    }
    async start() {}
    async send(message) {
        const peer = this.peer;
        if (!peer || typeof peer.onmessage !== 'function') return;
        queueMicrotask(() => {
            try { peer.onmessage(message); }
            catch (err) { peer.onerror?.(err); }
        });
    }
    async close() {
        this.onclose?.();
        const peer = this.peer;
        this.peer = null;
        if (peer) { peer.peer = null; peer.onclose?.(); }
    }
}

async function callTool(client, name, args = {}) {
    const res = await client.callTool({ name, arguments: args });
    const block = res.content?.find?.((b) => b.type === 'text');
    if (!block) return res;
    try { return JSON.parse(block.text); }
    catch { return block.text; }
}

async function main() {
    installEngineHosts();
    useGameServices(createSgnlServices());
    await loadMap('E1M1');

    const hinted = buildMcpServerForNewSession({
        displayName: 'identity-hint',
        agentIdentity: {
            source: 'client',
            agentId: 'agent:smoke',
            agentName: 'Smoke Agent',
            fingerprint: 'abc123abc123abcd',
            runtime: 'cursor',
            clientName: 'smoke-client',
            clientVersion: '0.0.0',
            firstSeenAt: Date.now(),
        },
    });
    const hintedConn = getConnection(hinted.gameSessionId);
    assert.ok(hintedConn?.agentIdentity, 'hinted session should persist agent identity');
    assert.equal(hintedConn.agentIdentity.source, 'client');
    assert.equal(hintedConn.agentIdentity.agentId, 'agent:smoke');
    await hinted.dispose();

    const mcp = buildMcpServerForNewSession({ displayName: 'smoke-test' });
    const sessionId = mcp.gameSessionId;
    const conn = getConnection(sessionId);
    assert.ok(conn, 'session has a connection registered');
    assert.ok(conn.agentIdentity, 'fallback identity should be present');
    assert.equal(conn.agentIdentity.source, 'fingerprint');
    assert.equal(typeof conn.agentIdentity.fingerprint, 'string');
    assert.ok(conn.agentIdentity.fingerprint.length > 0, 'fallback fingerprint should be non-empty');

    const [serverTransport, clientTransport] = InMemoryTransport.pair();
    await mcp.server.connect(serverTransport);

    const client = new Client(
        { name: 'smoke-client', version: '0.0.0' },
        { capabilities: {} },
    );
    await client.connect(clientTransport);

    console.log('── 1. Tool list contains all expected tools ──');
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name).sort();
    const expected = [
        'world-get-state', 'world-get-map', 'world-list-players',
        'world-poll-events', 'world-get-latest-snapshot',
        'players-list', 'players-peers', 'players-get-self',
        'actor-get-state', 'actor-list', 'actor-set-move', 'actor-stop',
        'actor-turn-by', 'actor-fire', 'actor-stop-fire',
        'actor-use', 'actor-switch-weapon', 'actor-possess',
        'enemies-list', 'enemies-get-state',
        'doors-list', 'doors-get-state', 'doors-open-in-front',
        'doors-approve-request', 'doors-deny-request',
        'session-resolve-join',
    ].sort();
    assert.deepEqual(names, expected, `tool list mismatch:\n${names.join(',')}\nvs\n${expected.join(',')}`);
    console.log(`  ${names.length} tools registered.`);

    console.log('── 2. world-get-state returns the unified actor list ──');
    const world = await callTool(client, 'world-get-state');
    assert.ok(Array.isArray(world.actors), 'world has an actors array');
    const marineSnap = world.actors.find((a) => a.kind === 'marine');
    assert.ok(marineSnap, 'actors list contains the marine');
    assert.ok(world.self?.sessionId === sessionId, 'self session is the calling session');
    assert.equal(world.sessionId, sessionId, 'tool JSON includes top-level sessionId');
    console.log(`  marine HP=${marineSnap.vitals.hp}  actors=${world.actors.length}  doors=${world.doors.length}`);

    console.log('── 3. actor-set-move mutates conn.input ──');
    await callTool(client, 'actor-set-move', { moveY: 1, run: true });
    assert.equal(conn.input.moveY, 1, 'moveY set');
    assert.equal(conn.input.run, true, 'run set');
    await callTool(client, 'actor-stop');
    assert.equal(conn.input.moveY, 0, 'moveY cleared');
    assert.equal(conn.input.run, false, 'run cleared');
    console.log('  set-move / stop verified.');

    console.log('── 4. actor-turn-by accumulates turnDelta ──');
    conn.input.turnDelta = 0;
    await callTool(client, 'actor-turn-by', { radians: 0.4 });
    assert.ok(Math.abs(conn.input.turnDelta - 0.4) < 1e-9, `turnDelta=${conn.input.turnDelta}`);
    await callTool(client, 'actor-turn-by', { radians: -0.1 });
    assert.ok(Math.abs(conn.input.turnDelta - 0.3) < 1e-9, `turnDelta accumulated: ${conn.input.turnDelta}`);
    console.log(`  turnDelta=${conn.input.turnDelta.toFixed(3)}`);

    console.log('── 4b. yaw normalizes to [-pi, pi] after a movement tick ──');
    const sid = conn.sessionId;
    const m = getMarineActor();
    if (getControlledFor(sid) === m) {
        m.viewAngle = 100;
        updateMovementFor(sid, emptyInput(), 1 / 35, 0);
        const poseAng = poseOf(m).angle;
        assert.ok(poseAng >= -Math.PI - 1e-5 && poseAng <= Math.PI + 1e-5, `pose angle in [-pi,pi]: ${poseAng}`);
        assert.ok(Math.abs(poseAng - normalizeAngle(100)) < 1e-5, `pose matches normalizeAngle: ${poseAng}`);
    } else {
        console.log('  (not controlling marine — skipped yaw normalization check)');
    }

    console.log('── 5. actor-fire sets fireHeld; durationMs auto-clears ──');
    conn.input.fireHeld = false;
    await callTool(client, 'actor-fire');
    assert.equal(conn.input.fireHeld, true, 'fire held');
    await callTool(client, 'actor-stop-fire');
    assert.equal(conn.input.fireHeld, false, 'fire released');
    await callTool(client, 'actor-fire', { durationMs: 60 });
    assert.equal(conn.input.fireHeld, true, 'fire held with timer');
    await new Promise((r) => setTimeout(r, 140));
    assert.equal(conn.input.fireHeld, false, 'fire auto-released');
    console.log('  fire toggle and auto-release verified.');

    console.log('── 6. actor-use queues edge-trigger ──');
    conn.input.use = false;
    await callTool(client, 'actor-use');
    assert.equal(conn.input.use, true, 'use flag queued');
    console.log('  use queued.');

    console.log('── 7. actor-switch-weapon writes switchWeapon ──');
    conn.input.switchWeapon = null;
    await callTool(client, 'actor-switch-weapon', { slot: 3 });
    assert.equal(conn.input.switchWeapon, 3, 'switchWeapon=3');
    console.log('  switch-weapon queued.');

    console.log('── 8. enemies-list returns at least the map enemies ──');
    const enemies = await callTool(client, 'enemies-list', {});
    assert.equal(typeof enemies.count, 'number', 'count is a number');
    console.log(`  enemies.count=${enemies.count}`);

    console.log('── 9. actor-possess queues bodySwap with actor:N ──');
    const livingEnemy = state.actors.find((t) => t && t.ai && ENEMIES.has(t.type) && (t.hp ?? 0) > 0 && !t.collected);
    if (livingEnemy) {
        const idx = getActorIndex(livingEnemy);
        conn.input.bodySwap = null;
        const res = await callTool(client, 'actor-possess', { targetId: `actor:${idx}` });
        assert.equal(res.ok, true, 'possess accepted');
        assert.ok(res.role && res.role.kind === 'enemy', 'role hints for enemy');
        assert.deepEqual(conn.input.bodySwap, { targetId: `actor:${idx}` }, 'bodySwap queued');
        console.log(`  possess actor:${idx} queued.`);
    } else {
        console.log('  (no living enemy in E1M1 — skipped)');
    }

    console.log('── 10. actor-possess with bad thing id returns ok:false ──');
    const bad = await callTool(client, 'actor-possess', { targetId: 'thing:99999' });
    assert.equal(bad.ok, false, 'invalid id rejected');
    console.log(`  rejected: reason="${bad.reason}"`);

    console.log('── 11. actor-possess marine queues body swap back to player ──');
    conn.input.bodySwap = null;
    const rel = await callTool(client, 'actor-possess', { targetId: 'marine' });
    assert.equal(rel.ok, true);
    assert.ok(rel.role && rel.role.kind === 'marine', 'role hints for marine');
    assert.deepEqual(conn.input.bodySwap, { targetId: 'actor:0' });
    console.log('  release queued.');

    console.log('── 12. doors-list never throws on E1M1 ──');
    const doors = await callTool(client, 'doors-list');
    assert.equal(typeof doors.count, 'number');
    console.log(`  doors.count=${doors.count}`);

    console.log('── 13. doors-open-in-front queues use ──');
    conn.input.use = false;
    const dop = await callTool(client, 'doors-open-in-front');
    assert.equal(dop.ok, true);
    assert.equal(conn.input.use, true, 'use queued via doors-open-in-front');
    console.log('  doors-open-in-front queued use.');

    console.log('── 14. doors-approve-request queues doorDecision ──');
    conn.input.doorDecision = null;
    const ap = await callTool(client, 'doors-approve-request', { sectorIndex: 1, requestId: 99 });
    assert.equal(ap.ok, true);
    assert.deepEqual(conn.input.doorDecision, { sectorIndex: 1, requestId: 99, decision: 'open' });
    const dn = await callTool(client, 'doors-deny-request', { sectorIndex: 1, requestId: 99 });
    assert.equal(dn.ok, true);
    assert.deepEqual(conn.input.doorDecision, { sectorIndex: 1, requestId: 99, decision: 'ignore' });
    console.log('  doorDecision queued for approve/deny.');

    console.log('── 15. players-list includes self ──');
    const players = await callTool(client, 'players-list');
    assert.ok(Array.isArray(players.players));
    const me = players.players.find((p) => p.self);
    assert.ok(me && me.sessionId === sessionId, 'self entry has matching sessionId');
    assert.equal(me.kind, 'mcp', 'self is tagged kind=mcp');
    assert.ok(me.agent, 'self should include MCP identity metadata');
    assert.equal(me.agent.source, 'fingerprint', 'self should expose fallback identity source');
    assert.equal(typeof me.agent.agentId, 'string');
    assert.equal(typeof me.agent.fingerprint, 'string');
    console.log(`  ${players.players.length} player(s); self.role=${me.role} kind=${me.kind}`);

    console.log('── 16. world-get-map returns mapName ──');
    const mapped = await callTool(client, 'world-get-map', { includeMapData: false });
    assert.equal(mapped.mapName, 'E1M1');
    console.log(`  mapName=${mapped.mapName}`);

    console.log('── 17. resources/list exposes static docs + live world reads ──');
    const resourceList = await client.listResources();
    const uris = resourceList.resources.map((r) => r.uri).sort();
    const expectedResourceUris = [
        'cssdoom://docs/agent-guide',
        'cssdoom://docs/coordinate-system',
        'cssdoom://docs/gameplay-rules',
        'cssdoom://docs/join-challenge',
        'cssdoom://docs/recipes',
        'cssdoom://docs/tool-index',
        'cssdoom://world/map',
        'cssdoom://world/players',
        'cssdoom://world/state',
        'cssdoom://role/current',
    ];
    for (const uri of expectedResourceUris) {
        assert.ok(uris.includes(uri), `missing resource ${uri}\nhave: ${uris.join(', ')}`);
    }
    console.log(`  ${uris.length} resources registered.`);

    console.log('── 18. resources/read on agent-guide returns markdown content ──');
    const guide = await client.readResource({ uri: 'cssdoom://docs/agent-guide' });
    const guideBody = guide.contents.find((c) => c.uri === 'cssdoom://docs/agent-guide');
    assert.ok(guideBody, 'guide content present');
    assert.equal(guideBody.mimeType, 'text/markdown');
    assert.ok(guideBody.text.includes('Agent guide'), 'guide text contains heading');
    console.log(`  agent-guide.md is ${guideBody.text.length} bytes.`);

    console.log('── 19. resources/read on world/state returns JSON ──');
    const liveState = await client.readResource({ uri: 'cssdoom://world/state' });
    const stateBody = liveState.contents[0];
    assert.equal(stateBody.mimeType, 'application/json');
    const parsedLive = JSON.parse(stateBody.text);
    assert.equal(parsedLive.self.sessionId, sessionId, 'live world state knows the calling session');
    assert.equal(parsedLive.self.kind, 'mcp', 'world state self reports transport kind');
    assert.ok(parsedLive.self.agent, 'world state self includes agent identity metadata');
    assert.equal(parsedLive.self.agent.source, 'fingerprint');
    console.log(`  live state mapName=${parsedLive.mapName} actors=${parsedLive.actors.length}`);

    console.log('── 19b. resources/read on role/current matches rolePromptFor ──');
    const liveRole = await client.readResource({ uri: 'cssdoom://role/current' });
    const roleBody = liveRole.contents[0];
    assert.equal(roleBody.mimeType, 'application/json');
    const parsedRole = JSON.parse(roleBody.text);
    const wantKind = rolePromptFor(getControlledFor(sessionId)).kind;
    assert.equal(parsedRole.kind, wantKind, `role/current kind=${parsedRole.kind} want ${wantKind}`);
    console.log(`  role/current kind=${parsedRole.kind}`);

    console.log('── 20. prompts/list exposes the bootstrap prompts ──');
    const promptList = await client.listPrompts();
    const promptNames = promptList.prompts.map((p) => p.name).sort();
    assert.deepEqual(promptNames, ['hunt-a-peer', 'operate-a-door', 'play-the-game']);
    console.log(`  ${promptNames.length} prompts registered.`);

    console.log('── 21. prompts/get returns a usable bootstrap message ──');
    const got = await client.getPrompt({ name: 'play-the-game', arguments: { style: 'aggressive' } });
    assert.ok(Array.isArray(got.messages) && got.messages.length > 0, 'play-the-game has messages');
    const firstText = got.messages[0]?.content?.text || '';
    assert.ok(firstText.includes('aggressive'), `play-the-game incorporates the style argument: ${firstText.slice(0, 80)}`);
    console.log(`  play-the-game produced ${got.messages.length} messages.`);

    console.log('── 22. MCP connections are not idle-dropped ──');
    conn.lastActiveAt = Date.now() - 120_000;
    tickIdleChecks(Date.now());
    assert.ok(getConnection(sessionId), 'mcp session still connected after idle window');

    console.log('── 23. sticky agent identity reclaims same controlledId ──');
    const stickyIdentity = {
        source: 'client',
        agentId: 'agent:sticky-reclaim',
        agentName: 'Sticky',
        fingerprint: 'stickyfpstickyfp12',
        firstSeenAt: Date.now(),
    };
    const sc1 = openMcpSession({ displayName: 'sticky-a', agentIdentity: stickyIdentity });
    const cid1 = sc1.controlledId;
    closeMcpSession(sc1.sessionId);
    const sc2 = openMcpSession({ displayName: 'sticky-b', agentIdentity: stickyIdentity });
    assert.equal(sc2.controlledId, cid1, 'reconnect with same identity should re-attach to prior body');
    closeMcpSession(sc2.sessionId);

    console.log('── 24. every sampled tool response includes sessionId ──');
    const samples = [
        await callTool(client, 'players-get-self'),
        await callTool(client, 'actor-get-state'),
        await callTool(client, 'doors-list'),
        bad,
    ];
    for (const s of samples) {
        assert.ok(s && typeof s === 'object' && 'sessionId' in s, `expected sessionId on response: ${JSON.stringify(s).slice(0, 120)}`);
    }

    await client.close();
    await mcp.dispose();

    console.log('\nAll server MCP smoke checks passed.');
}

main().then(
    () => process.exit(0),
    (err) => {
        console.error(err?.stack || err);
        process.exit(1);
    },
);
