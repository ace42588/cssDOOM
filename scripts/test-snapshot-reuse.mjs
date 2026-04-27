/**
 * Cross-tick safety check for `server/world.js#serializeCurrentWorld`.
 *
 * The reusable `_current.*` Maps are mutated in place every tick. The diff
 * path therefore must clone records when emitting them onto the wire, so
 * a snapshot captured by an MCP ring (or any subscriber holding the
 * outbound message) survives the next tick unscathed.
 *
 * This script:
 *   1. Boots the world.
 *   2. Builds a delta against an empty baseline (forces every entity into
 *      `spawn`).
 *   3. Snapshots primitive field values from a spawned thing.
 *   4. Mutates the live game state.
 *   5. Builds the next tick's delta.
 *   6. Asserts the captured spawn record still reflects step 3.
 *
 * Run:  node scripts/test-snapshot-reuse.mjs
 */

import assert from 'node:assert/strict';

import {
    installEngineHosts,
    useGameServices,
    loadMap,
    buildDeltasForTick,
    emptyBaseline,
} from '../server/world.js';
import { state, getMarineActor } from '../src/engine/state.js';
import { createSgnlServices } from '../server/sgnl/index.js';

installEngineHosts();
useGameServices(createSgnlServices());
await loadMap('E1M1');

const fakeConn = { baseline: emptyBaseline(), role: 'spectator', controlledId: null, followTargetId: null };

const buildA = buildDeltasForTick();
const deltaA = buildA(fakeConn);

assert.ok(deltaA.things, 'expected things bucket on first delta');
assert.ok(Array.isArray(deltaA.things.spawn), 'spawn should be an array');
assert.ok(deltaA.things.spawn.length > 0, 'first delta should spawn at least one thing');

const sampleThing = deltaA.things.spawn[0];
const capturedX = sampleThing.x;
const capturedY = sampleThing.y;
const capturedHp = sampleThing.hp;
const capturedId = sampleThing.id;

assert.ok(deltaA.actors?.spawn, 'expected actors snapshot');
const marine = getMarineActor();
assert.ok(marine, 'expected a marine-type actor to exist');
const marineSnap = deltaA.actors.spawn.find((r) => r.id === marine.actorIndex);
assert.ok(marineSnap, `expected marine actor:${marine.actorIndex} in actors.spawn`);
const capturedPlayerHp = marineSnap.hp;
const capturedAmmoRef = marineSnap.ammo;
const capturedClipsForBullets = marineSnap.ammo.bullets;

const liveThing = state.things.find((t) => t.thingIndex === capturedId);
assert.ok(liveThing, 'live thing for captured id must exist');
liveThing.x += 9999;
liveThing.y -= 9999;
if (typeof liveThing.hp === 'number') liveThing.hp = Math.max(0, liveThing.hp - 5);
marine.hp = Math.max(0, (marine.hp || 0) - 17);
if (marine.ammo && typeof marine.ammo.bullets === 'number') {
    marine.ammo.bullets = Math.max(0, marine.ammo.bullets - 3);
}

const buildB = buildDeltasForTick();
const fakeConn2 = { baseline: emptyBaseline(), role: 'spectator', controlledId: null, followTargetId: null };
buildB(fakeConn2);

assert.equal(sampleThing.x, capturedX, 'tick A spawned record must keep its x after tick B rebuilds _current');
assert.equal(sampleThing.y, capturedY, 'tick A spawned record must keep its y after tick B rebuilds _current');
assert.equal(sampleThing.hp, capturedHp, 'tick A spawned record must keep its hp after tick B rebuilds _current');

assert.equal(marineSnap.hp, capturedPlayerHp, 'tick A marine hp snapshot must not alias live marine');
assert.strictEqual(marineSnap.ammo, capturedAmmoRef, 'ammo reference identity should be stable inside the captured delta');
assert.equal(marineSnap.ammo.bullets, capturedClipsForBullets, 'tick A marine ammo.bullets must not alias the live ammo object');

console.log('snapshot reuse safety: ok');
console.log(`  tick A captured thing#${capturedId} x=${capturedX} y=${capturedY} hp=${capturedHp}`);
console.log(`  tick A captured marine.hp=${capturedPlayerHp} ammo.bullets=${capturedClipsForBullets}`);

process.exit(0);
