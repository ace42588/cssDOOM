/**
 * Wrap yaw to [-π, π] so agents and snapshots never see unbounded radians.
 */
export function normalizeAngle(rad) {
    const a = Number(rad);
    if (!Number.isFinite(a)) return 0;
    let x = a % (2 * Math.PI);
    if (x > Math.PI) x -= 2 * Math.PI;
    if (x < -Math.PI) x += 2 * Math.PI;
    return x;
}
