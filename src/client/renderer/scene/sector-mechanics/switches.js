/**
 * Switch rendering — visual state toggle.
 */

export function toggleSwitchState(wallId) {
    const el = document.getElementById(wallId);
    if (el) el.dataset.state = el.dataset.state === 'on' ? 'off' : 'on';
}
