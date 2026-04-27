/**
 * Browser entry point — installs the DOM renderer + Web Audio hosts,
 * opens a WebSocket to the authoritative game server, and drives the
 * per-frame input/render loop.
 *
 * All gameplay simulation runs on the server; this file only
 *   1. connects and authenticates the session
 *   2. streams local input upstream each frame
 *   3. applies world snapshots into shared `state.js`
 *   4. renders the scene (camera + HUD + transient events)
 */

import { getPlayerActor } from './src/engine/possession.js';
import { state, getMarineActor } from './src/engine/state.js';
import { mapData } from './src/engine/data/maps.js';
import { updateCamera, startCullingLoop, updateHud, setRendererHost } from './src/engine/ports/renderer.js';
import { setAudioHost } from './src/engine/ports/audio.js';
import { createDomRendererHost } from './src/client/renderer/dom/host.js';
import { createWebAudioHost } from './src/client/audio/web-audio.js';
import { updateMenuSelection } from './src/client/ui/menu.js';
import { isBodySwapOpen } from './src/client/ui/body-swap.js';
import { isJoinChallengeOpen } from './src/client/ui/join-challenge.js';
import { hideInitialOverlay } from './src/client/ui/overlay.js';
import { initKeyboardInput } from './src/client/input/keyboard.js';
import { initMouseInput } from './src/client/input/mouse.js';
import { initTouchInput } from './src/client/input/touch.js';
import { initGamepadInput } from './src/client/input/gamepad.js';
import { initDebugMenu, updateDebugStats } from './src/client/ui/debug.js';
import './src/client/ui/spectator.js';
import './src/client/ui/body-swap.js';
import './src/client/ui/join-challenge.js';
import { updateDoorOperator } from './src/client/ui/door-operator.js';
import {
    connect as connectToServer,
    sendInputFrame,
    getSession,
    prepareForLocalSpawn,
} from './src/client/net/client.js';
import { spawnThings } from './src/engine/things/spawner.js';
import { initMcpInterface } from './src/client/webmcp/index.js';
import {
    beginLevelTransition,
    rebuildLevelScene,
    endLevelTransition,
    scheduleIntroCameraDrop,
} from './src/client/app/level-loader.js';

let debugEnabled = false;
let ready = false;

window.debug = function() {
    if (!debugEnabled) {
        debugEnabled = true;
        initDebugMenu();
        console.log('Debug menu enabled');
    }
};

/**
 * Render loop. The server owns simulation — we just forward input,
 * draw the latest state, and update the HUD/camera for the session's
 * controlled body (or follow target when spectating).
 */
function frame() {
    if (!ready || !mapData) {
        requestAnimationFrame(frame);
        return;
    }

    sendInputFrame();

    const controlled = getPlayerActor();
    const controlledDead = Boolean(controlled) && (controlled.hp <= 0 || controlled.deathMode);
    if (!controlledDead && !isBodySwapOpen() && !isJoinChallengeOpen()) {
        updateHud();
    } else if (isBodySwapOpen() || isJoinChallengeOpen()) {
        updateHud();
    }
    updateCamera();
    updateDoorOperator();

    if (import.meta.env.DEV || debugEnabled) updateDebugStats();

    requestAnimationFrame(frame);
}

async function applyServerMap(name, _mapData) {
    // Server pushed the authoritative map. Build the scene and any
    // gameplay bookkeeping the renderer depends on (spatial grid,
    // door/lift/crusher containers, sector adjacency). Things are
    // respawned locally so the renderer can attach sprites to the
    // same thingIndex positions the server is broadcasting against.
    const isInitialLoad = !ready;
    await beginLevelTransition(isInitialLoad);
    // Re-clear right before `spawnThings()` so the spawn pass is
    // guaranteed to start from index 0 — even if anything mutated
    // `state.things` during the begin-transition await. Without this
    // synchronous reset, `spawnThings` (which appends via
    // `registerThingEntry`) would allocate at high indices and the DOM
    // built off `mapData._thingIndexByMapIdx` would never match the
    // server's snapshot indices, leaving every enemy frozen until reload.
    prepareForLocalSpawn();
    spawnThings();
    await rebuildLevelScene(isInitialLoad);
    endLevelTransition(isInitialLoad);

    if (!ready) {
        startCullingLoop();
        updateMenuSelection();
        updateHud();
        updateCamera();
        scheduleIntroCameraDrop();
        await new Promise(resolve => setTimeout(resolve, 600));
        hideInitialOverlay();
        ready = true;
    }
}

async function init() {
    setRendererHost(createDomRendererHost());
    setAudioHost(createWebAudioHost());

    if (import.meta.env.DEV) { debugEnabled = true; initDebugMenu(); }

    initKeyboardInput();
    initMouseInput();
    initTouchInput();
    initGamepadInput();
    initMcpInterface();

    connectToServer({
        onMapLoad: applyServerMap,
    });

    requestAnimationFrame(frame);
    window.focus();
}

init();

// expose for the debug console / spectator UI
window.__cssdoom = { state, getMarineActor, session: getSession() };
