/**
 * Sector-level Potentially Visible Set (PVS) via frustum-clipped portal flood.
 *
 * Each call seeds at the eye's current sector and walks the portal graph
 * (see portals.js — portals are derived from shared sector-polygon edges).
 * Portals are projected into the camera's local 2D frame, clipped against
 * the running sub-frustum, and the angular interval that survives is the
 * sub-frustum carried into the neighbouring sector. Closed doors / fully-
 * collapsed vertical openings are skipped via `getSectorOpening()`.
 *
 * Returns a reusable Uint8Array of length `numSectors`. Index = sector
 * index, value = 1 if visible, 0 otherwise.
 *
 * The flood is purely 2D (matching the existing horizontal-wedge culler in
 * culling.js); vertical clipping is handled by the per-element refinement
 * pass plus the door/lift opening gate.
 */

import { mapData } from '../../../engine/data/maps.js';
import { getSectorAt, pointInsideSector } from '../../../engine/physics/queries.js';
import { getSectorOpening } from '../../../engine/sound-propagation.js';
import { getPortalsFor } from './portals.js';

let visibleBuf = null;
let stack = null;
/** Dedupes stack pushes per `computeVisibleSectors` call — recreated each run. */
let pushedKeys = null;

// Last seed sector returned by `computeVisibleSectors`. PVS is now driven
// by the lerped camera pose (see `culling.js#runPvsPass` → `getControlledEye`)
// so the eye nudges across sector boundaries continuously over each tween.
// Without hysteresis, `getSectorAt` can flicker between two adjacent sectors
// for a frame as the lerped point grazes the polygon edge — and each flicker
// reseeds the portal flood from a different room, popping rooms in/out as
// the camera passes through doorways. Holding the cached sector while the
// eye is still inside its polygon eliminates the flicker; we only re-resolve
// when the eye actually leaves it.
let lastSeedSector = null;

// Match fine culling: walls use localZ > 0; a tiny plane avoids div-by-zero without
// hiding portals that graze the eye (NEAR_Z=1 was far too aggressive → pop-in).
const NEAR_Z = 1e-3;

const ANGLE_EPSILON = 1e-4;

// Extra half-FOV beyond `culling.js` (which already adds FRUSTUM_MARGIN). PVS portal
// clipping is conservative vs `wallInFrustum` / `surfaceInFrustum` (near-wall rules,
// frustum-ray vs AABB, strict angle tests) — bias slightly wide so coarse PVS never
// hides sectors the fine pass would still draw.
const PVS_HALF_FOV_EXTRA = 0.12; // ~7° each side

/** Quantize angles for push dedupe — disjoint [L,R] windows stay distinct. */
const ANGLE_Q = 4000;
function frameKey(sector, left, right) {
    return `${sector}|${Math.round(left * ANGLE_Q)}|${Math.round(right * ANGLE_Q)}`;
}

function fillAllVisible() {
    if (!visibleBuf) return null;
    visibleBuf.fill(1);
    return visibleBuf;
}

function ensureBuffers(numSectors) {
    if (!visibleBuf || visibleBuf.length !== numSectors) {
        visibleBuf = new Uint8Array(numSectors);
        stack = [];
    }
}

/**
 * Computes which sectors are potentially visible from the given eye.
 *
 * `eye` must expose `{ x, y, angle }`. `halfFov` is the value from the
 * per-element culler (atan(viewportWidth/2 / perspective) + margin); this
 * module adds a small extra wedge so coarse PVS stays conservative vs
 * fine tests (`wallInFrustum` near-wall bypass, surface ray checks, etc.).
 */
export function computeVisibleSectors(eye, halfFov) {
    const sectors = mapData.sectors;
    if (!sectors) return null;
    ensureBuffers(sectors.length);

    visibleBuf.fill(0);

    // Hysteresis: prefer the previously-seeded sector if the eye is still
    // inside it (see the `lastSeedSector` comment up top for why). This is
    // a single polygon test per frame in the steady-state case — only when
    // the eye actually crosses out do we fall back to the spatial-grid
    // lookup in `getSectorAt`.
    let seedSector = null;
    if (lastSeedSector && pointInsideSector(eye.x, eye.y, lastSeedSector)) {
        seedSector = lastSeedSector;
    } else {
        seedSector = getSectorAt(eye.x, eye.y);
    }
    if (!seedSector) {
        // Eye is outside any sector polygon — fall back to "all visible"
        // so we never accidentally hide the entire level. Drop the cache
        // so the next frame does a fresh lookup instead of clinging to a
        // sector the eye has clearly left.
        lastSeedSector = null;
        return fillAllVisible();
    }
    lastSeedSector = seedSector;
    const seedIndex = seedSector.sectorIndex;

    const half = halfFov + PVS_HALF_FOV_EXTRA;

    visibleBuf[seedIndex] = 1;

    const sin = Math.sin(eye.angle);
    const cos = Math.cos(eye.angle);
    const eyeX = eye.x;
    const eyeY = eye.y;

    pushedKeys = new Set();
    stack.length = 0;

    function tryPush(sector, leftAngle, rightAngle) {
        const key = frameKey(sector, leftAngle, rightAngle);
        if (pushedKeys.has(key)) return;
        pushedKeys.add(key);
        stack.push({ sector, leftAngle, rightAngle });
    }

    tryPush(seedIndex, -half, half);

    // Generous cap: without width-only dedupe, the same sector can be visited
    // many times with different angular windows (loops, T-junctions).
    const maxIterations = sectors.length * 64 + 512;
    let iterations = 0;

    while (stack.length > 0) {
        if (++iterations > maxIterations) break;

        const frame = stack.pop();
        const fromSector = frame.sector;
        const leftA = frame.leftAngle;
        const rightA = frame.rightAngle;

        const portals = getPortalsFor(fromSector);
        for (let i = 0; i < portals.length; i++) {
            const portal = portals[i];

            // Skip closed openings (closed doors, crushing ceilings, etc).
            if (getSectorOpening(fromSector, portal.to, { includeVisualClosing: true }) <= 0) continue;

            const interval = clipPortalToSubFrustum(
                portal.ax, portal.ay,
                portal.bx, portal.by,
                eyeX, eyeY, sin, cos,
                leftA, rightA,
            );
            if (!interval) continue;

            const to = portal.to;
            visibleBuf[to] = 1;

            tryPush(to, interval[0], interval[1]);
        }
    }

    return visibleBuf;
}

/**
 * Projects a portal segment into the camera's local 2D frame, clips it to
 * the near plane, then intersects its angular extent with the incoming
 * sub-frustum [leftA, rightA]. Returns the clipped [left, right] angle
 * interval, or null if the portal is fully outside the sub-frustum / behind
 * the camera.
 */
function clipPortalToSubFrustum(ax, ay, bx, by, eyeX, eyeY, sin, cos, leftA, rightA) {
    let aRelX = ax - eyeX;
    let aRelY = ay - eyeY;
    let bRelX = bx - eyeX;
    let bRelY = by - eyeY;

    let aLocalX = aRelX * cos + aRelY * sin;
    let aLocalZ = -aRelX * sin + aRelY * cos;
    let bLocalX = bRelX * cos + bRelY * sin;
    let bLocalZ = -bRelX * sin + bRelY * cos;

    // Both endpoints behind the near plane — portal cannot be seen.
    if (aLocalZ < NEAR_Z && bLocalZ < NEAR_Z) return null;

    // Clip the endpoint that's behind the near plane onto Z = NEAR_Z.
    if (aLocalZ < NEAR_Z) {
        const t = (NEAR_Z - aLocalZ) / (bLocalZ - aLocalZ);
        aLocalX = aLocalX + t * (bLocalX - aLocalX);
        aLocalZ = NEAR_Z;
    } else if (bLocalZ < NEAR_Z) {
        const t = (NEAR_Z - bLocalZ) / (aLocalZ - bLocalZ);
        bLocalX = bLocalX + t * (aLocalX - bLocalX);
        bLocalZ = NEAR_Z;
    }

    let aAngle = Math.atan2(aLocalX, aLocalZ);
    let bAngle = Math.atan2(bLocalX, bLocalZ);
    if (aAngle > bAngle) {
        const tmp = aAngle;
        aAngle = bAngle;
        bAngle = tmp;
    }

    const left = aAngle > leftA ? aAngle : leftA;
    const right = bAngle < rightA ? bAngle : rightA;
    if (right - left <= ANGLE_EPSILON) return null;

    return [left, right];
}

/** Drops cached buffers so the next call sizes for a freshly loaded map. */
export function resetPvs() {
    visibleBuf = null;
    stack = null;
    pushedKeys = null;
    // The cached seed belongs to the previous map's sector array — letting
    // it survive a map switch would either point at a freed sector object
    // or, worse, an index that aliases an unrelated sector in the new map.
    lastSeedSector = null;
}
