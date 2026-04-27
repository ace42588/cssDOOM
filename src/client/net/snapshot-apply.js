import { state } from '../../engine/state.js';
import * as rendererFacade from '../../engine/ports/renderer.js';
import * as audioFacade from '../../engine/ports/audio.js';
import { WEAPONS, ACTOR_DOM_KEY_OFFSET, DOOR_CLOSE_TRAVEL_MS } from '../../engine/constants.js';
import {
    LOCAL_SESSION,
    possessFor,
    releaseFor,
    getControlledFor,
} from '../../engine/possession.js';
import { getSectorAt } from '../../engine/physics/queries.js';
import { isMapLoading } from './map-sync.js';
import { session } from './session.js';
import { resolveRuntimeId } from '../../engine/actors/ids.js';
import { isControllableBody, canSwitchWeapons } from '../../engine/actors/capabilities.js';
import {
    currentInterpPos,
    currentProjectileInterpPos,
    dropActorInterp,
    projectileInterp,
    renderInterpDt,
    thingInterp,
    updateActorRenderFromSnapshot,
} from './interpolation.js';

let weaponNeedsRehydrate = true;

export function markWeaponNeedsRehydrate() {
    weaponNeedsRehydrate = true;
}

export function applySnapshot(snap) {
    if (isMapLoading()) return;
    if (snap.role) session.role = snap.role;
    if (snap.controlledId !== undefined) session.controlledId = snap.controlledId;
    if (snap.followTargetId !== undefined) session.followTargetId = snap.followTargetId;

    if (snap.actors) {
        applyActors(snap.actors);
    }
    applyThings(snap.things);
    applyProjectiles(snap.projectiles);
    applyDoors(snap.doors);
    applyLifts(snap.lifts);
    applyCrushers(snap.crushers);
    syncLocalPossession();
    replayEvents(snap.rendererEvents, snap.soundEvents);
}

function entityIsControllableSnapshot(entity) {
    return isControllableBody(entity);
}

function syncLocalPossession() {
    const targetId = session.role === 'spectator'
        ? session.followTargetId
        : session.controlledId;
    const target = resolveRuntimeId(targetId);
    const currentLocal = getControlledFor(LOCAL_SESSION);

    if (target === currentLocal) {
        if (!currentLocal || entityIsControllableSnapshot(currentLocal)) return;
        releaseFor(LOCAL_SESSION);
        return;
    }

    if (!target) {
        releaseFor(LOCAL_SESSION);
        return;
    }

    if (!entityIsControllableSnapshot(target)) {
        releaseFor(LOCAL_SESSION);
        return;
    }

    if (!possessFor(LOCAL_SESSION, target)) {
        releaseFor(LOCAL_SESSION);
    }
}

function actorDomId(actorIndex) {
    return ACTOR_DOM_KEY_OFFSET + actorIndex;
}

function applyActors(block) {
    if (!block) return;
    const { spawn, update, despawn } = block;
    if (despawn && despawn.length) {
        for (const id of despawn) despawnActor(id);
    }
    if (spawn && spawn.length) {
        const spawnSorted = [...spawn].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
        for (const rec of spawnSorted) spawnActor(rec);
    }
    if (update && update.length) {
        const updateSorted = [...update].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
        for (const rec of updateSorted) updateActorRecord(rec);
    }
}

function spawnActor(rec) {
    const id = rec.id;
    while (state.actors.length <= id) state.actors.push(null);
    let dst = state.actors[id];
    if (!dst) {
        dst = { actorIndex: id, thingIndex: actorDomId(id) };
        state.actors[id] = dst;
    }
    updateActorRecord(rec);
}

function updateActorRecord(rec) {
    const id = rec.id;
    const dst = state.actors[id];
    if (!dst) return;
    const domId = dst.thingIndex ?? actorDomId(id);

    const prevX = dst.x;
    const prevY = dst.y;
    const prevZ = dst.z;
    const prevFloorHeight = dst.floorHeight;
    const prevFacing = dst.facing;
    const prevAngle = dst.viewAngle;
    const prevWeapon = dst.currentWeapon;

    if (rec.type !== undefined) dst.type = rec.type;
    if (rec.x !== undefined) dst.x = rec.x;
    if (rec.y !== undefined) dst.y = rec.y;
    if (rec.z !== undefined && rec.z !== null) dst.z = rec.z;
    if (rec.floorHeight !== undefined) dst.floorHeight = rec.floorHeight;
    if (rec.facing !== undefined && rec.facing !== null) dst.facing = rec.facing;
    if (rec.angle !== undefined && rec.angle !== null) {
        dst.viewAngle = rec.angle;
        if (rec.facing === undefined || rec.facing === null) {
            dst.facing = rec.angle + Math.PI / 2;
        }
    }
    if (rec.hp !== undefined && rec.hp !== null) dst.hp = rec.hp;
    if (rec.maxHp !== undefined && rec.maxHp !== null) dst.maxHp = rec.maxHp;
    if (rec.collected !== undefined) dst.collected = Boolean(rec.collected);
    if (rec.aiState !== undefined && rec.aiState !== null && dst.ai) {
        dst.ai.state = rec.aiState;
    }
    if (rec.armor !== undefined && rec.armor !== null) dst.armor = rec.armor;
    if (rec.armorType !== undefined && rec.armorType !== null) dst.armorType = rec.armorType;
    if (rec.ammo) {
        if (!dst.ammo) dst.ammo = {};
        for (const key in rec.ammo) dst.ammo[key] = rec.ammo[key];
    }
    if (rec.maxAmmo) {
        if (!dst.maxAmmo) dst.maxAmmo = {};
        for (const key in rec.maxAmmo) dst.maxAmmo[key] = rec.maxAmmo[key];
    }
    if (rec.ownedWeapons !== undefined && rec.ownedWeapons !== null) {
        dst.ownedWeapons = new Set(rec.ownedWeapons);
    }
    if (rec.currentWeapon !== undefined && rec.currentWeapon !== null) {
        dst.currentWeapon = rec.currentWeapon;
    }
    if (rec.collectedKeys !== undefined && rec.collectedKeys !== null) {
        dst.collectedKeys = new Set(rec.collectedKeys);
    }
    if (rec.powerups !== undefined && rec.powerups !== null) {
        dst.powerups = { ...rec.powerups };
    }
    if (rec.hasBackpack !== undefined) dst.hasBackpack = Boolean(rec.hasBackpack);
    if (rec.isDead !== undefined || rec.isAiDead !== undefined) {
        if (rec.isDead) dst.deathMode = 'gameover';
        else if (rec.isAiDead) dst.deathMode = 'ai';
        else dst.deathMode = null;
    }
    if (rec.isFiring !== undefined) dst.isFiring = Boolean(rec.isFiring);

    // First-person weapon display follows whichever actor the local viewer
    // possesses. `canSwitchWeapons` is true only for actors that carry a
    // real weapon loadout (marine-shaped), so possessing an intrinsic-weapon
    // monster is a no-op here.
    const locallyControlled = getControlledFor(LOCAL_SESSION);
    const weaponChanged = prevWeapon !== dst.currentWeapon;
    if ((weaponChanged || weaponNeedsRehydrate) &&
        canSwitchWeapons(dst) &&
        dst === locallyControlled) {
        const weapon = WEAPONS[dst.currentWeapon];
        if (weapon && dst.ownedWeapons?.has(dst.currentWeapon)) {
            rendererFacade.switchWeapon(weapon.name, weapon.fireRate);
            weaponNeedsRehydrate = false;
        }
    }

    if (rec.collected !== undefined && dst.collected) {
        const enemyLike = Boolean(dst.ai) || dst.type === 2035;
        if (enemyLike) {
            rendererFacade.killEnemy(domId, dst.type);
        } else {
            rendererFacade.collectItem(domId);
        }
    }

    const moved =
        prevX !== dst.x ||
        prevY !== dst.y ||
        prevZ !== dst.z ||
        prevFloorHeight !== dst.floorHeight ||
        prevAngle !== dst.viewAngle;

    if (moved) {
        const targetSector = getSectorAt(dst.x, dst.y);
        const pendingSectorIndex = targetSector ? targetSector.sectorIndex : undefined;
        updateActorRenderFromSnapshot(
            id,
            {
                x: dst.x,
                y: dst.y,
                z: dst.z ?? 0,
                floor: dst.floorHeight ?? 0,
                angle: dst.viewAngle ?? 0,
            },
            {
                x: prevX ?? dst.x,
                y: prevY ?? dst.y,
                z: prevZ ?? dst.z ?? 0,
                floor: prevFloorHeight ?? dst.floorHeight ?? 0,
                angle: prevAngle ?? dst.viewAngle ?? 0,
            },
            pendingSectorIndex,
        );
    }
    if (prevFacing !== dst.facing) {
        rendererFacade.updateEnemyRotation(domId, dst);
    }
}

function despawnActor(id) {
    const dst = state.actors[id];
    const domId = dst?.thingIndex ?? actorDomId(id);
    dropActorInterp(id);
    thingInterp.delete(domId);
    rendererFacade.removeThing(domId);
    state.actors[id] = null;
}

function applyThings(block) {
    if (!block) return;
    const { spawn, update, despawn } = block;
    if (despawn && despawn.length) {
        for (const id of despawn) despawnThing(id);
    }
    if (spawn && spawn.length) {
        for (const rec of spawn) spawnThing(rec);
    }
    if (update && update.length) {
        for (const rec of update) updateThing(rec);
    }
}

function spawnThing(rec) {
    const id = rec.id;
    let dst = state.things[id];
    if (!dst) {
        dst = { thingIndex: id };
        state.things[id] = dst;
        // eslint-disable-next-line no-console
        console.warn('[net] delta spawn without local DOM for thing', id, rec.type);
    }
    updateThing(rec);
}

function updateThing(rec) {
    const id = rec.id;
    const dst = state.things[id];
    if (!dst) return;

    const prevX = dst.x;
    const prevY = dst.y;
    const prevFloorHeight = dst.floorHeight;
    const prevFacing = dst.facing;

    if (rec.type !== undefined) dst.type = rec.type;
    if (rec.x !== undefined) dst.x = rec.x;
    if (rec.y !== undefined) dst.y = rec.y;
    if (rec.z !== undefined && rec.z !== null) dst.z = rec.z;
    if (rec.floorHeight !== undefined) dst.floorHeight = rec.floorHeight;
    if (rec.facing !== undefined) dst.facing = rec.facing;
    if (rec.viewAngle !== undefined && rec.viewAngle !== null) dst.viewAngle = rec.viewAngle;
    if (rec.hp !== undefined) dst.hp = rec.hp;
    if (rec.maxHp !== undefined) dst.maxHp = rec.maxHp;
    if (rec.collected !== undefined) dst.collected = Boolean(rec.collected);
    if (rec.aiState !== undefined && dst.ai) dst.ai.state = rec.aiState;
    if (rec.collected !== undefined && dst.collected) {
        const enemyLike = Boolean(dst.ai) || dst.type === 2035;
        if (enemyLike) {
            rendererFacade.killEnemy(id, dst.type);
        } else {
            rendererFacade.collectItem(id);
        }
    }

    const moved =
        prevX !== dst.x ||
        prevY !== dst.y ||
        prevFloorHeight !== dst.floorHeight;

    if (moved) {
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const dt = Math.max(16, 1000 / (session.tickRateHz || 35));
        const existing = thingInterp.get(id);
        let fromX, fromY, fromFloor;
        if (existing) {
            const cur = currentInterpPos(existing, now);
            fromX = cur.x; fromY = cur.y; fromFloor = cur.floor;
        } else {
            fromX = prevX ?? dst.x;
            fromY = prevY ?? dst.y;
            fromFloor = prevFloorHeight ?? dst.floorHeight ?? 0;
        }
        const targetSector = getSectorAt(dst.x, dst.y);
        const pendingSectorIndex = targetSector ? targetSector.sectorIndex : undefined;
        thingInterp.set(id, {
            fromX, fromY, fromFloor,
            toX: dst.x,
            toY: dst.y,
            toFloor: dst.floorHeight ?? 0,
            t0: now,
            dt,
            pendingSectorIndex,
        });
    }
    if (prevFacing !== dst.facing) {
        rendererFacade.updateEnemyRotation(id, dst);
    }
}

function despawnThing(id) {
    thingInterp.delete(id);
    rendererFacade.removeThing(id);
    delete state.things[id];
}

function applyProjectiles(block) {
    if (!block) return;
    const { spawn, update, despawn } = block;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const dt = renderInterpDt();
    if (despawn && despawn.length) {
        for (const id of despawn) {
            const idx = state.projectiles.findIndex((p) => p.id === id);
            if (idx >= 0) state.projectiles.splice(idx, 1);
            projectileInterp.delete(id);
        }
    }
    if (spawn && spawn.length) {
        for (const rec of spawn) {
            const existing = state.projectiles.find((p) => p.id === rec.id);
            if (existing) {
                existing.x = rec.x; existing.y = rec.y; existing.z = rec.z;
            } else {
                state.projectiles.push({ id: rec.id, x: rec.x, y: rec.y, z: rec.z });
            }
            projectileInterp.set(rec.id, {
                fromX: rec.x, fromY: rec.y, fromZ: rec.z,
                toX:   rec.x, toY:   rec.y, toZ:   rec.z,
                t0: now, dt,
            });
        }
    }
    if (update && update.length) {
        for (const rec of update) {
            const dst = state.projectiles.find((p) => p.id === rec.id);
            if (!dst) continue;
            const prevX = dst.x, prevY = dst.y, prevZ = dst.z;
            if (rec.x !== undefined) dst.x = rec.x;
            if (rec.y !== undefined) dst.y = rec.y;
            if (rec.z !== undefined) dst.z = rec.z;
            const moved = prevX !== dst.x || prevY !== dst.y || prevZ !== dst.z;
            if (!moved) continue;
            const existing = projectileInterp.get(rec.id);
            let fromX, fromY, fromZ;
            if (existing) {
                const cur = currentProjectileInterpPos(existing, now);
                fromX = cur.x; fromY = cur.y; fromZ = cur.z;
            } else {
                fromX = prevX ?? dst.x;
                fromY = prevY ?? dst.y;
                fromZ = prevZ ?? dst.z;
            }
            projectileInterp.set(rec.id, {
                fromX, fromY, fromZ,
                toX: dst.x, toY: dst.y, toZ: dst.z,
                t0: now, dt,
            });
        }
    }
}

function applyDoors(doors) {
    if (!doors || !doors.length) return;
    for (const d of doors) {
        const entry = state.doorState.get(d.sectorIndex);
        if (!entry) continue;
        const wasOpen = entry.open;
        if (d.open !== undefined) {
            entry.open = d.open;
            if (d.open) {
                entry.closingUntil = 0;
            } else if (wasOpen) {
                // Keep renderer PVS portals open for the same visual close travel
                // interval used by the local door animation.
                entry.closingUntil = Date.now() + DOOR_CLOSE_TRAVEL_MS;
            }
        }
        if (d.passable !== undefined) entry.passable = d.passable;

        const doorEntity = entry.doorEntity;
        if (!doorEntity) continue;
        if (typeof d.viewAngle === 'number') {
            doorEntity.viewAngle = d.viewAngle;
            doorEntity.facing = d.viewAngle + Math.PI / 2;
        }
        if (d.pendingRequests !== undefined) {
            doorEntity.pendingRequests = Array.isArray(d.pendingRequests)
                ? d.pendingRequests.map((r) => ({
                    id: r.id,
                    interactorId: r.interactorId,
                    interactorLabel: r.interactorLabel,
                    interactorDetails: r.interactorDetails,
                    approachSide: r.approachSide,
                }))
                : [];
        }
    }
}

function applyLifts(lifts) {
    if (!lifts || !lifts.length) return;
    for (const l of lifts) {
        const entry = state.liftState.get(l.sectorIndex);
        if (!entry) continue;
        if (l.currentHeight !== undefined) entry.currentHeight = l.currentHeight;
        if (l.targetHeight !== undefined) entry.targetHeight = l.targetHeight;
        if (l.moving !== undefined) entry.moving = l.moving;
    }
}

function applyCrushers(crushers) {
    if (!crushers || !crushers.length) return;
    for (const c of crushers) {
        const entry = state.crusherState.get(c.sectorIndex);
        if (!entry) continue;
        if (c.active !== undefined) entry.active = c.active;
        if (c.direction !== undefined) entry.direction = c.direction;
        if (c.currentHeight !== undefined) entry.currentHeight = c.currentHeight;
        if (c.damageTimer !== undefined) entry.damageTimer = c.damageTimer;
    }
}

function replayEvents(rendererEvents, soundEvents) {
    const viewerId = session.sessionId;
    if (rendererEvents && rendererEvents.length) {
        for (const ev of rendererEvents) {
            if (ev.forSessionId && ev.forSessionId !== viewerId) continue;
            const fn = rendererFacade[ev.fn];
            if (typeof fn === 'function') {
                try { fn(...(ev.args || [])); } catch {}
            }
        }
    }
    if (soundEvents && soundEvents.length) {
        for (const ev of soundEvents) {
            const name = typeof ev === 'string' ? ev : ev?.sound;
            if (!name) continue;
            if (typeof ev === 'object' && ev?.forSessionId) {
                if (!viewerId || ev.forSessionId !== viewerId) continue;
            }
            try { audioFacade.playSound(name); } catch {}
        }
    }
}

