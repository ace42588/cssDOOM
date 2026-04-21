/**
 * Stage 3: marine lives in `state.actors[0]`; enemies in `state.actors[1..]`;
 * possession + id grammar stay consistent after load.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getMarine, state } from '../src/game/state.js';
import { loadMapHeadless } from '../src/game/lifecycle.js';
import { formatRuntimeId } from '../src/game/entity/id.js';
import { possessFor, releaseFor, getSessionIdControlling } from '../src/game/possession.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mapsDir = path.join(__dirname, '..', 'public', 'maps');

const readMapJson = async (name) => {
    const raw = await fs.readFile(path.join(mapsDir, `${name}.json`), 'utf8');
    return JSON.parse(raw);
};

await loadMapHeadless('E1M1', readMapJson, { fullReset: true });

assert.strictEqual(state.actors[0], getMarine());
assert.ok(state.actors.length >= 2, 'expected at least one enemy actor');

const imp = state.actors.find((a) => a && a.type === 3001 && a.ai);
assert.ok(imp, 'expected imp in actors');
assert.equal(formatRuntimeId(imp), `actor:${imp.actorIndex}`);

const sid = 'test-session';
assert.equal(possessFor(sid, imp), true);
assert.strictEqual(getSessionIdControlling(imp), sid);
releaseFor(sid);

console.log('possession peers (stage 3): ok');
