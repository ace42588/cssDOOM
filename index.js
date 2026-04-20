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

import { state, player } from './src/game/state.js';
import { mapData, setMapState } from './src/data/maps.js';
import { updateCamera, startCullingLoop, updateHud, setRendererHost } from './src/renderer/index.js';
import { setAudioHost } from './src/audio/audio.js';
import { createDomRendererHost } from './src/renderer/dom/host.js';
import { createWebAudioHost } from './src/audio/web-audio.js';
import { updateMenuSelection } from './src/ui/menu.js';
import { isBodySwapOpen } from './src/ui/body-swap.js';
import { hideInitialOverlay } from './src/ui/overlay.js';
import { initKeyboardInput } from './src/input/keyboard.js';
import { initMouseInput } from './src/input/mouse.js';
import { initTouchInput } from './src/input/touch.js';
import { initGamepadInput } from './src/input/gamepad.js';
import { initDebugMenu, updateDebugStats } from './src/ui/debug.js';
import './src/ui/spectator.js';
import './src/ui/body-swap.js';
import { updateDoorOperator } from './src/ui/door-operator.js';
import {
    connect as connectToServer,
    sendInputFrame,
    getSession,
    prepareForLocalSpawn,
} from './src/net/client.js';
import { spawnThings } from './src/game/things/spawner.js';
import { initMcpInterface } from './src/mcp/index.js';
import {
    beginLevelTransition,
    rebuildLevelScene,
    endLevelTransition,
} from './src/app/level-loader.js';

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

    if (!player.isDead && !isBodySwapOpen()) {
        updateHud();
    } else if (isBodySwapOpen()) {
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
window.__cssdoom = { state, player, session: getSession() };
