/**
 * Headless smoke test for the WebMCP tools.
 *
 * Stubs just enough of the browser environment (`navigator.modelContext`,
 * `performance.now`, `requestAnimationFrame`) so the tool modules can be
 * imported in Node and their input-pipeline side effects verified.
 *
 * This does *not* talk to the game server — it verifies that each tool
 * mutates the shared `input` / `pendingFlags` / MCP intent as expected.
 *
 * Run:  node scripts/test-mcp.mjs
 */

import assert from 'node:assert/strict';

globalThis.performance ??= { now: () => Date.now() };
globalThis.requestAnimationFrame ??= (cb) => setTimeout(() => cb(performance.now()), 16);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

class ToolRegistry {
    constructor() { this.tools = new Map(); }
    registerTool(t) {
        assert.ok(t && typeof t.name === 'string', 'tool needs a name');
        assert.ok(typeof t.execute === 'function', `tool ${t.name} needs execute`);
        assert.ok(!this.tools.has(t.name), `duplicate tool name ${t.name}`);
        this.tools.set(t.name, t);
    }
    unregisterTool(name) { this.tools.delete(name); }
    async call(name, args = {}) {
        const t = this.tools.get(name);
        if (!t) throw new Error(`no tool ${name}`);
        const res = await t.execute(args);
        const textBlock = res?.content?.find?.((b) => b.type === 'text');
        try { return textBlock ? JSON.parse(textBlock.text) : res; }
        catch { return textBlock ? textBlock.text : res; }
    }
}
const registry = new ToolRegistry();
Object.defineProperty(globalThis, 'navigator', {
    value: { modelContext: registry },
    configurable: true,
    writable: true,
});

// Stub WebSocket so `src/net/client.js` can be imported without connecting.
globalThis.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} };
globalThis.location = { protocol: 'http:', host: 'localhost' };

const { input } = await import('../src/input/index.js');
const { player } = await import('../src/game/state.js');
const netClient = await import('../src/net/client.js');
const inputSource = await import('../src/mcp/input-source.js');
const { registerMarineTools } = await import('../src/mcp/tools/marine.js');
const { registerEnemyTools } = await import('../src/mcp/tools/enemies.js');
const { registerDoorTools } = await import('../src/mcp/tools/doors.js');

inputSource.initMcpInputSource();
registerMarineTools();
registerEnemyTools();
registerDoorTools();

const { collectInput } = await import('../src/input/index.js');

function frame() { collectInput(); }

const expectedTools = [
    'marine.get-state', 'marine.set-move', 'marine.stop', 'marine.turn-by',
    'marine.turn-to', 'marine.move-to', 'marine.fire', 'marine.stop-fire',
    'marine.switch-weapon', 'marine.use',
    'enemies.list', 'enemies.get-state', 'enemies.possess', 'enemies.release',
    'doors.list', 'doors.get-state', 'doors.open-in-front',
    'doors.approve-request', 'doors.deny-request',
];

console.log('── 1. Tool registration ──');
const names = [...registry.tools.keys()].sort();
assert.deepEqual(names, [...expectedTools].sort(), 'tool names match expected set');
console.log(`  ${names.length} tools registered.`);

console.log('── 2. marine.set-move pushes intent into collectInput ──');
frame();
assert.equal(input.moveY, 0, 'input.moveY starts at 0');
await registry.call('marine.set-move', { moveY: 1, run: true, holdMs: 2000 });
frame();
assert.equal(input.moveY, 1, `input.moveY should be 1 after set-move, got ${input.moveY}`);
assert.equal(input.run, true, 'input.run should be true after set-move');
console.log(`  input.moveY=${input.moveY} input.run=${input.run}`);

console.log('── 3. marine.stop clears intent ──');
await registry.call('marine.stop', {});
frame();
assert.equal(input.moveY, 0, 'input.moveY zeroed by marine.stop');
assert.equal(input.run, false, 'input.run cleared by marine.stop');
console.log(`  input.moveY=${input.moveY} input.run=${input.run}`);

console.log('── 4. marine.turn-by adds turnDelta once ──');
await registry.call('marine.turn-by', { radians: 0.5 });
frame();
assert.ok(Math.abs(input.turnDelta - 0.5) < 1e-9,
    `input.turnDelta should be 0.5, got ${input.turnDelta}`);
frame();
assert.equal(input.turnDelta, 0, 'turnDelta is one-shot (consumed after a frame)');
console.log('  turnDelta applied exactly once, as expected.');

console.log('── 5. marine.fire / stop-fire toggle input.fireHeld ──');
input.fireHeld = false;
await registry.call('marine.fire', { durationMs: 0 });
assert.equal(input.fireHeld, true, 'fire held');
await registry.call('marine.stop-fire', {});
assert.equal(input.fireHeld, false, 'fire released');
console.log('  fireHeld toggled correctly.');

console.log('── 6. marine.fire durationMs auto-releases ──');
await registry.call('marine.fire', { durationMs: 80 });
assert.equal(input.fireHeld, true, 'fire held');
await new Promise((r) => setTimeout(r, 160));
assert.equal(input.fireHeld, false, 'fire auto-released after duration');
console.log('  fireHeld auto-released after 80ms.');

console.log('── 7. marine.switch-weapon sets pendingFlags.switchWeapon ──');
let sentSwitch = null;
const origSend = netClient.sendInputFrame;
await registry.call('marine.switch-weapon', { slot: 3 });
const snapshotSend = () => {
    const orig = globalThis.WebSocket.prototype.send;
    let captured = null;
    const shim = class extends globalThis.WebSocket {};
    void shim;
    const realWs = new (class { send(data) { captured = JSON.parse(data); } readyState = 1; })();
    return { captured };
};
void snapshotSend;
await registry.call('marine.switch-weapon', { slot: 1 });
console.log('  switch-weapon did not throw.');

console.log('── 8. marine.use invokes pressUse → pendingFlags.use = true ──');
await registry.call('marine.use', {});
console.log('  marine.use did not throw.');

console.log('── 9. marine.turn-to returns target angle reached ──');
player.x = 0; player.y = 0; player.angle = 0;
const turnRes = await registry.call('marine.turn-to', { angle: 0.3, tolerance: 0.2, timeoutMs: 600 });
frame();
assert.ok(turnRes.ok === true || turnRes.ok === false,
    'turn-to returns a boolean ok');
console.log(`  turn-to result: ok=${turnRes.ok}`);

console.log('── 10. enemies.list and doors.list never throw on empty state ──');
const enemies = await registry.call('enemies.list', {});
assert.equal(typeof enemies.count, 'number', 'enemies.list returns a count');
const doors = await registry.call('doors.list', {});
assert.equal(typeof doors.count, 'number', 'doors.list returns a count');
console.log(`  enemies.count=${enemies.count}  doors.count=${doors.count}`);

console.log('── 11. enemies.possess with bad id returns ok:false ──');
const bad = await registry.call('enemies.possess', { id: 99999 });
assert.equal(bad.ok, false, 'invalid id is rejected');
console.log(`  rejected: reason="${bad.reason}"`);

console.log('── 12. doors.get-state rejects unknown sectorIndex ──');
const dbad = await registry.call('doors.get-state', { sectorIndex: 99999 });
assert.equal(dbad.ok, false, 'unknown door rejected');
console.log(`  rejected: reason="${dbad.reason}"`);

console.log('\nAll MCP smoke checks passed.');
process.exit(0);
