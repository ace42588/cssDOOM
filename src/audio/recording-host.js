/**
 * Recording audio host — buffers `playSound(name)` calls into a list of
 * sound names. The server drains these each tick and broadcasts them with
 * the snapshot so clients can replay them locally.
 */

export function createRecordingAudioHost() {
    /** @type {string[]} */
    let buffer = [];

    return {
        playSound(name) {
            if (typeof name === 'string' && name.length > 0) buffer.push(name);
        },
        drainSounds() {
            if (buffer.length === 0) return [];
            const out = buffer;
            buffer = [];
            return out;
        },
        discardSounds() {
            buffer = [];
        },
    };
}
