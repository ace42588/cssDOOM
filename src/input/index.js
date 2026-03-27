/**
 * Input Manager
 *
 * Provides a unified input abstraction so the game layer reads a single
 * `input` object regardless of how many input sources exist.
 *
 * Each input module (keyboard, touch, gamepad, etc.) registers a provider
 * function via `registerInputProvider()`. The provider returns the module's
 * current contribution to the input state:
 *
 *   { moveX, moveY, turn, turnDelta, run }
 *
 *   moveX:     -1 to 1, strafe (negative = left, positive = right)
 *   moveY:     -1 to 1, forward/backward (positive = forward)
 *   turn:      -1 to 1, rate-based turning applied with turnSpeed * deltaTime
 *   turnDelta: radians, absolute rotation added this frame (mouse, analog stick)
 *   run:       boolean, whether the run modifier is active
 *
 * `collectInput()` is called once per frame before movement. It resets
 * the input state, sums all provider contributions, and clamps the result.
 * Adding a new input method requires only writing the module and calling
 * `registerInputProvider` — no changes to the game layer.
 */

const providers = [];

/**
 * Unified input state — owned by the input layer, read by the game layer.
 * Populated each frame by collectInput() from all registered providers.
 */
export const input = { moveX: 0, moveY: 0, turn: 0, turnDelta: 0, run: false, fireHeld: false };

/**
 * Register an input provider function. The function will be called each
 * frame and should return an object with any subset of the input fields.
 */
export function registerInputProvider(provider) {
    providers.push(provider);
}

/**
 * Collect input from all registered providers into the input state.
 * Called once per frame before movement processing.
 */
export function collectInput() {
    let moveX = 0, moveY = 0, turn = 0, turnDelta = 0, run = false;

    for (let i = 0; i < providers.length; i++) {
        const p = providers[i]();
        moveX += p.moveX || 0;
        moveY += p.moveY || 0;
        turn += p.turn || 0;
        turnDelta += p.turnDelta || 0;
        if (p.run) run = true;
    }

    input.moveX = Math.max(-1, Math.min(1, moveX));
    input.moveY = Math.max(-1, Math.min(1, moveY));
    input.turn = Math.max(-1, Math.min(1, turn));
    input.turnDelta = turnDelta;
    input.run = run;
}
