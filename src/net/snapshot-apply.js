import { state, getMarine } from '../game/state.js';
import * as rendererFacade from '../renderer/index.js';
import * as audioFacade from '../audio/audio.js';
import { WEAPONS, ACTOR_DOM_KEY_OFFSET } from '../game/constants.js';
import {
    LOCAL_SESSION,
    possessFor,
    releaseFor,
    getControlledFor,
} from '../game/possession.js';
import { getSectorAt } from '../game/physics/queries.js';
import { isMapLoading } from './map-sync.js';
import { session } from './session.js';
import { resolveRuntimeId } from '../game/entity/id.js';
import { isControllableBody } from '../game/entity/caps.js';
import {
    currentInterpPos,
    currentProjectileInterpPos,
    projectileInterp,
    renderInterpDt,
    thingInterp,
    updatePlayerRenderFromSnapshot,
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
    } else if (snap.player) {
        applyPlayer(snap.player);
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
        for (const id of despawn) {
            if (id === 0) continue;
            despawnActor(id);
        }
    }
    if (spawn && spawn.length) {
        const spawnSorted = [...spawn].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
        for (const rec of spawnSorted) spawnActor(rec);
    }
    if (update && update.length) {
        const updateSorted = [...update].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
        for (const rec of updateSorted) {
            if (rec.id === 0) applyPlayer(rec);
            else updateActorRecord(rec);
        }
    }
}

function spawnActor(rec) {
    const id = rec.id;
    if (id === 0) {
        applyPlayer(rec);
        return;
    }
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
            rendererFacade.killEnemy(domId, dst.type);
        } else {
            rendererFacade.collectItem(domId);
        }
    }

    const moved =
        prevX !== dst.x ||
        prevY !== dst.y ||
        prevFloorHeight !== dst.floorHeight;

    if (moved) {
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const dt = Math.max(16, 1000 / (session.tickRateHz || 35));
        const existing = thingInterp.get(domId);
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
        thingInterp.set(domId, {
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
        rendererFacade.updateEnemyRotation(domId, dst);
    }
}

function despawnActor(id) {
    const domId = actorDomId(id);
    thingInterp.delete(domId);
    rendererFacade.removeThing(domId);
    state.actors[id] = null;
}

function applyPlayer(p) {
    if (!p) return;
    const prev = {
        x: getMarine().x,
        y: getMarine().y,
        z: getMarine().z,
        floorHeight: getMarine().floorHeight,
        angle: getMarine().viewAngle,
    };
    if (p.x !== undefined) getMarine().x = p.x;
    if (p.y !== undefined) getMarine().y = p.y;
    if (p.z !== undefined) getMarine().z = p.z;
    if (p.angle !== undefined) {
        getMarine().viewAngle = p.angle;
        getMarine().facing = p.angle + Math.PI / 2;
    }
    if (p.floorHeight !== undefined) getMarine().floorHeight = p.floorHeight;
    updatePlayerRenderFromSnapshot(getMarine(), prev);
    if (p.health !== undefined) getMarine().hp = p.health;
    if (p.armor !== undefined) getMarine().armor = p.armor;
    if (p.armorType !== undefined) getMarine().armorType = p.armorType;
    if (p.ammo) {
        for (const key in p.ammo) getMarine().ammo[key] = p.ammo[key];
    }
    if (p.maxAmmo) {
        for (const key in p.maxAmmo) getMarine().maxAmmo[key] = p.maxAmmo[key];
    }
    if (p.ownedWeapons !== undefined) getMarine().ownedWeapons = new Set(p.ownedWeapons);
    if (p.currentWeapon !== undefined) {
        const weaponChanged = p.currentWeapon !== getMarine().currentWeapon;
        getMarine().currentWeapon = p.currentWeapon;
        if (weaponChanged || weaponNeedsRehydrate) {
            const weapon = WEAPONS[getMarine().currentWeapon];
            if (weapon && getMarine().ownedWeapons.has(getMarine().currentWeapon)) {
                rendererFacade.switchWeapon(weapon.name, weapon.fireRate);
                weaponNeedsRehydrate = false;
            }
        }
    }
    if (p.collectedKeys !== undefined) getMarine().collectedKeys = new Set(p.collectedKeys);
    if (p.powerups !== undefined) getMarine().powerups = { ...p.powerups };
    if (p.hasBackpack !== undefined) getMarine().hasBackpack = Boolean(p.hasBackpack);
    if (p.isDead !== undefined || p.isAiDead !== undefined) {
        if (p.isDead) getMarine().deathMode = 'gameover';
        else if (p.isAiDead) getMarine().deathMode = 'ai';
        else getMarine().deathMode = null;
    }
    if (p.isFiring !== undefined) getMarine().isFiring = Boolean(p.isFiring);
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
        if (d.open !== undefined) entry.open = d.open;
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

