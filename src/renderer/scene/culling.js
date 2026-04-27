/**
 * Hides scene elements that are not visible to reduce compositor workload.
 *
 * Three independent culling strategies, each togglable from the debug menu:
 *   - Frustum: hides elements outside the camera's horizontal field of view.
 *   - Distance: hides elements beyond MAX_RENDER_DISTANCE.
 *   - Backface: hides walls facing away from the camera.
 *
 * For floors/ceilings, frustum checks test all four bounding box corners
 * (not just the center) to avoid incorrectly culling large surfaces that
 * partially overlap the view.
 */

import { state } from '../../game/state.js';
import { sceneState } from '../dom.js';
import { ACTOR_DOM_KEY_OFFSET, MAX_RENDER_DISTANCE } from '../../game/constants.js';
import { spectatorActive } from '../../ui/spectator.js';
import { getControlledEye } from '../../game/possession.js';
import { computeVisibleSectors } from './pvs.js';

// Culling flags — toggled by the debug menu
export const culling = {
    pvs: true,       // Coarse: sector PVS via portal flood
    frustum: true,   // Fine: per-element frustum
    distance: true,  // Fine: per-element distance
    backface: true,  // Fine: per-wall backface
    sky: true,       // Fine: sky-wall occlusion
};

// Stats updated each frame — per-step counts track how many elements
// survived after each culling pass (in processing order)
export const cullingStats = {
    total: 0,
    culled: 0,
    afterPvs: 0,
    afterDistance: 0,
    afterBackface: 0,
    afterFrustum: 0,
    afterSky: 0,
    visibleSectors: 0,
    totalSectors: 0,
};

// Half-FOV derived from perspective: atan(viewportWidth/2 / perspective)
// Plus a generous margin so elements at the edges aren't popped in/out visibly.
const FRUSTUM_MARGIN = 0.15; // ~9° extra on each side

/**
 * Tests whether a point (relative to the player) is within the camera's
 * horizontal view frustum. Returns true if visible.
 *
 * The horizontal angle test reduces to |localX| < tan(halfFov) * localZ
 * because localZ > 0 here — equivalent to atan2(|localX|, localZ) < halfFov
 * but without the trig call. Caller precomputes tanHalfFov once per cull tick.
 */
function pointInFrustum(relX, relY, sinAngle, cosAngle, tanHalfFov) {
    // Rotate point into camera-local space (forward = +Z)
    const localX = relX * cosAngle + relY * sinAngle;
    const localZ = -relX * sinAngle + relY * cosAngle;

    // Behind the camera
    if (localZ <= 0) return false;

    return Math.abs(localX) < tanHalfFov * localZ;
}

/**
 * Tests whether a wall (defined by two endpoints) is within the frustum.
 * Returns true if either endpoint or the midpoint is visible, or if the
 * player is close enough to the wall that it could span across the view.
 */
const NEAR_WALL_DIST_SQ = 200 * 200; // Never cull walls closer than this

function wallInFrustum(wall, playerX, playerY, sinAngle, cosAngle, tanHalfFov) {
    const startRelX = wall.start.x - playerX;
    const startRelY = wall.start.y - playerY;
    const endRelX = wall.end.x - playerX;
    const endRelY = wall.end.y - playerY;

    // Never cull walls the player is close to — when up close, endpoints
    // can all land behind the camera while the wall surface is still visible.
    const dx = endRelX - startRelX;
    const dy = endRelY - startRelY;
    const lenSq = dx * dx + dy * dy;
    // Project player position onto the wall segment to find closest point
    const t = Math.max(0, Math.min(1, -(startRelX * dx + startRelY * dy) / lenSq));
    const closestX = startRelX + t * dx;
    const closestY = startRelY + t * dy;
    if (closestX * closestX + closestY * closestY < NEAR_WALL_DIST_SQ) return true;

    return pointInFrustum(startRelX, startRelY, sinAngle, cosAngle, tanHalfFov) ||
           pointInFrustum(endRelX, endRelY, sinAngle, cosAngle, tanHalfFov) ||
           pointInFrustum((startRelX + endRelX) / 2, (startRelY + endRelY) / 2, sinAngle, cosAngle, tanHalfFov);
}

/**
 * Tests whether a surface bounding box is within the frustum.
 * Checks corners, center, and whether the camera is inside the bbox
 * or the frustum edges intersect the bbox edges.
 */
function surfaceInFrustum(element, playerX, playerY, sinAngle, cosAngle, tanHalfFov, leftDirX, leftDirY, rightDirX, rightDirY) {
    const minX = element._minX - playerX;
    const maxX = element._maxX - playerX;
    const minY = element._minY - playerY;
    const maxY = element._maxY - playerY;

    // Camera is inside the bounding box — always visible
    if (minX <= 0 && maxX >= 0 && minY <= 0 && maxY >= 0) return true;

    // Any corner or center in frustum
    if (pointInFrustum(minX, minY, sinAngle, cosAngle, tanHalfFov) ||
        pointInFrustum(maxX, minY, sinAngle, cosAngle, tanHalfFov) ||
        pointInFrustum(minX, maxY, sinAngle, cosAngle, tanHalfFov) ||
        pointInFrustum(maxX, maxY, sinAngle, cosAngle, tanHalfFov) ||
        pointInFrustum((minX + maxX) / 2, (minY + maxY) / 2, sinAngle, cosAngle, tanHalfFov)) {
        return true;
    }

    // Frustum edge rays (left/right view boundaries) are angle-dependent
    // only, so the caller precomputes them once per cull tick instead of
    // per surface.
    return rayIntersectsAABB(0, 0, leftDirX, leftDirY, minX, minY, maxX, maxY) ||
           rayIntersectsAABB(0, 0, rightDirX, rightDirY, minX, minY, maxX, maxY);
}

/**
 * Tests whether a ray from (ox,oy) in direction (dx,dy) intersects an AABB.
 * Uses the slab method — only checks forward hits (t > 0).
 */
function rayIntersectsAABB(ox, oy, dx, dy, minX, minY, maxX, maxY) {
    let tmin = 0;
    let tmax = 1e9;

    if (dx !== 0) {
        const tx1 = (minX - ox) / dx;
        const tx2 = (maxX - ox) / dx;
        tmin = Math.max(tmin, Math.min(tx1, tx2));
        tmax = Math.min(tmax, Math.max(tx1, tx2));
    } else if (ox < minX || ox > maxX) {
        return false;
    }

    if (dy !== 0) {
        const ty1 = (minY - oy) / dy;
        const ty2 = (maxY - oy) / dy;
        tmin = Math.max(tmin, Math.min(ty1, ty2));
        tmax = Math.min(tmax, Math.max(ty1, ty2));
    } else if (oy < minY || oy > maxY) {
        return false;
    }

    return tmax >= tmin;
}

/**
 * Tests whether a wall faces toward the camera (backface culling).
 * The wall normal points perpendicular to the wall surface. If the dot
 * product of (camera → wall center) and the wall normal is positive,
 * the wall faces away from the camera.
 */
function wallFacesCamera(normalX, normalY, midX, midY, playerX, playerY) {
    // Vector from wall center to camera
    const toCameraX = playerX - midX;
    const toCameraY = playerY - midY;

    // Dot product > 0 means the wall faces toward the camera
    return normalX * toCameraX + normalY * toCameraY > 0;
}

// Elements must be at least this far past the sky wall intersection
// point (along the ray from the player) to be culled.
const SKY_CULL_MARGIN = 128;

// Elements in sky sectors closer than this distance are never sky-culled —
// they are visible perimeter walls of a nearby outdoor area.
const SKY_EXEMPT_DISTANCE_SQ = 1500 * 1500;

/**
 * Tests whether a sky wall segment lies between the player and the element.
 * Casts a ray from the player to the element and checks if it crosses any
 * sky wall segment. If so, and the element is far enough past the crossing
 * point, the element is culled.
 */
function behindSkyWall(x, y, z, sectorIndex, playerX, playerY, skyPlanes) {
    // Nearby elements in sky sectors are visible outdoor perimeter — skip culling.
    if (sceneState.skyGroupOf?.has(sectorIndex)) {
        const dx2 = x - playerX, dy2 = y - playerY;
        if (dx2 * dx2 + dy2 * dy2 < SKY_EXEMPT_DISTANCE_SQ) return false;
    }

    const dx = x - playerX;
    const dy = y - playerY;

    for (let i = 0, len = skyPlanes.length; i < len; i++) {
        const plane = skyPlanes[i];

        // Don't cull elements in the same connected sky group as this sky
        // wall — they form the visible perimeter of the same outdoor area.
        // Elements in unrelated sky groups should still be culled.
        if (plane.skyGroup !== undefined && sceneState.skyGroupOf?.get(sectorIndex) === plane.skyGroup) continue;

        // Only cull elements above the sky wall's floor — below that,
        // the element could be visible through a window or doorway.
        if (z < plane.floorZ) continue;

        // Ray-segment intersection: ray from player in direction (dx,dy)
        // against wall segment from A to B.
        const sx = plane.bx - plane.ax;
        const sy = plane.by - plane.ay;

        const denom = dx * sy - dy * sx;
        if (denom === 0) continue; // parallel

        // t = parameter along the ray (0=player, 1=element)
        const t = ((plane.ax - playerX) * sy - (plane.ay - playerY) * sx) / denom;
        if (t <= 0 || t >= 1) continue; // intersection not between player and element

        // u = parameter along the wall segment (0=A, 1=B)
        const u = ((plane.ax - playerX) * dy - (plane.ay - playerY) * dx) / denom;
        if (u < 0 || u > 1) continue; // intersection outside the wall segment

        // The ray crosses this sky wall. Check if the element is far
        // enough past the intersection point.
        const totalDist = Math.sqrt(dx * dx + dy * dy);
        const pastWallDist = (1 - t) * totalDist;
        if (pastWallDist < SKY_CULL_MARGIN) continue;

        return true;
    }
    return false;
}

/**
 * Run culling checks on all scene elements. Called each frame from the game loop.
 * Elements are hidden/shown by toggling a `culled` class which applies
 * `content-visibility: hidden` and pauses animations on the subtree, sparing
 * the compositor from painting / ticking offscreen content.
 */
function setCulled(el, hide) {
    const isCulled = el.classList.contains('culled');
    if (isCulled !== hide) el.classList.toggle('culled', hide);
}

/**
 * Resolve the active camera (player or possessed monster) plus the
 * horizontal half-FOV used by both the coarse PVS flood and the fine
 * per-element frustum tests. Cheap — just trig and a window read.
 */
function getEyeAndHalfFov() {
    const eye = getControlledEye();
    const halfFov = Math.atan2(window.innerWidth / 2, sceneState.perspectiveValue) + FRUSTUM_MARGIN;
    return { eye, halfFov };
}

/** True when we have an eye to cull from; callers early-return otherwise. */
function hasEye(eye) {
    return eye !== null && eye !== undefined;
}

/**
 * Coarse pass: run the sector PVS flood and toggle `.culled` on each
 * sector container. Cheap enough to run every frame so newly-visible
 * sectors un-cull immediately when the camera turns; the descendant
 * `.culled, .culled *` rule in scene.css means flipping a sector also
 * reveals every wall/surface/thing inside it without waiting for the
 * fine pass to refine them. Returns the raw Uint8Array (or null when
 * PVS is disabled, which forces every sector visible).
 */
function runPvsPass(eye, halfFov) {
    const containers = sceneState.sectorContainers;
    const visibleSectors = culling.pvs ? computeVisibleSectors(eye, halfFov) : null;
    let visibleCount = 0;
    if (visibleSectors) {
        for (let i = 0, len = containers.length; i < len; i++) {
            const visible = visibleSectors[i] === 1;
            if (visible) visibleCount++;
            setCulled(containers[i], !visible);
        }
    } else {
        for (let i = 0, len = containers.length; i < len; i++) {
            setCulled(containers[i], false);
        }
        visibleCount = containers.length;
    }
    cullingStats.totalSectors = containers.length;
    cullingStats.visibleSectors = visibleCount;
    return visibleSectors;
}

/**
 * PVS-only tick used between full culling passes. Keeps sector-level
 * visibility in lockstep with the camera so turning reveals new rooms
 * with single-frame latency, while the expensive fine pass stays
 * throttled by `CULLING_INTERVAL`.
 */
function updatePvs() {
    const { eye, halfFov } = getEyeAndHalfFov();
    if (!hasEye(eye)) return;
    runPvsPass(eye, halfFov);
}

export function updateCulling() {
    const anyFineCulling = culling.frustum || culling.distance || culling.backface || culling.sky;

    let total = 0;
    let culled = 0;
    let pvsCulled = 0;
    let distanceCulled = 0;
    let backfaceCulled = 0;
    let frustumCulled = 0;
    let skyCulled = 0;

    const { eye, halfFov } = getEyeAndHalfFov();
    if (!hasEye(eye)) return;
    const playerX = eye.x;
    const playerY = eye.y;
    const distSq = MAX_RENDER_DISTANCE * MAX_RENDER_DISTANCE;
    const skyPlanes = culling.sky ? sceneState.skyWallPlanes : null;

    const sinAngle = Math.sin(eye.angle);
    const cosAngle = Math.cos(eye.angle);

    // Left/right frustum edge rays depend only on camera angle + halfFov,
    // so compute them once here instead of per-surface inside
    // surfaceInFrustum(). tanHalfFov is reused by pointInFrustum to avoid
    // a per-point Math.atan2.
    const sinH = Math.sin(halfFov);
    const cosH = Math.cos(halfFov);
    const tanHalfFov = sinH / cosH;
    const leftDirX = -sinH * cosAngle - cosH * sinAngle;
    const leftDirY = -sinH * sinAngle + cosH * cosAngle;
    const rightDirX = sinH * cosAngle - cosH * sinAngle;
    const rightDirY = sinH * sinAngle + cosH * cosAngle;

    const visibleSectors = runPvsPass(eye, halfFov);

    // Coarse PVS gate: when the element's sector container is hidden, the
    // CSS `.culled` class on the container already short-circuits paint
    // and pauses descendant animations (see scene.css `.culled, .culled *`),
    // so we skip the per-element fine pass entirely. Elements with no
    // recorded sector (effects, dynamic spawns) are never PVS-gated.
    const pvsActive = !!visibleSectors;

    // Cull walls
    const walls = sceneState.wallElements;
    for (let i = 0, len = walls.length; i < len; i++) {
        const el = walls[i];
        total++;

        if (pvsActive) {
            const si = el._sectorIndex;
            if (si !== undefined && si >= 0 && visibleSectors[si] !== 1) {
                pvsCulled++;
                culled++;
                continue;
            }
        }

        if (!anyFineCulling) {
            setCulled(el, false);
            continue;
        }

        let hide = false;

        if (!hide && culling.distance && el._midX !== undefined) {
            const dx = el._midX - playerX;
            const dy = el._midY - playerY;
            if (dx * dx + dy * dy > distSq) { hide = true; distanceCulled++; }
        }

        if (!hide && culling.backface && el._wall) {
            if (!wallFacesCamera(el._normalX, el._normalY, el._midX, el._midY, playerX, playerY)) {
                hide = true; backfaceCulled++;
            }
        }

        if (!hide && culling.frustum && el._wall) {
            if (!wallInFrustum(el._wall, playerX, playerY, sinAngle, cosAngle, tanHalfFov)) {
                hide = true; frustumCulled++;
            }
        }

        if (!hide && skyPlanes && skyPlanes.length > 0 && el._midX !== undefined) {
            if (behindSkyWall(el._midX, el._midY, el._wall ? el._wall.topHeight : 0, el._sectorIndex, playerX, playerY, skyPlanes)) {
                hide = true; skyCulled++;
            }
        }

        if (hide) culled++;
        setCulled(el, hide);
    }

    // Cull surfaces (floors/ceilings)
    const surfaces = sceneState.surfaceElements;
    for (let i = 0, len = surfaces.length; i < len; i++) {
        const el = surfaces[i];
        total++;

        // In spectator mode, CSS controls ceiling visibility — skip culling
        if (spectatorActive && el.classList.contains('ceiling')) continue;

        if (pvsActive) {
            const si = el._sectorIndex;
            if (si !== undefined && si >= 0 && visibleSectors[si] !== 1) {
                pvsCulled++;
                culled++;
                continue;
            }
        }

        if (!anyFineCulling) {
            setCulled(el, false);
            continue;
        }

        let hide = false;

        if (!hide && culling.distance) {
            const dx = el._midX - playerX;
            const dy = el._midY - playerY;
            if (dx * dx + dy * dy > distSq) { hide = true; distanceCulled++; }
        }

        if (!hide && culling.frustum) {
            if (!surfaceInFrustum(el, playerX, playerY, sinAngle, cosAngle, tanHalfFov, leftDirX, leftDirY, rightDirX, rightDirY)) {
                hide = true; frustumCulled++;
            }
        }

        if (!hide && skyPlanes && skyPlanes.length > 0) {
            if (behindSkyWall(el._midX, el._midY, el._height, el._sectorIndex, playerX, playerY, skyPlanes)) {
                hide = true; skyCulled++;
            }
        }

        if (hide) culled++;
        setCulled(el, hide);
    }

    // Cull things (enemies, pickups, decorations)
    //
    // For moving entities (those with a `gameId` in `state.things`) we
    // read the *live* position from the gameplay record, not the cached
    // spawn coords on the container entry. Without this, an enemy that
    // walked across the level would still be distance/frustum/sky-tested
    // against where it spawned — PVS would say "visible" but the fine
    // pass would (wrongly) hide it because the spawn point fell outside
    // the frustum. Static entries without a gameId never move, so their
    // stamped `t.x/t.y` is still correct.
    const things = sceneState.thingContainers;
    for (let i = 0, len = things.length; i < len; i++) {
        const t = things[i];
        total++;

        // Skip dead/collected things — but ensure visibility is restored
        // so death/explosion animations can play even if the thing was
        // previously culled offscreen.
        const gameEntry = t.gameId !== undefined
            ? (t.gameId >= ACTOR_DOM_KEY_OFFSET
                ? (state.actors[t.gameId - ACTOR_DOM_KEY_OFFSET] ?? null)
                : (state.things[t.gameId] ?? null))
            : null;
        if (gameEntry?.collected) {
            setCulled(t.element, false);
            continue;
        }

        if (pvsActive) {
            const si = t.element._sectorIndex;
            if (si !== undefined && si >= 0 && visibleSectors[si] !== 1) {
                pvsCulled++;
                culled++;
                continue;
            }
        }

        if (!anyFineCulling) {
            setCulled(t.element, false);
            continue;
        }

        const tx = gameEntry ? gameEntry.x : t.x;
        const ty = gameEntry ? gameEntry.y : t.y;
        const relX = tx - playerX;
        const relY = ty - playerY;
        let hide = false;

        if (culling.distance) {
            if (relX * relX + relY * relY > distSq) { hide = true; distanceCulled++; }
        }

        if (!hide && culling.frustum) {
            if (!pointInFrustum(relX, relY, sinAngle, cosAngle, tanHalfFov)) {
                hide = true; frustumCulled++;
            }
        }

        if (!hide && skyPlanes && skyPlanes.length > 0) {
            if (behindSkyWall(tx, ty, 0, -1, playerX, playerY, skyPlanes)) {
                hide = true; skyCulled++;
            }
        }

        if (hide) culled++;
        setCulled(t.element, hide);
    }

    cullingStats.total = total;
    cullingStats.culled = culled;
    cullingStats.afterPvs = total - pvsCulled;
    cullingStats.afterDistance = cullingStats.afterPvs - distanceCulled;
    cullingStats.afterBackface = cullingStats.afterDistance - backfaceCulled;
    cullingStats.afterFrustum = cullingStats.afterBackface - frustumCulled;
    cullingStats.afterSky = cullingStats.afterFrustum - skyCulled;
}

// Fine pass (per-element distance / backface / frustum / sky) runs every Nth
// rAF. The coarse PVS sector toggle runs every frame on the off-ticks so
// turning the camera un-culls newly-visible rooms with single-frame latency
// — sector containers reveal all descendants via `.culled, .culled *`,
// even before the next fine pass refines the elements inside.
const CULLING_INTERVAL = 3;
let frameCount = 0;

function cullingLoop() {
    frameCount++;
    if (frameCount >= CULLING_INTERVAL) {
        frameCount = 0;
        updateCulling();
    } else {
        updatePvs();
    }
    requestAnimationFrame(cullingLoop);
}

export function startCullingLoop() {
    requestAnimationFrame(cullingLoop);
}
