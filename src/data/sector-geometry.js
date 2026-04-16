/**
 * Helpers for merged map sectors: each `sectors[i]` holds gameplay fields plus
 * `regions[]` with { boundaries, hasHoles } for floor/ceiling/physics queries.
 */

/**
 * @param {number} sectorIndex
 * @param {object} sector merged sector row from map JSON
 * @param {object} region one of sector.regions
 * @returns {object} footprint compatible with buildHorizontalSurface / physics
 */
export function footprintForRegion(sectorIndex, _sector, region) {
  return {
    sectorIndex,
    boundaries: region.boundaries,
    hasHoles: region.hasHoles ?? false,
  };
}

/**
 * @param {object} mapData
 * @returns {Generator<{ sectorIndex: number, sector: object, region: object, footprint: object }>}
 */
export function* iterateSectorRegions(mapData) {
  const sectors = mapData.sectors || [];
  for (let i = 0; i < sectors.length; i++) {
    const sector = sectors[i];
    const regions = sector.regions || [];
    for (let r = 0; r < regions.length; r++) {
      const region = regions[r];
      yield {
        sectorIndex: i,
        sector,
        region,
        footprint: footprintForRegion(i, sector, region),
      };
    }
  }
}
