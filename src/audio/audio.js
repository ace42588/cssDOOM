/**
 * Audio playback using the Web Audio API.
 *
 * Sounds are fetched and decoded into AudioBuffers on first use, then cached.
 * Playing a sound creates a lightweight AudioBufferSourceNode — no heavy media
 * pipeline initialization, so playback is near-instant even on iOS.
 *
 * iOS Safari requires the AudioContext to be created, resumed, AND a buffer
 * played inside a user gesture (touchend or click). We register global
 * listeners that unlock on the first qualifying gesture.
 */

let ctx = null;
let unlocked = false;
const bufferCache = new Map(); // sound name → Promise<AudioBuffer>

// Register unlock listeners immediately at module load time, so we catch
// the very first user gesture (e.g. tapping a menu button).
function setupUnlock() {
    const events = ['touchstart', 'touchend', 'click', 'keydown'];
    const unlock = () => {
        if (!ctx) {
            ctx = new (window.AudioContext || window.webkitAudioContext)();
        }

        if (unlocked) return;

        // Resume the context
        ctx.resume().then(() => {
            // Play a silent buffer to fully unlock iOS audio output
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

setupUnlock();

/**
 * Fetches and decodes a sound file into an AudioBuffer. The result is cached
 * so subsequent calls for the same sound return the same buffer instantly.
 */
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
            bufferCache.delete(name); // allow retry
            return null;
        });

    bufferCache.set(name, promise);
    return promise;
}

export function playSound(name) {
    if (!ctx || !unlocked) return;

    loadBuffer(name).then(buffer => {
        if (!buffer) return;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.start();
    });
}
