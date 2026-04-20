/**
 * Portal graph — sector-to-sector links derived from shared sector-polygon edges.
 *
 * Built once per map load. Consumed by the sector PVS (pvs.js) for
 * frustum-clipped flood-fill visibility.
 *
 * Why sector-polygon edges, not linedefs?
 * The shipped map JSON does not include a raw `vertices` table; linedef
 * `startVertex`/`endVertex` indices have nowhere to resolve. Sector
 * polygons, by contrast, carry explicit `{x, y}` boundary loops. Any edge
 * (A, B) shared between two different sectors' boundaries is a portal
 * between those sectors — and empirically this recovers 100% of the
 * sector adjacencies implied by two-sided linedefs, including pure
 * openings between equal-height sectors that produce no rendered wall.
 *
 * Each portal entry is one-directional (`from` -> `to`). For a shared
 * edge between sectors A and B we emit two entries: A -> B and B -> A.
 */

import { mapData } from '../../data/maps.js';

let portals = null; // Array<Array<{ to, ax, ay, bx, by }>>
let numSectors = 0;

function edgeKey(a, b) {
    // Canonical key: sorted by (x, y) so edge (A,B) == edge (B,A).
    if (a.x < b.x || (a.x === b.x && a.y <= b.y)) {
        return `${a.x},${a.y}|${b.x},${b.y}`;
    }
    return `${b.x},${b.y}|${a.x},${a.y}`;
}

export function buildPortalGraph() {
    portals = null;
    numSectors = 0;

    const sectors = mapData.sectors;
    const sectorPolygons = mapData.sectorPolygons;
    if (!sectors || !sectorPolygons) return;

    numSectors = sectors.length;
    portals = new Array(numSectors);
    for (let i = 0; i < numSectors; i++) portals[i] = null;

    // First pass: index every polygon edge by its canonical endpoint key.
    // edgeMap: key -> Array of { sectorIndex, a, b }
    const edgeMap = new Map();
    for (const sp of sectorPolygons) {
        const sectorIndex = sp.sectorIndex;
        if (sectorIndex === undefined || !sp.boundaries) continue;
        for (const loop of sp.boundaries) {
            const len = loop.length;
            if (len < 2) continue;
            for (let i = 0; i < len; i++) {
                const a = loop[i];
                const b = loop[(i + 1) % len];
                const key = edgeKey(a, b);
                let bucket = edgeMap.get(key);
                if (!bucket) {
                    bucket = [];
                    edgeMap.set(key, bucket);
                }
                bucket.push({ sectorIndex, a, b });
            }
        }
    }

    // Second pass: any edge shared by two distinct sectors is a portal.
    // Most edges have exactly two participants (the two sectors on either
    // side); occasional seams or coincident micro-edges can produce more,
    // so we pair up every distinct combination.
    for (const [, bucket] of edgeMap) {
        if (bucket.length < 2) continue;
        for (let i = 0; i < bucket.length; i++) {
            const first = bucket[i];
            for (let k = i + 1; k < bucket.length; k++) {
                const second = bucket[k];
                if (first.sectorIndex === second.sectorIndex) continue;
                addPortal(first.sectorIndex, second.sectorIndex, first.a, first.b);
                addPortal(second.sectorIndex, first.sectorIndex, first.a, first.b);
            }
        }
    }
}

function addPortal(from, to, a, b) {
    if (!portals[from]) portals[from] = [];
    portals[from].push({
        to,
        ax: a.x, ay: a.y,
        bx: b.x, by: b.y,
    });
}

/** Returns the portal list for a sector, or an empty array. */
export function getPortalsFor(sectorIndex) {
    if (!portals || sectorIndex < 0 || sectorIndex >= portals.length) return EMPTY;
    return portals[sectorIndex] || EMPTY;
}

export function getSectorCount() {
    return numSectors;
}

const EMPTY = [];
