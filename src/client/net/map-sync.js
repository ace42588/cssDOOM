import { setMapState } from '../../engine/data/maps.js';
import { setMapName } from '../../engine/services.js';
import { resetLevelWorldState } from '../../engine/state-reset.js';
import { resetInterpolationState } from './interpolation.js';

let mapLoading = false;
let onMapLoaded = null;

export function configureMapSync({ onMapLoad } = {}) {
    onMapLoaded = onMapLoad || null;
}

export function isMapLoading() {
    return mapLoading;
}

export async function applyMapLoad(name, mapData, { sendMapLoadComplete, onBeforeRebuild } = {}) {
    mapLoading = true;
    try {
        onBeforeRebuild?.();
        setMapState(name, mapData);
        setMapName(name);
        resetForLocalSpawn();
        if (onMapLoaded) {
            await onMapLoaded(name, mapData);
        }
    } finally {
        mapLoading = false;
    }
    sendMapLoadComplete?.();
}

export function resetForLocalSpawn() {
    resetLevelWorldState();
    resetInterpolationState();
}

