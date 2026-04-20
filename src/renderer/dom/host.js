/**
 * DOM renderer host — binds the facade in `src/renderer/index.js` to the
 * real DOM/CSS implementation. Only imported by the browser entry so the
 * DOM-access side effects of these modules (e.g. `document.addEventListener`
 * at module load in `weapons.js`) never execute on the server.
 */

import { updateCamera } from '../scene/camera.js';
import { updateHud, clearWeaponSlots, showHudMessage } from '../hud.js';
import { startCullingLoop, updateCulling } from '../scene/culling.js';
import {
    triggerFlash, showPowerup, flickerPowerup, hidePowerup,
} from '../effects.js';
import {
    setEnemyState, resetEnemy, killEnemy,
    updateEnemyRotation, updateThingPosition, reparentThingToSector,
    collectItem, removeThing, setThingVisible,
    createPuff, createExplosion, createTeleportFog,
    createProjectile, updateProjectilePosition, removeProjectile,
} from '../scene/entities/sprites.js';
import { setPlayerDead, clearKeys, setPlayerMoving, collectKey } from '../scene/entities/player.js';
import { isWeaponSwitching, switchWeapon, startFiring, stopFiring } from '../weapons.js';
import { buildDoor, setDoorState } from '../scene/mechanics/doors.js';
import { buildLift, setLiftState } from '../scene/mechanics/lifts.js';
import { buildCrusher, setCrusherOffset } from '../scene/mechanics/crushers.js';
import { toggleSwitchState } from '../scene/mechanics/switches.js';
import { lowerTaggedFloor } from '../scene/surfaces/floors.js';

/**
 * Create the DOM-backed renderer host. Install via `setRendererHost(createDomRendererHost())`
 * once the DOM is ready, before starting the game loop.
 */
export function createDomRendererHost() {
    return {
        // Camera / HUD
        updateCamera, updateHud, clearWeaponSlots, showHudMessage,
        // Culling
        startCullingLoop, updateCulling,
        // Effects (`forSessionId` is multiplayer-only; DOM host ignores it.)
        triggerFlash,
        triggerViewerFlash: (className, _forSessionId, duration = 300) => {
            triggerFlash(className, duration);
        },
        showPowerup, flickerPowerup, hidePowerup,
        // Sprites / things
        setEnemyState, resetEnemy, killEnemy,
        updateEnemyRotation, updateThingPosition, reparentThingToSector,
        collectItem, removeThing, setThingVisible,
        createPuff, createExplosion, createTeleportFog,
        createProjectile, updateProjectilePosition, removeProjectile,
        // Player visuals
        setPlayerDead,
        setViewerPlayerDead: (dead, _forSessionId) => setPlayerDead(dead),
        clearKeys, setPlayerMoving, collectKey,
        // Weapons
        isWeaponSwitching, switchWeapon, startFiring, stopFiring,
        // Doors / lifts / crushers / switches
        buildDoor, setDoorState,
        buildLift, setLiftState,
        buildCrusher, setCrusherOffset,
        toggleSwitchState,
        // Surfaces
        lowerTaggedFloor,
    };
}
