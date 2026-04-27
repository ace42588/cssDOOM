/**
 * Headless engine host wiring for the authoritative server.
 */

import { setRendererHost } from '../../src/engine/ports/renderer.js';
import { createRecordingRendererHost } from '../../src/engine/ports/recording-renderer-host.js';
import { setAudioHost } from '../../src/engine/ports/audio.js';
import { createRecordingAudioHost } from '../../src/engine/ports/recording-audio-host.js';
import { setGameServices } from '../../src/engine/services.js';

import { setMapLoadEventHosts } from '../world/maps.js';

let rendererHost = null;
let audioHost = null;

export function installEngineHosts() {
    rendererHost = createRecordingRendererHost();
    setRendererHost(rendererHost);
    audioHost = createRecordingAudioHost();
    setAudioHost(audioHost);
    setMapLoadEventHosts({ rendererHost, audioHost });
    setGameServices({});
}

export function useGameServices(impl) {
    setGameServices(impl || {});
}

export function drainRendererEvents() {
    return rendererHost?.drainEvents?.() ?? [];
}

export function drainSoundEvents() {
    return audioHost?.drainSounds?.() ?? [];
}
