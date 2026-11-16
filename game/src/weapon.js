// The arsenal: four weapons with different damage, fire rate, accuracy and price, plus armour.
// A weapon owns its view model, magazine, reload, and the spread and recoil that grow as the
// trigger is held and the player moves. main.js owns the ray and the damage.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

// Feel model: every shot has three independent costs. `cooldown` limits cadence,
// `bloom` makes a sustained trigger less precise, and `kick` moves the view model
// and camera. They decay at different rates so tapping regains accuracy quickly,
// while the visible kick settles a little later and sells the weight of the gun.
// Reloading is a transaction at the end of its timer: the magazine never partially
// refills, which keeps the HUD and the simulation in agreement.

// Each weapon: cost, damage at point blank, falloff (damage lost per metre past its range),
// fire gap in seconds, magazine, reserve, reload seconds, the spread of a single still shot,
// how fast spread grows per shot, and how much spread a full sprint adds.
export const WEAPONS = {
  rifle: {
    key: 'rifle',
    name: 'Vanguard AR',
    cost: 2700,
    damage: 36,
    falloff: 0.9,       // damage per metre past `range`
    range: 18,          // metres before falloff starts
    minDamage: 14,
    fireGap: 0.096,     // ~625 rpm
    mag: 30,
    reserve: 90,
    reload: 2.1,
    spreadStill: 0.0018,
    spreadPerShot: 0.0016,
    spreadMoving: 0.030,
    recoil: 0.0105,
    armorPen: 0.9,
    auto: true,
  },
  smg: {
    key: 'smg',
    name: 'Wasp SMG',
    cost: 1500,
    damage: 22,
    falloff: 1.0,
    range: 12,
    minDamage: 10,
    fireGap: 0.068,     // ~880 rpm
    mag: 30,
    reserve: 120,
    reload: 1.9,
    spreadStill: 0.0032,
    spreadPerShot: 0.0019,
    spreadMoving: 0.022,
    recoil: 0.0082,
    armorPen: 0.75,
    auto: true,
  },
  shotgun: {
    key: 'shotgun',
    name: 'Breaker 12',
    cost: 1900,
    damage: 15,         // per pellet, 8 pellets
    pellets: 8,
    falloff: 1.4,
    range: 8,
    minDamage: 3,
    fireGap: 0.82,
    mag: 6,
    reserve: 30,
    reload: 2.6,
    spreadStill: 0.052,
    spreadPerShot: 0,
    spreadMoving: 0.02,
    recoil: 0.05,
    armorPen: 0.7,
    auto: false,
  },
  sniper: {
    key: 'sniper',
    name: 'Longview DMR',
    cost: 4200,
    damage: 95,
    falloff: 0.2,
    range: 40,
    minDamage: 70,
    fireGap: 0.62,
    mag: 10,
    reserve: 40,
    reload: 2.6,
    spreadStill: 0.0005,
    spreadPerShot: 0.010,
    spreadMoving: 0.055,
    recoil: 0.028,
    armorPen: 1.0,
    auto: false,
  },
};

export const ARMOR_COST = 650;
export const ARMOR_VALUE = 100;

export function createWeapon(camera, random) {
  const grip = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hairline), roughness: 0.7, metalness: 0.2 });
  const body = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.ink), roughness: 0.5, metalness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.canvas), roughness: 0.6, metalness: 0.3 });

  const model = new THREE.Group();
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, 0.42), body);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.045, 0.4), grip);
  barrel.position.set(0, 0.025, -0.38);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.08, 0.22), grip);
  stock.position.set(0, -0.02, 0.3);
  const scope = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.16), dark);
  scope.position.set(0, 0.085, -0.05);
  model.add(receiver, barrel, stock, scope);
  model.position.set(0.24, -0.2, -0.42);
  camera.add(model);

  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.24, 0.24),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
  );
  flash.position.set(0.24, -0.18, -0.95);
  flash.visible = false;
  camera.add(flash);

  const flashLight = new THREE.PointLight(new THREE.Color(PALETTE.accent), 0, 5);
  flashLight.position.set(0.24, -0.16, -0.6);
  camera.add(flashLight);

  const state = {
    weapon: WEAPONS.rifle,
    mag: WEAPONS.rifle.mag,
    reserve: WEAPONS.rifle.reserve,
    cooldown: 0,
    reloadLeft: 0,
    flash: 0,
    kick: 0,
    bloom: 0,       // extra spread accumulated from firing
    sinceShot: 10,
    reloadDuration: 0,
    feedback: 0,
    armor: 0,
    shotCount: 0,
    reloadCount: 0,
    dryFire: 0,
    lastShot: null,
  };

  function equip(key) {
    const weapon = WEAPONS[key];
    if (!weapon) return;
    state.weapon = weapon;
    state.mag = weapon.mag;
    state.reserve = weapon.reserve;
    state.cooldown = 0;
    state.reloadLeft = 0;
    state.bloom = 0;
    state.kick = 0;
    state.flash = 0;
    state.feedback = 0;
    state.sinceShot = 10;
    state.shotCount = 0;
    state.reloadCount = 0;
    state.dryFire = 0;
    state.lastShot = null;
  }

  function step(dt) {
    dt = Math.max(0, dt);
    state.sinceShot += dt;
    state.cooldown = Math.max(0, state.cooldown - dt);
    state.flash = Math.max(0, state.flash - dt);
    state.kick *= Math.exp(-dt * 14);
    // A short settling delay makes bursts tighter than sustained automatic fire.
    if (state.sinceShot > state.weapon.fireGap + 0.08) state.bloom *= Math.exp(-dt * 7);
    state.feedback = Math.max(0, state.feedback - dt);
    state.dryFire = Math.max(0, state.dryFire - dt);
    model.position.z = -0.42 + state.kick;
    model.rotation.x = state.kick * 2.2;
    model.position.y = -0.2 + state.feedback * 0.025;
    scope.visible = state.weapon !== WEAPONS.shotgun;
    flash.visible = state.flash > 0;
    flash.rotation.z = state.flash * 30;
    flashLight.intensity = state.flash > 0 ? 18 : 0;
    if (state.reloadLeft > 0) {
      state.reloadLeft = Math.max(0, state.reloadLeft - dt);
      const progress = 1 - state.reloadLeft / state.reloadDuration;
      const dip = Math.sin(progress * Math.PI);
      model.rotation.x = -0.55 * dip;
      model.position.y = -0.2 - dip * 0.12;
      if (state.reloadLeft === 0) {
        const need = state.weapon.mag - state.mag;
        const take = Math.min(need, state.reserve);
        state.mag += take;
        state.reserve -= take;
      }
    }
  }

  return {
    state,
    step,
    equip,
    ready() {
      return state.mag > 0 && state.cooldown === 0 && state.reloadLeft === 0;
    },
    pullTrigger() {
      if (state.reloadLeft > 0 || state.cooldown > 0) return false;
      if (state.mag <= 0) {
        state.dryFire = 0.08;
        // A dry click has a short lockout, but never inherits the full fire gap;
        // the player can reload immediately and shoot on the next frame.
        state.cooldown = Math.min(0.12, state.weapon.fireGap * 0.75);
        return false;
      }
      state.cooldown = state.weapon.fireGap;
      state.sinceShot = 0;
      state.flash = 0.06;
      state.kick = Math.min(0.12, state.kick + 0.025 + state.weapon.recoil);
      state.feedback = 0.1; // immediate firing impulse; confirmed hits use main.js's HUD marker
      state.bloom = Math.min(0.055, state.bloom + state.weapon.spreadPerShot);
      state.shotCount += 1;
      state.lastShot = { sequence: state.shotCount, weapon: state.weapon.key, recoil: state.recoilKick(), spread: state.bloom };
      return true;
    },
    takeRound() {
      if (state.mag <= 0 || state.reloadLeft > 0 || state.cooldown > 0) return false;
      state.mag -= 1;
      return true;
    },
    reload() {
      if (state.reloadLeft > 0 || state.mag === state.weapon.mag || state.reserve === 0) return false;
      state.reloadDuration = state.weapon.reload + (state.mag === 0 ? 0.25 : 0);
      state.reloadLeft = state.reloadDuration;
      state.reloadCount += 1;
      return true;
    },
    // Total cone half-angle for a shot taken right now, from the weapon's base, the movement
    // (speed / top speed) and the firing bloom.
    spread(speed) {
      const w = state.weapon;
      const move = Math.min(1, Math.max(0, speed) / 5.2) * w.spreadMoving;
      return w.spreadStill + state.bloom + move;
    },
    recoilKick() {
      return state.weapon.recoil * (1 + state.bloom * 8);
    },
    refill() {
      state.mag = state.weapon.mag;
      state.reserve = state.weapon.reserve;
      state.cooldown = 0;
      state.reloadLeft = 0;
      state.flash = 0;
      state.kick = 0;
      state.bloom = 0;
      state.sinceShot = 10;
      state.feedback = 0;
      state.reloadDuration = 0;
      state.shotCount = 0;
      state.reloadCount = 0;
      state.dryFire = 0;
      state.lastShot = null;
    },
    report() {
      return {
        name: state.weapon.name,
        ammo: { magazine: state.mag, reserve: state.reserve },
        reloading: state.reloadLeft > 0,
        reloadProgress: state.reloadDuration > 0 ? 1 - state.reloadLeft / state.reloadDuration : 0,
        spread: state.bloom,
        recoil: state.kick,
        shotCount: state.shotCount,
        reloadCount: state.reloadCount,
        dryFire: state.dryFire > 0,
        lastShot: state.lastShot,
      };
    },
  };
}

// Damage of `weapon` on a hit `distance` metres away, with a small deterministic spread.
export function damageAtRange(weapon, distance) {
  const past = Math.max(0, distance - weapon.range);
  return Math.max(weapon.minDamage, weapon.damage - past * weapon.falloff);
}
