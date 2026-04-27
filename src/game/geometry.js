/**
 * Pure geometry utilities — no game state, no spatial grid.
 */

/**
 * Point-in-polygon test using the ray casting (Jordan curve) algorithm.
 *
 * Casts a horizontal ray from the test point to +X infinity and counts how
 * many polygon edges it crosses. An odd crossing count means the point is
 * inside; even means outside.
 */
export function pointInPolygon(pointX, pointY, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const vertexCurrentX = polygon[i].x, vertexCurrentY = polygon[i].y;
        const vertexPreviousX = polygon[j].x, vertexPreviousY = polygon[j].y;
        if (((vertexCurrentY > pointY) !== (vertexPreviousY > pointY)) &&
            (pointX < (vertexPreviousX - vertexCurrentX) * (pointY - vertexCurrentY) / (vertexPreviousY - vertexCurrentY) + vertexCurrentX)) {
            inside = !inside;
        }
    }
    return inside;
}

/**
 * Circle-line segment collision test.
 *
 * Projects the circle center onto the line segment to find the closest point,
 * clamping the parameter t to [0,1] so we test against the finite segment
 * (not the infinite line). Returns true if the closest point on the segment
 * is within the circle's radius.
 *
 * For degenerate zero-length segments, falls back to a point-in-circle test.
 */
export function circleLineCollision(centerX, centerY, radius, segmentStartX, segmentStartY, segmentEndX, segmentEndY) {
    // Fast AABB reject — skip if circle is far from the segment's bounding box
    const minX = segmentStartX < segmentEndX ? segmentStartX : segmentEndX;
    const maxX = segmentStartX > segmentEndX ? segmentStartX : segmentEndX;
    const minY = segmentStartY < segmentEndY ? segmentStartY : segmentEndY;
    const maxY = segmentStartY > segmentEndY ? segmentStartY : segmentEndY;
    if (centerX < minX - radius || centerX > maxX + radius ||
        centerY < minY - radius || centerY > maxY + radius) return false;

    const segmentDeltaX = segmentEndX - segmentStartX;
    const segmentDeltaY = segmentEndY - segmentStartY;
    const segmentLengthSquared = segmentDeltaX * segmentDeltaX + segmentDeltaY * segmentDeltaY;

    // Degenerate segment (zero length) — just check distance from point to center
    if (segmentLengthSquared === 0) {
        return (centerX - segmentStartX) ** 2 + (centerY - segmentStartY) ** 2 < radius * radius;
    }

    // Parameter t represents how far along the segment the closest point lies.
    // Clamping to [0,1] restricts to the finite segment.
    let projectionParameter = ((centerX - segmentStartX) * segmentDeltaX + (centerY - segmentStartY) * segmentDeltaY) / segmentLengthSquared;
    projectionParameter = Math.max(0, Math.min(1, projectionParameter));

    const closestX = segmentStartX + projectionParameter * segmentDeltaX;
    const closestY = segmentStartY + projectionParameter * segmentDeltaY;
    const distanceSquared = (centerX - closestX) ** 2 + (centerY - closestY) ** 2;
    return distanceSquared < radius * radius;
}

/**
 * Tests whether a ray (origin + direction * t) intersects a line segment.
 *
 * Uses the parametric intersection of two lines:
 *   Ray:     P = origin + t * direction
 *   Segment: Q = segStart + u * (segEnd - segStart)
 *
 * Solves for t and u using the cross-product denominator. The ray hits the
 * segment if t is in (0, maxDistance) and u is in [0, 1].
 *
 * Returns false for (near-)parallel lines (denominator < epsilon).
 */
export function rayHitsSegment(originX, originY, directionX, directionY, segmentStartX, segmentStartY, segmentEndX, segmentEndY, maxDistance) {
    const segmentDeltaX = segmentEndX - segmentStartX;
    const segmentDeltaY = segmentEndY - segmentStartY;
    const crossProductDenominator = directionX * segmentDeltaY - directionY * segmentDeltaX;
    if (Math.abs(crossProductDenominator) < 1e-8) return false;

    // t = distance along the ray direction to the intersection
    const rayParameter = ((segmentStartX - originX) * segmentDeltaY - (segmentStartY - originY) * segmentDeltaX) / crossProductDenominator;
    // u = fraction along the wall segment where intersection occurs
    const segmentParameter = ((segmentStartX - originX) * directionY - (segmentStartY - originY) * directionX) / crossProductDenominator;
    return rayParameter > 0 && rayParameter < maxDistance && segmentParameter >= 0 && segmentParameter <= 1;
}

export function getDeltas(t1, t2) {
    const deltaX = t2.x - t1.x;
    const deltaY = t2.y - t1.y;
    const deltaZ = (t2.z ?? 0) - (t1.z ?? 0);
    return { deltaX, deltaY, deltaZ };
}

export function horizontalDistanceSquared(t1, t2) {
    const deltaX = t2.x - t1.x;
    const deltaY = t2.y - t1.y;
    return deltaX * deltaX + deltaY * deltaY;
}

export function getHorizontalDistance(t1, t2) {
    return Math.sqrt(horizontalDistanceSquared(t1, t2));
}

export function getTotalDistance(t1, t2) {
    const { deltaX, deltaY, deltaZ } = getDeltas(t1, t2);
    return Math.sqrt(deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ);
}

export function chebyshevDistance(t1, t2, radius) {
    const { deltaX, deltaY } = getDeltas(t1, t2);
    const dx = Math.abs(deltaX);
    const dy = Math.abs(deltaY);
    return Math.max(0, Math.max(dx, dy) - radius);
}

/**
 * Random angular offset in radians, matching DOOM's (P_Random()-P_Random()) spread
 * scaled to ±maxDegrees (triangular distribution in angle space).
 */
export function randomDoomSpreadAngleRadians(maxDegrees) {
    const spreadFraction = (Math.floor(Math.random() * 256) - Math.floor(Math.random() * 256)) / 255;
    return spreadFraction * (maxDegrees * Math.PI / 180);
}