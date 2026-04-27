/**
 * Audio facade — environment-neutral entry point for sound playback.
 *
 * Engine modules call `playSound(name)` to express "play this clip now".
 * The facade forwards that intent to a swappable host:
 *
 *   - Browser: [index.js](../../index.js) installs the Web Audio host from
 *     `src/client/audio/web-audio.js` via `createWebAudioHost()`.
 *   - Server: `server/world-host/hosts.js` installs the recording host from
 *     `src/engine/ports/recording-audio-host.js`, which buffers sound names
 *     into an event list shipped with the next snapshot so clients can replay
 *     them.
 *   - Default: no-op (lets the engine run headless without noise).
 */

let host = {};

/**
 * Install an audio host. Pass null/undefined to reset to no-op.
 */
export function setAudioHost(impl) {
    host = impl || {};
}

/** @param {string} [forSessionId] — if set (multiplayer), only that client replays. */
export function playSound(name, forSessionId) {
    return host.playSound?.(name, forSessionId);
}
