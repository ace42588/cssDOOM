/**
 * Public facade for the authoritative game world hosted by the server.
 *
 * The implementation is split under `server/world-host/` so host wiring,
 * connection input adaptation, restart policy, loop timing, and snapshot
 * deltas each have one owner.
 */

export {
    installEngineHosts,
    useGameServices,
} from './world-host/hosts.js';
export {
    startLoop,
    stopLoop,
    getTickRateHz,
    getCurrentTick,
} from './world-host/loop.js';
export {
    buildDeltasForTick,
} from './world-host/deltas.js';

export { emptyBaseline, resetBaseline } from './world/snapshots.js';
export {
    getMapPayload,
    loadMap,
    requestMapLoad,
} from './world/maps.js';
export {
    buildRoleChangePayload,
    drainPendingRoleChanges,
    queueRoleChange,
} from './world/roles.js';
