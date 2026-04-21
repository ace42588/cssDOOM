import assert from 'node:assert/strict';

import { state } from '../src/game/state.js';
import { resetLevelWorldState } from '../src/game/state-reset.js';

state.things.push({ thingIndex: 0 });
state.projectiles.push({ id: 1 });
state.nextProjectileId = 42;
state.doorState.set(1, { sectorIndex: 1 });
state.liftState.set(2, { sectorIndex: 2 });
state.crusherState.set(3, { sectorIndex: 3 });

resetLevelWorldState();

assert.equal(state.things.length, 0);
assert.equal(state.projectiles.length, 0);
assert.equal(state.nextProjectileId, 0);
assert.equal(state.doorState.size, 0);
assert.equal(state.liftState.size, 0);
assert.equal(state.crusherState.size, 0);

console.log('state reset helpers: ok');

