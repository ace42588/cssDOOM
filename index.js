/**
 * Entry point — initialization and main game loop.
 */

import { state, player } from './src/game/state.js';
import { mapData, currentMap } from './src/data/maps.js';
import { updateGame } from './src/game/index.js';
import { loadMap } from './src/game/lifecycle.js';
import { updateCamera, startCullingLoop, updateHud } from './src/renderer/index.js';
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
import { emitCaepSessionEstablished } from './src/sgnl/client/caep.js';
import { initScimPush } from './src/sgnl/client/scim.js';
import { runActorRegressionChecks } from './src/game/actors/regressions.js';

let debugEnabled = false;

window.debug = function() {
    if (!debugEnabled) {
        debugEnabled = true;
        initDebugMenu();
        console.log('Debug menu enabled');
    }
};

/**
 * Game Loop
 */
function gameLoop(timestamp) {
    if (!mapData) {
        requestAnimationFrame(gameLoop);
        return;
    }

    if (player.isDead) {
        updateCamera();
        requestAnimationFrame(gameLoop);
        return;
    }

    // Body-swap picker pauses simulation (AI, movement, projectiles) while
    // the user decides which body to inhabit. The camera keeps rendering so
    // the world behind the overlay animates visually.
    if (isBodySwapOpen()) {
        updateHud();
        updateCamera();
        requestAnimationFrame(gameLoop);
        return;
    }

    updateGame(timestamp);
    updateHud();
    updateCamera();

    if (import.meta.env.DEV || debugEnabled) updateDebugStats();

    requestAnimationFrame(gameLoop);
}


/**
 * Initialization
 */
async function init() {
    void emitCaepSessionEstablished().catch((err) => {
        if (import.meta.env.DEV) console.warn('[caep] Session established push error', err);
    });

    if (import.meta.env.DEV) { debugEnabled = true; initDebugMenu(); }
    runActorRegressionChecks();
    initKeyboardInput();
    initMouseInput();
    initTouchInput();
    initGamepadInput();

    await loadMap('E1M1');
    //void initScimPush(currentMap || 'E1M1').catch((err) => {
    //    if (import.meta.env.DEV) console.warn('[scim] Init push error', err);
    //});
    startCullingLoop();
    
    updateMenuSelection();
    updateHud();
    updateCamera();

    await new Promise(resolve => setTimeout(resolve, 600));

    hideInitialOverlay();

    /* Start game loop */
    requestAnimationFrame(gameLoop);
    window.focus();
}

init();
