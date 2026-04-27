/**
 * Stage 1: marine (`player`) and spawned enemies share the same top-level
 * field names so future actor-unification can treat them uniformly.
 *
 * Run: node scripts/test-actor-shape.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getMarineActor, state } from '../src/engine/state.js';
import { loadMapHeadless } from '../src/engine/lifecycle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mapsDir = path.join(__dirname, '..', 'public', 'maps');

const readMapJson = async (name) => {
    const raw = await fs.readFile(path.join(mapsDir, `${name}.json`), 'utf8');
    return JSON.parse(raw);
};

await loadMapHeadless('E1M1', readMapJson, { fullReset: true });

const enemy = state.actors.find((t) => t && t.type === 3001 && t.ai);
assert.ok(enemy, 'expected a spawned imp (thing type 3001)');

const marineKeys = Object.keys(getMarineActor()).sort();
for (const k of marineKeys) {
    assert.ok(
        Object.prototype.hasOwnProperty.call(enemy, k),
        `enemy missing marine field "${k}"`,
    );
}

const marine = getMarineActor();
assert.equal(marine.kind, 'marine');
assert.ok(marine.ownedWeapons.has(1), 'marine should own fist slot 1');
assert.equal(marine.currentWeapon, 2);
assert.ok(enemy.ownedWeapons?.has(103), 'imp should own intrinsic weapon slot 103');
assert.equal(enemy.currentWeapon, 103);

console.log('actor shape (stage 1): ok');
