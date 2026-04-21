/**
 * Item collection and powerup duration for a marine-shaped actor (inventory
 * on `state.actors[0]` / `getMarine()`).
 */

import {
    PICKUP_EFFECTS, KEY_TYPES, PICKUPS, PICKUP_RANGE,
    MAX_HEALTH, MAX_ARMOR, MAX_AMMO, WEAPON_PICKUPS,
    POWERUP_DURATION,
} from '../constants.js';

import { state, getMarine } from '../state.js';
import { equipWeapon } from '../combat/weapons.js';
import { playSound } from '../../audio/audio.js';
import * as renderer from '../../renderer/index.js';
import { markEntityDirty, markPlayerDirty } from '../services.js';

const marine = () => getMarine();

/** Canonical asset id for a key pickup — matches the SGNL adapter output. */
function keyAssetId(mapThingIndex) {
    return `key:${mapThingIndex}`;
}

/** Canonical asset id for a non-key pickup — matches the SGNL adapter output. */
function pickupAssetId(mapThingIndex) {
    return `pickup:${mapThingIndex}`;
}

function markPickupDirty(thing) {
    const idx = thing.mapThingIndex;
    if (!Number.isFinite(idx)) return;
    const kind = KEY_TYPES[thing.type] ? 'key' : 'pickup';
    const id = kind === 'key' ? keyAssetId(idx) : pickupAssetId(idx);
    markEntityDirty(kind, id);
}

/**
 * Triggers a brief golden flash overlay when the actor picks up an item.
 * Rapid successive pickups restart the flash animation.
 */
function triggerPickupFlash() {
    playSound('DSITEMUP');
    renderer.triggerFlash('pickup-flash');
}

function activatePowerup(actor, name) {
    actor.powerups[name] = POWERUP_DURATION[name];
    renderer.showPowerup(name);

    if (name === 'berserk') {
        // Berserk gives +100 health (capped at 100) and auto-switches to fist
        actor.hp = Math.max(actor.hp, 100);
        equipWeapon(1);
    }
}

/**
 * Scan map things for pickups in range of `actor` and apply effects to that
 * actor's inventory.
 */
export function checkPickupsFor(actor) {
    if (actor.deathMode === 'gameover') return;

    const things = state.things;
    for (let index = 0, length = things.length; index < length; index++) {
        const thing = things[index];
        if (thing.collected) continue;

        const deltaX = actor.x - thing.x;
        const deltaY = actor.y - thing.y;
        const distanceSquared = deltaX * deltaX + deltaY * deltaY;

        if (distanceSquared < PICKUP_RANGE * PICKUP_RANGE) {
            const keyColor = KEY_TYPES[thing.type];
            if (keyColor) {
                actor.collectedKeys.add(keyColor);
                renderer.collectKey(keyColor);
                thing.collected = true;
                renderer.collectItem(index);
                triggerPickupFlash();
                markPlayerDirty();
                markPickupDirty(thing);
                continue;
            }

            const effect = PICKUP_EFFECTS[thing.type];
            if (effect) {
                if (effect.statType === 'health') {
                    // Health Bonus (2014) and Soul Sphere (2013) can push health above 100, up to 200
                    // Based on: linuxdoom-1.10/p_inter.c:P_GiveBody() — bonuses cap at 200
                    const healthCap = (thing.type === 2013 || thing.type === 2014) ? 200 : MAX_HEALTH;
                    if (actor.hp >= healthCap) continue;
                    actor.hp = Math.min(healthCap, actor.hp + effect.amount);
                } else if (effect.statType === 'armor') {
                    if (effect.armorClass && effect.armorClass > 0) {
                        // Green/Blue Armor: P_GiveArmor — skip if current armor >= armorClass * 100
                        // Green (class 1): skip if armor >= 100
                        // Blue (class 2): skip if armor >= 200
                        if (actor.armor >= effect.armorClass * 100) continue;
                        actor.armor = effect.amount;
                        actor.armorType = effect.armorClass;
                    } else {
                        // Armor Bonus (2015): just adds 1 point, caps at MAX_ARMOR (200)
                        // Gives class 1 if player has no armor type yet
                        if (actor.armor >= MAX_ARMOR) continue;
                        actor.armor = Math.min(MAX_ARMOR, actor.armor + effect.amount);
                        if (!actor.armorType) actor.armorType = 1;
                    }
                } else if (effect.statType === 'ammo') {
                    const ammoType = effect.ammoType;
                    if (actor.ammo[ammoType] >= actor.maxAmmo[ammoType]) continue;
                    // Based on: linuxdoom-1.10/p_inter.c — skill 1 & 5 double ammo pickups
                    const amount = (state.skillLevel === 1 || state.skillLevel === 5)
                        ? effect.amount * 2 : effect.amount;
                    actor.ammo[ammoType] = Math.min(actor.maxAmmo[ammoType], actor.ammo[ammoType] + amount);
                } else if (effect.statType === 'powerup') {
                    activatePowerup(actor, effect.powerup);
                }
                thing.collected = true;
                renderer.collectItem(index);
                triggerPickupFlash();
                markPlayerDirty();
                markPickupDirty(thing);
                continue;
            }

            const weaponPickup = WEAPON_PICKUPS[thing.type];
            if (weaponPickup) {
                actor.ownedWeapons.add(weaponPickup.slot);
                equipWeapon(weaponPickup.slot);
                if (weaponPickup.ammoType) {
                    const amount = (state.skillLevel === 1 || state.skillLevel === 5)
                        ? weaponPickup.amount * 2 : weaponPickup.amount;
                    actor.ammo[weaponPickup.ammoType] = Math.min(
                        actor.maxAmmo[weaponPickup.ammoType],
                        actor.ammo[weaponPickup.ammoType] + amount
                    );
                }
            }

            // Based on: linuxdoom-1.10/p_inter.c:P_TouchSpecialThing() — backpack
            // Doubles max ammo capacity and gives one clip of each ammo type.
            if (thing.type === 8) {
                if (!actor.hasBackpack) {
                    actor.hasBackpack = true;
                    for (const type in MAX_AMMO) {
                        actor.maxAmmo[type] = MAX_AMMO[type] * 2;
                    }
                }
                const doubleAmmo = state.skillLevel === 1 || state.skillLevel === 5;
                actor.ammo.bullets = Math.min(actor.maxAmmo.bullets, actor.ammo.bullets + (doubleAmmo ? 20 : 10));
                actor.ammo.shells  = Math.min(actor.maxAmmo.shells,  actor.ammo.shells  + (doubleAmmo ? 8 : 4));
                actor.ammo.rockets = Math.min(actor.maxAmmo.rockets, actor.ammo.rockets + (doubleAmmo ? 2 : 1));
            }

            if (PICKUPS.has(thing.type)) {
                thing.collected = true;
                renderer.collectItem(index);
                triggerPickupFlash();
                markPlayerDirty();
                markPickupDirty(thing);
            }
        }
    }
}

/** Default: marine (`player`). */
export function checkPickups() {
    checkPickupsFor(marine());
}

/**
 * Tick down all active powerup durations on `actor`. Called each frame from
 * the game loop.
 * Based on: linuxdoom-1.10/p_user.c:P_PlayerThink() lines 282-338
 */
export function updatePowerupsFor(actor, deltaTime) {
    for (const name in actor.powerups) {
        if (actor.powerups[name] === Infinity) continue;
        actor.powerups[name] -= deltaTime;

        // Flicker warning in the last 4 seconds
        if (actor.powerups[name] <= 4 && actor.powerups[name] > 0) {
            const visible = Math.floor(actor.powerups[name] * 8) % 2 === 0;
            renderer.flickerPowerup(name, visible);
        }

        if (actor.powerups[name] <= 0) {
            delete actor.powerups[name];
            renderer.hidePowerup(name);
        }
    }
}

/** Default: marine (`player`). */
export function updatePowerups(deltaTime) {
    updatePowerupsFor(marine(), deltaTime);
}

/** Returns true if the named powerup is currently active on `actor`. */
export function hasPowerupFor(actor, name) {
    return actor.powerups[name] > 0;
}

/** Default: marine (`player`) — e.g. invisibility vs enemy aim spread. */
export function hasPowerup(name) {
    return hasPowerupFor(marine(), name);
}
