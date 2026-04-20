/**
 * Recording audio host — buffers `playSound(name)` calls into a list of
 * sound names. The server drains these each tick and broadcasts them with
 * the snapshot so clients can replay them locally.
 */

export function createRecordingAudioHost() {
    /** @type {Array<string | { sound: string, forSessionId?: string }>} */
    let buffer = [];

    return {
        playSound(name, forSessionId) {
            if (typeof name !== 'string' || !name.length) return;
            if (typeof forSessionId === 'string' && forSessionId.length) {
                buffer.push({ sound: name, forSessionId });
            } else {
                buffer.push(name);
            }
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
