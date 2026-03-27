/**
 * Ceiling surface construction.
 */

import { SKY_TEXTURE } from '../constants.js';

import { mapData } from '../../../shared/maps.js';
import { buildHorizontalSurface } from './horizontal.js';

export function buildCeilings() {
    if (!mapData.sectorPolygons) return;

    for (const sector of mapData.sectorPolygons) {
        if (sector.ceilingTexture && sector.ceilingTexture !== SKY_TEXTURE) {
            buildHorizontalSurface(sector, sector.ceilingHeight, sector.ceilingTexture, 'ceiling');
        }
    }
}
