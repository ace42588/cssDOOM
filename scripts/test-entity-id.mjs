/**
 * Stage 2: runtime id formatting, resolution, and possess-target normalization.
 *
 * Run: node scripts/test-entity-id.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getMarine, state } from '../src/game/state.js';
import { loadMapHeadless } from '../src/game/lifecycle.js';
import {
    formatRuntimeId,
    resolveRuntimeId,
    normalizePossessTargetId,
} from '../src/game/entity/id.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mapsDir = path.join(__dirname, '..', 'public', 'maps');

const readMapJson = async (name) => {
    const raw = await fs.readFile(path.join(mapsDir, `${name}.json`), 'utf8');
    return JSON.parse(raw);
};

await loadMapHeadless('E1M1', readMapJson, { fullReset: true });

assert.equal(formatRuntimeId(getMarine()), 'actor:0');

const enemy = state.actors.find((t) => t && t.type === 3001 && t.ai);
assert.ok(enemy, 'expected imp');
const enemyActorIdx = enemy.actorIndex;
assert.equal(formatRuntimeId(enemy), `actor:${enemyActorIdx}`);

let doorEntity = null;
for (const entry of state.doorState.values()) {
    if (entry?.doorEntity) {
        doorEntity = entry.doorEntity;
        break;
    }
}
assert.ok(doorEntity, 'expected at least one door entity');
assert.equal(formatRuntimeId(doorEntity), `door:${doorEntity.sectorIndex}`);

assert.strictEqual(resolveRuntimeId('actor:0'), getMarine());
assert.strictEqual(resolveRuntimeId('player'), getMarine());
assert.strictEqual(resolveRuntimeId(`actor:${enemyActorIdx}`), enemy);
assert.strictEqual(
    resolveRuntimeId(`door:${doorEntity.sectorIndex}`),
    doorEntity,
);
assert.equal(resolveRuntimeId('nope'), null);
assert.equal(resolveRuntimeId('thing:999999'), null);

assert.deepEqual(normalizePossessTargetId('Marine'), {
    bodySwap: 'actor:0',
    requested: 'actor:0',
});
assert.deepEqual(normalizePossessTargetId('PLAYER'), {
    bodySwap: 'actor:0',
    requested: 'actor:0',
});
assert.deepEqual(normalizePossessTargetId(`actor:${enemyActorIdx}`), {
    bodySwap: `actor:${enemyActorIdx}`,
    requested: `actor:${enemyActorIdx}`,
});
assert.deepEqual(normalizePossessTargetId(`door:${doorEntity.sectorIndex}`), {
    bodySwap: `door:${doorEntity.sectorIndex}`,
    requested: `door:${doorEntity.sectorIndex}`,
});
assert.equal(normalizePossessTargetId('door:E1M1:7'), null);
assert.equal(normalizePossessTargetId(''), null);
assert.equal(normalizePossessTargetId(null), null);

console.log('entity id (stage 2): ok');
