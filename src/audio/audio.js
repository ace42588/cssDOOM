/**
 * Audio facade — environment-neutral entry point for sound playback.
 *
 * Engine modules call `playSound(name)` to express "play this clip now".
 * The facade forwards that intent to a swappable host:
 *
 *   - Browser: [index.js](../../index.js) installs the Web Audio host from
 *     `src/audio/web-audio.js` via `createWebAudioHost()`.
 *   - Server: `server/world.js` installs the recording host from
 *     `src/audio/recording-host.js`, which buffers sound names into an event
 *     list shipped with the next snapshot so clients can replay them.
 *   - Default: no-op (lets the engine run headless without noise).
 */

let host = {};

/**
 * Install an audio host. Pass null/undefined to reset to no-op.
 */
export function setAudioHost(impl) {
    host = impl || {};
}

/**
 * Expose the currently installed host (used by the server to drain buffered
 * sound events each tick).
 */
export function getAudioHost() {
    return host;
}

/** @param {string} [forSessionId] — if set (multiplayer), only that client replays. */
export function playSound(name, forSessionId) {
    return host.playSound?.(name, forSessionId);
}
