import assert from 'node:assert/strict';

import {
    diffAndCommit,
    diffIdMap,
    diffKeyedUpdates,
    diffRecord,
    emptyBaseline,
    fieldsEqual,
    resetBaseline,
} from '../server/world/snapshots.js';

assert.equal(fieldsEqual(1, 1), true);
assert.equal(fieldsEqual(1, 2), false);
assert.equal(fieldsEqual([1, { a: 'x' }], [1, { a: 'x' }]), true);
assert.equal(fieldsEqual([1, { a: 'x' }], [1, { a: 'y' }]), false);
assert.equal(fieldsEqual({ a: 1, b: [2] }, { a: 1, b: [2] }), true);

assert.deepEqual(diffRecord(null, { a: 1, b: undefined, c: [2] }), { a: 1, c: [2] });
assert.equal(diffRecord({ a: 1 }, { a: 1 }), null);
assert.deepEqual(diffRecord({ a: 1, b: [1] }, { a: 2, b: [1] }), { a: 2 });

const baselineIds = new Map([[1, { id: 1, x: 10, hp: 20 }]]);
const currentIds = new Map([
    [1, { id: 1, x: 15, hp: 20 }],
    [2, { id: 2, x: 30, hp: 5 }],
]);
const idDelta = diffIdMap(baselineIds, currentIds);
assert.deepEqual(idDelta.spawn, [{ id: 2, x: 30, hp: 5 }]);
assert.deepEqual(idDelta.update, [{ id: 1, x: 15 }]);
assert.deepEqual(idDelta.despawn, []);
assert.deepEqual(baselineIds.get(1), { id: 1, x: 15, hp: 20 });

currentIds.delete(1);
const idDeltaB = diffIdMap(baselineIds, currentIds);
assert.deepEqual(idDeltaB.spawn, []);
assert.deepEqual(idDeltaB.update, []);
assert.deepEqual(idDeltaB.despawn, [1]);
assert.equal(baselineIds.has(1), false);

const baselineSectors = new Map([[7, { sectorIndex: 7, open: false, passable: false }]]);
const currentSectors = new Map([
    [7, { sectorIndex: 7, open: true, passable: false }],
    [8, { sectorIndex: 8, open: false, passable: true }],
]);
assert.deepEqual(diffKeyedUpdates(baselineSectors, currentSectors, 'sectorIndex'), [
    { sectorIndex: 7, open: true },
    { sectorIndex: 8, open: false, passable: true },
]);

const conn = {
    baseline: emptyBaseline(),
    role: 'player',
    controlledId: 'actor:0',
    followTargetId: null,
};
const current = {
    actors: new Map([[0, { id: 0, x: 1, y: 2, ammo: { bullets: 50 } }]]),
    things: new Map([[1, { id: 1, x: 10 }]]),
    projectiles: new Map(),
    doors: new Map([[4, { sectorIndex: 4, open: false }]]),
    lifts: new Map(),
    crushers: new Map(),
};
const deltaA = diffAndCommit(conn, current, {
    tick: 1,
    serverTime: 100,
    rendererEvents: [],
    soundEvents: [],
});
assert.equal(deltaA.type, 'snapshot');
assert.equal(deltaA.role, 'player');
assert.deepEqual(deltaA.actors.spawn, [{ id: 0, x: 1, y: 2, ammo: { bullets: 50 } }]);
assert.deepEqual(deltaA.things.spawn, [{ id: 1, x: 10 }]);

current.actors.get(0).x = 3;
current.actors.get(0).ammo = { bullets: 49 };
current.things.get(1).x = 11;
const deltaB = diffAndCommit(conn, current, {
    tick: 2,
    serverTime: 200,
    rendererEvents: [{ fn: 'x', args: [] }],
    soundEvents: ['pistol'],
});
assert.equal(deltaB.role, undefined);
assert.deepEqual(deltaB.actors.update, [{ id: 0, x: 3, ammo: { bullets: 49 } }]);
assert.deepEqual(deltaB.things.update, [{ id: 1, x: 11 }]);
assert.deepEqual(deltaB.rendererEvents, [{ fn: 'x', args: [] }]);
assert.deepEqual(deltaB.soundEvents, ['pistol']);

resetBaseline(conn);
assert.notEqual(conn.baseline, null);
assert.equal(conn.baseline.actors.size, 0);
assert.equal(conn.baseline.things.size, 0);

console.log('snapshot delta helpers: ok');
