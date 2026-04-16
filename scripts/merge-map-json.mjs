#!/usr/bin/env node
/**
 * One-time / CI transform: merge sectors + sectorPolygons, drop vertices,
 * slim linedefs/sidedefs. Writes maps in place under public/maps.
 */
import fs from 'fs';
import path from 'path';

const MAPS_DIR = path.resolve('public/maps');

function slimLinedef(ld) {
  return {
    flags: ld.flags,
    specialType: ld.specialType,
    sectorTag: ld.sectorTag,
    frontSidedef: ld.frontSidedef,
    backSidedef: ld.backSidedef,
  };
}

function slimSidedef(sd) {
  return { sectorIndex: sd.sectorIndex };
}

function mergeMap(data) {
  const sectors = data.sectors;
  const polys = data.sectorPolygons;
  if (!Array.isArray(sectors) || !Array.isArray(polys)) {
    throw new Error('Expected sectors[] and sectorPolygons[]');
  }

  const regionsBySector = sectors.map(() => []);
  for (const poly of polys) {
    const si = poly.sectorIndex;
    if (si < 0 || si >= sectors.length) {
      throw new Error(`sectorPolygons sectorIndex ${si} out of range (sectors length ${sectors.length})`);
    }
    regionsBySector[si].push({
      boundaries: poly.boundaries,
      hasHoles: poly.hasHoles ?? false,
    });
  }

  const mergedSectors = sectors.map((s, i) => {
    const { regions: _drop, sectorIndex: _si, ...rest } = s;
    const regions = regionsBySector[i];
    if (regions.length === 0) {
      console.warn(`[merge-map] ${data.name}: sector ${i} has no regions — placeholder empty`);
    }
    return { ...rest, sectorIndex: i, regions };
  });

  const out = { ...data };
  delete out.vertices;
  delete out.sectorPolygons;
  out.sectors = mergedSectors;
  if (Array.isArray(data.linedefs)) {
    out.linedefs = data.linedefs.map(slimLinedef);
  }
  if (Array.isArray(data.sidedefs)) {
    out.sidedefs = data.sidedefs.map(slimSidedef);
  }
  return out;
}

for (const f of fs.readdirSync(MAPS_DIR).filter((x) => x.endsWith('.json'))) {
  const fp = path.join(MAPS_DIR, f);
  const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
  if (!raw.sectorPolygons) {
    if (raw.sectors?.[0]?.regions) {
      console.log(`${f}: already merged, skip`);
      continue;
    }
    throw new Error(`${f}: missing sectorPolygons and not merged`);
  }
  const merged = mergeMap(raw);
  fs.writeFileSync(fp, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`wrote ${f}`);
}
