/**
 * Gamepad Input
 *
 * Gamepad/controller support using gamecontroller.js. Maps standard gamepad
 * controls to DOOM actions:
 *
 *   Left stick:        move forward/backward + strafe left/right
 *   Right stick:       turn left/right
 *   A / button0:       use (open doors, activate switches/lifts)
 *   Right trigger:     fire weapon
 *   Left/Right bumpers: cycle weapons
 *   Start:             toggle menu
 *   D-pad:             move (alternative to left stick)
 *
 * Registers an input provider that supplies moveX, moveY, and turnDelta
 * to the unified input system.
 *
 * Uses gamecontroller.js which handles connection/disconnection, polling,
 * and deadzone management via the Gamepad API.
 */

import 'gamecontroller.js';
import { input } from './index.js';
import { getMarine } from '../game/state.js';
import { isMenuOpen, toggleMenu } from '../ui/menu.js';
import { registerInputProvider } from './index.js';
import { pressUse, requestWeaponSwitch } from '../net/client.js';
import { shouldOfferRespawnReload } from './respawn.js';

const STICK_DEADZONE = 0.15;
const TURN_SENSITIVITY = 0.04;

// Module-local analog state
let moveX = 0, moveY = 0, turnDelta = 0;

let connected = false;

/**
 * Initialise gamepad input. The gamecontroller.js library auto-detects
 * connections; we just need to bind actions when a gamepad appears.
 */
export function initGamepadInput() {
    if (!window.gameControl) return;

    registerInputProvider(getInput);

    window.gameControl.on('connect', gamepad => {
        connected = true;
        setupGamepad(gamepad);
    });

    window.gameControl.on('disconnect', () => {
        connected = false;
        moveX = 0;
        moveY = 0;
        turnDelta = 0;
    });
}

/** Returns true if a gamepad is currently connected. */
export function isGamepadConnected() {
    return connected;
}

// ============================================================================
// Input Provider
// ============================================================================

function getInput() {
    return { moveX, moveY, turnDelta };
}

// ============================================================================
// Gamepad Binding
// ============================================================================

function setupGamepad(gamepad) {
    // Set deadzone threshold for analog sticks
    gamepad.set('axeThreshold', STICK_DEADZONE);

    // --- A / Cross (button0): Use ---
    gamepad.before('button0', () => {
        if (handleDeadRestart()) return;
        if (isMenuOpen()) return;
        pressUse();
    });

    // --- Right trigger (R2 / button7): Fire ---
    gamepad.before('r2', () => {
        if (handleDeadRestart()) return;
        if (isMenuOpen()) return;
        input.fireHeld = true;
    });
    gamepad.after('r2', () => {
        input.fireHeld = false;
    });

    // --- Left bumper (L1 / button4): Previous weapon ---
    gamepad.before('l1', () => {
        if (isMenuOpen()) return;
        cycleWeapon(-1);
    });

    // --- Right bumper (R1 / button5): Next weapon ---
    gamepad.before('r1', () => {
        if (isMenuOpen()) return;
        cycleWeapon(1);
    });

    // --- Start (button9): Toggle menu ---
    gamepad.before('start', () => {
        toggleMenu(!isMenuOpen());
    });

    // --- D-pad: alternative movement ---
    gamepad.on('up0', () => { moveY = 1; });
    gamepad.after('up0', () => { moveY = 0; });
    gamepad.on('down0', () => { moveY = -1; });
    gamepad.after('down0', () => { moveY = 0; });
    gamepad.on('left0', () => { moveX = -1; });
    gamepad.after('left0', () => { moveX = 0; });
    gamepad.on('right0', () => { moveX = 1; });
    gamepad.after('right0', () => { moveX = 0; });

    // --- Analog stick polling: read raw axes each frame ---
    window.gameControl.on('afterCycle', () => {
        // Left stick (axes 0): movement
        const axes0 = gamepad.axeValues[0];
        if (axes0) {
            const lx = parseFloat(axes0[0]) || 0;
            const ly = parseFloat(axes0[1]) || 0;
            moveX = Math.abs(lx) > STICK_DEADZONE ? lx : 0;
            moveY = Math.abs(ly) > STICK_DEADZONE ? -ly : 0; // invert Y
        }

        // Right stick (axes 1): turning
        if (gamepad.axeValues[1]) {
            const rx = parseFloat(gamepad.axeValues[1][0]) || 0;
            turnDelta = Math.abs(rx) > STICK_DEADZONE ? -rx * TURN_SENSITIVITY : 0;
        }
    });
}

// ============================================================================
// Helpers
// ============================================================================

function cycleWeapon(direction) {
    const owned = [...getMarine().ownedWeapons].sort((a, b) => a - b);
    const currentIndex = owned.indexOf(getMarine().currentWeapon);
    const nextIndex = (currentIndex + direction + owned.length) % owned.length;
    requestWeaponSwitch(owned[nextIndex]);
}

function handleDeadRestart() {
    if (getMarine().deathMode !== 'gameover') return false;
    if (shouldOfferRespawnReload()) {
        location.reload();
    }
    return true;
}
