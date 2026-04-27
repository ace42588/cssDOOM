/**
 * Web Audio host — the original browser-side implementation of playSound().
 *
 * Sounds are fetched and decoded into AudioBuffers on first use, then cached.
 * Playing a sound creates a lightweight AudioBufferSourceNode — no heavy media
 * pipeline initialization, so playback is near-instant even on iOS.
 *
 * iOS Safari requires the AudioContext to be created, resumed, AND a buffer
 * played inside a user gesture (touchend or click). We register global
 * listeners that unlock on the first qualifying gesture.
 *
 * This module touches `document`, `window.AudioContext`, and `fetch`; it must
 * only be imported from the browser entry.
 */

let ctx = null;
let unlocked = false;
const bufferCache = new Map(); // sound name → Promise<AudioBuffer>
let unlockRegistered = false;

function setupUnlock() {
    if (unlockRegistered) return;
    unlockRegistered = true;
    const events = ['touchstart', 'touchend', 'click', 'keydown'];
    const unlock = () => {
        if (!ctx) {
            ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (unlocked) return;
        ctx.resume().then(() => {
            const silent = ctx.createBuffer(1, 1, 22050);
            const node = ctx.createBufferSource();
            node.buffer = silent;
            node.connect(ctx.destination);
            node.start();
            unlocked = true;
            for (const event of events) {
                document.removeEventListener(event, unlock, true);
            }
        });
    };
    for (const event of events) {
        document.addEventListener(event, unlock, true);
    }
}

function loadBuffer(name) {
    let promise = bufferCache.get(name);
    if (promise) return promise;

    promise = fetch(`assets/sounds/${name}.wav`)
        .then(response => {
            if (!response.ok) throw new Error(`fetch ${name}: ${response.status}`);
            return response.arrayBuffer();
        })
        .then(data => ctx.decodeAudioData(data))
        .catch(err => {
            console.error(`[audio] loadBuffer(${name}):`, err);
            bufferCache.delete(name);
            return null;
        });

    bufferCache.set(name, promise);
    return promise;
}

function playSoundImpl(name, _forSessionId) {
    if (!ctx || !unlocked) return;
    loadBuffer(name).then(buffer => {
        if (!buffer) return;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.start();
    });
}

/**
 * Create the browser Web Audio host. Installing this registers global gesture
 * listeners to unlock iOS audio on the first click/touch.
 */
export function createWebAudioHost() {
    setupUnlock();
    return {
        playSound: playSoundImpl,
    };
}
