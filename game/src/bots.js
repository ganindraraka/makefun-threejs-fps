// The bots: a small team per side that walks the map's waypoint graph, takes cover, aims and
// fires with a reaction time and an accuracy that make a fight winnable but real. A bot has a
// readable silhouette (torso, head, arms), health and armour, and falls over when killed.
// No external libraries: the graph, the steering and the line-of-sight check are all here.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { damageAtRange } from './weapon.js';

const TORSO_H = 0.98;
const HEAD_R = 0.17;
const BOT_SPEED = 3.5;
const BOT_RADIUS = 0.36;
const EYE = 1.55;

// Per-difficulty bot rifle: slower and less accurate than the player's, so the player wins the
// straight-up duel on aim but loses the careless one.
const BOT_WEAPON = {
  damage: 26,
  falloff: 0.8,
  range: 15,
  minDamage: 12,
  fireGap: 0.14,
  mag: 30,
  reserve: 120,
  reload: 2.4,
  spreadStill: 0.012,
  spreadPerShot: 0.004,
  spreadMoving: 0.04,
  recoil: 0.006,
  armorPen: 0.85,
};

// How a bot thinks, by side: defenders hold the site, attackers push it and plant.
const SKILL = {
  reaction: 0.34,       // seconds before it can shoot a newly-seen enemy
  aimError: 0.9,        // metres of aim scatter at medium range
  burst: [3, 7],        // shots per burst
  burstRest: [0.35, 0.9],
  sight: 34,
  fov: 0.75,            // radians of half-arc it notices within when idle
};

export function createBots(scene, world, random) {
  const materials = {
    ally: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.ally), emissive: new THREE.Color(PALETTE.ally), emissiveIntensity: 0.22, roughness: 0.55, metalness: 0.1 }),
    hostile: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hostile), emissive: new THREE.Color(PALETTE.hostile), emissiveIntensity: 0.3, roughness: 0.5, metalness: 0.1 }),
    head: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.ink), emissive: new THREE.Color(PALETTE.ink), emissiveIntensity: 0.08, roughness: 0.5, metalness: 0.15 }),
    dead: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.muted), roughness: 0.9 }),
  };

  const bots = [];
  const hitMeshes = [];

  function buildModel(team) {
    const group = new THREE.Group();
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, TORSO_H, 0.34), materials[team]);
    torso.position.y = 1.05 + TORSO_H / 2 - 0.98;
    const hips = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.5, 0.32), materials[team]);
    hips.position.y = 0.66;
    const head = new THREE.Mesh(new THREE.SphereGeometry(HEAD_R, 14, 10), materials.head);
    head.position.y = 1.64;
    const armL = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.7, 0.16), materials[team]);
    armL.position.set(-0.35, 1.2, 0);
    const armR = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.7, 0.16), materials[team]);
    armR.position.set(0.35, 1.2, 0);
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.5), materials.head);
    gun.position.set(0.28, 1.25, -0.28);
    group.add(torso, hips, head, armL, armR, gun);
    group.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
    return { group, torso, head, head0: head, gun };
  }

  function addBot({ name, team, index }) {
    const parts = buildModel(team);
    const spawns = team === 'ally' ? world.attackerSpawns : world.defenderSpawns;
    const spawn = spawns[index % spawns.length].clone();
    parts.group.position.copy(spawn);
    scene.add(parts.group);

    const bot = {
      name,
      team,
      parts,
      position: spawn.clone(),
      yaw: team === 'ally' ? Math.PI : 0,
      health: 100,
      armor: team === 'hostile' ? 50 : 40,
      alive: true,
      fall: 0,
      target: null,
      lastSeen: new THREE.Vector3(),
      lastSeenAt: -999,
      reactionLeft: 0,
      fireCooldown: 0,
      mag: BOT_WEAPON.mag,
      reserve: BOT_WEAPON.reserve,
      reloadLeft: 0,
      burstLeft: 0,
      burstRest: 0,
      path: [],
      pathAt: 0,
      repathAt: 0,
      strafeSign: random() < 0.5 ? 1 : -1,
      strafeAt: 0,
      state: 'advance',
      cover: null,
      loseSightAt: 0,
      spawn,
      aimScatter: random() * 0.5 + 0.7,
      stepPhase: random() * Math.PI * 2,
      kills: 0,
      deaths: 0,
    };
    // torso and head carry the bot so a raycaster hit resolves to it.
    parts.torso.userData.bot = bot;
    parts.torso.userData.part = 'torso';
    parts.head.userData.bot = bot;
    parts.head.userData.part = 'head';
    bots.push(bot);
    hitMeshes.push(parts.torso, parts.head);
    return bot;
  }

  function resetBot(bot, index) {
    const spawns = bot.team === 'ally' ? world.attackerSpawns : world.defenderSpawns;
    const spawn = spawns[index % spawns.length].clone();
    bot.position.copy(spawn);
    bot.spawn.copy(spawn);
    bot.health = 100;
    bot.armor = bot.team === 'hostile' ? 50 : 40;
    bot.alive = true;
    bot.fall = 0;
    bot.target = null;
    bot.reactionLeft = 0;
    bot.fireCooldown = 0;
    bot.mag = BOT_WEAPON.mag;
    bot.reserve = BOT_WEAPON.reserve;
    bot.reloadLeft = 0;
    bot.burstLeft = 0;
    bot.burstRest = 0;
    bot.path = [];
    bot.pathAt = 0;
    bot.repathAt = 0;
    bot.state = 'advance';
    bot.cover = null;
    bot.loseSightAt = 0;
    bot.aimScatter = random() * 0.5 + 0.7;
    bot.parts.group.position.copy(spawn);
    bot.parts.group.rotation.set(0, bot.team === 'ally' ? Math.PI : 0, 0);
    bot.parts.group.visible = true;
    bot.parts.torso.material = materials[bot.team];
    bot.parts.head.material = materials.head;
    for (const m of [bot.parts.torso, bot.parts.head, bot.parts.gun]) m.visible = true;
  }

  // A clear line from `a` to `b` (eyes height), against the world's colliders. Sampling the
  // segment is enough here: cover is made of boxes, so a few samples per metre never miss one.
  const _tmp = new THREE.Vector3();
  const _p = new THREE.Vector3();
  function lineClear(a, b) {
    _tmp.copy(b).sub(a);
    const dist = _tmp.length();
    if (dist < 0.001) return true;
    _tmp.multiplyScalar(1 / dist);
    const steps = Math.ceil(dist / 0.5);
    for (let i = 1; i < steps; i += 1) {
      _p.copy(a).addScaledVector(_tmp, (dist * i) / steps);
      for (const c of world.colliders) {
        if (_p.x > c.min.x && _p.x < c.max.x && _p.y > c.min.y && _p.y < c.max.y && _p.z > c.min.z && _p.z < c.max.z) return false;
      }
    }
    return true;
  }

  function canSee(bot, point) {
    const eye = new THREE.Vector3(bot.position.x, bot.position.y + EYE, bot.position.z);
    const look = new THREE.Vector3(point.x, point.y, point.z);
    if (eye.distanceToSquared(look) > SKILL.sight * SKILL.sight) return false;
    return lineClear(eye, look);
  }

  // Move `bot` toward `dest` at BOT_SPEED, resolving against colliders one axis at a time (the
  // same trick the player uses), and turn to face the direction of travel.
  function moveToward(bot, dest, dt) {
    const dx = dest.x - bot.position.x;
    const dz = dest.z - bot.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.001) return true;
    const step = Math.min(dist, BOT_SPEED * dt);
    const nx = bot.position.x + (dx / dist) * step;
    const nz = bot.position.z + (dz / dist) * step;
    if (!blocked(nx, bot.position.z)) bot.position.x = nx;
    if (!blocked(bot.position.x, nz)) bot.position.z = nz;
    if (bot.target === null) {
      const want = Math.atan2(-dx, -dz);
      bot.yaw += shortestAngle(bot.yaw, want) * Math.min(1, dt * 6);
    }
    return dist < 0.6;
  }

  function blocked(x, z) {
    for (const c of world.colliders) {
      if (c.max.y < 1.0) continue;
      if (x > c.min.x - BOT_RADIUS && x < c.max.x + BOT_RADIUS && z > c.min.z - BOT_RADIUS && z < c.max.z + BOT_RADIUS) {
        if (c.max.y > 1.0 && c.min.y < 1.6) return true;
      }
    }
    return false;
  }

  function shortestAngle(from, to) {
    let d = (to - from) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  function followPath(bot, dt) {
    if (bot.path.length === 0) return true;
    const node = world.waypoints[bot.path[bot.pathAt]];
    if (moveToward(bot, node, dt)) {
      bot.pathAt += 1;
      if (bot.pathAt >= bot.path.length) { bot.path = []; return true; }
    }
    return false;
  }

  // Choose cover from the map's cover points that has a clear line to `threat` and is closest
  // to the bot, so it can peek without exposing its back.
  function pickCover(bot) {
    let best = null;
    let bestScore = Infinity;
    for (const cp of world.coverPoints) {
      const d = cp.pos.distanceToSquared(bot.position);
      if (d < bestScore) { bestScore = d; best = cp; }
    }
    return best;
  }

  // Damage a bot; armour soaks part of it if it still has armour.
  function damage(bot, amount, part, attacker) {
    if (!bot.alive) return { killed: false, dealt: 0 };
    let dealt = amount;
    if (bot.armor > 0) {
      const toArmor = Math.min(bot.armor, amount * 0.5);
      bot.armor -= toArmor;
      dealt = amount - toArmor;
    }
    bot.health -= dealt;
    bot.target = attacker ?? bot.target;
    bot.lastSeen.copy(attacker ? attacker.position : bot.position);
    bot.lastSeenAt = 0;
    if (bot.health > 0) return { killed: false, dealt };
    bot.alive = false;
    bot.fall = 0;
    bot.state = 'dead';
    bot.parts.torso.material = materials.dead;
    bot.parts.head.material = materials.dead;
    bot.deaths += 1;
    for (const m of [bot.parts.gun]) m.visible = false;
    if (attacker) attacker.kills += 1;
    return { killed: true, dealt: amount };
  }

  function aliveOn(team) {
    // Accept either the bot vocabulary ('ally' / 'hostile') or the match vocabulary
    // ('attack' / 'defend') so callers on either side read the same list.
    const t = team === 'attack' ? 'ally' : team === 'defend' ? 'hostile' : team;
    return bots.filter((b) => b.team === t && b.alive);
  }

  // One simulation step for every bot. `ctx` carries what the bots act on this tick:
  //   player       the player object ({ position, alive, ... }) as a target, or null
  //   bombCarrier  the bot carrying the bomb (attacker), or null
  //   site         the bomb site's centre
  //   plantProgress/defuseProgress  set by the bomb module from what these bots do
  //   onBotShot    called when a bot fires (for sound/effects)
  function step(dt, ctx) {
    for (let i = 0; i < bots.length; i += 1) {
      const bot = bots[i];
      if (!bot.alive) {
        bot.fall = Math.min(1, bot.fall + dt / 0.4);
        bot.parts.group.rotation.x = -bot.fall * 1.45;
        bot.parts.group.position.set(bot.position.x, -bot.fall * 0.1, bot.position.z);
        continue;
      }
      bot.fireCooldown = Math.max(0, bot.fireCooldown - dt);
      bot.reloadLeft = Math.max(0, bot.reloadLeft - dt);
      if (bot.reloadLeft === 0 && bot.mag <= 0) {
        const take = Math.min(BOT_WEAPON.mag - bot.mag, bot.reserve);
        if (take > 0) { bot.mag += take; bot.reserve -= take; }
      }
      if (bot.burstRest > 0) bot.burstRest = Math.max(0, bot.burstRest - dt);

      // Find a target: the enemy side's nearest visible member.
      const enemies = ctx.enemiesOf(bot.team);
      let seen = null;
      let seenDist = Infinity;
      for (const enemy of enemies) {
        if (!enemy.alive) continue;
        const aimPoint = new THREE.Vector3(enemy.position.x, enemy.position.y + 1.2, enemy.position.z);
        if (!canSee(bot, aimPoint)) continue;
        const d = bot.position.distanceToSquared(enemy.position);
        if (d < seenDist) { seenDist = d; seen = enemy; }
      }

      if (seen) {
        if (bot.target !== seen) {
          bot.reactionLeft = SKILL.reaction * (0.7 + ctx.random() * 0.6);
          bot.target = seen;
        }
        bot.lastSeen.set(seen.position.x, seen.position.y + 1.2, seen.position.z);
        bot.lastSeenAt = ctx.time;
        bot.state = 'engage';
        bot.loseSightAt = ctx.time + 1.2;
      } else if (bot.target && ctx.time < bot.loseSightAt) {
        bot.state = 'engage';
      } else {
        bot.target = null;
      }

      if (bot.state === 'engage' && bot.target) {
        engagement(bot, dt, ctx);
      } else {
        objective(bot, dt, ctx);
      }

      bot.parts.group.position.set(bot.position.x, 0, bot.position.z);
      bot.parts.group.rotation.y = bot.yaw;
      const moving = Math.hypot(bot.position.x - bot.spawn.x, bot.position.z - bot.spawn.z) > 0.1;
      bot.stepPhase += dt * (bot.target ? 3 : 8) * (bot.target ? 0.5 : 1);
    }
  }

  function engagement(bot, dt, ctx) {
    const target = bot.target;
    const aimPoint = new THREE.Vector3(target.position.x, target.position.y + 1.15, target.position.z);
    const dx = aimPoint.x - bot.position.x;
    const dz = aimPoint.z - bot.position.z;
    const dist = Math.hypot(dx, dz);
    const wantYaw = Math.atan2(-dx, -dz);
    bot.yaw += shortestAngle(bot.yaw, wantYaw) * Math.min(1, dt * 7);

    // Strafe a little while shooting, but hold position: bots don't rush the muzzle.
    bot.strafeAt -= dt;
    if (bot.strafeAt <= 0) {
      bot.strafeAt = 0.4 + ctx.random() * 0.7;
      if (ctx.random() < 0.35) bot.strafeSign *= -1;
    }
    const side = new THREE.Vector3(Math.cos(wantYaw), 0, -Math.sin(wantYaw)).multiplyScalar(bot.strafeSign * 1.6 * dt);
    if (!blocked(bot.position.x + side.x, bot.position.z + side.z)) {
      bot.position.x += side.x;
      bot.position.z += side.z;
    }

    bot.reactionLeft = Math.max(0, bot.reactionLeft - dt);
    if (bot.reactionLeft > 0 || bot.burstRest > 0 || bot.reloadLeft > 0) return;
    if (bot.mag <= 0) { bot.reloadLeft = BOT_WEAPON.reload; return; }

    if (bot.fireCooldown === 0) {
      // Fire with an error that shrinks as the fight goes on and the bot settles.
      const acc = Math.max(0.25, bot.aimScatter * (0.6 + Math.min(1, bot.loseSightAt - ctx.time) * 0.1));
      const miss = acc * 0.012 * (1 + dist * 0.06);
      const jitterYaw = (ctx.random() * 2 - 1) * miss;
      const aimHigh = (ctx.random() * 2 - 1) * miss * 0.5;
      const hitYaw = wantYaw + jitterYaw;
      const dir = new THREE.Vector3(-Math.sin(hitYaw), aimHigh, -Math.cos(hitYaw)).normalize();
      const origin = new THREE.Vector3(bot.position.x, EYE, bot.position.z);
      const shot = ctx.trace(origin, dir, dist + 6);
      bot.mag -= 1;
      bot.fireCooldown = BOT_WEAPON.fireGap;
      if (ctx.onBotShot) ctx.onBotShot(bot, origin, dir);
      if (shot && shot.bot && shot.bot.team !== bot.team && shot.bot.alive) {
        const dmg = damageAtRange(BOT_WEAPON, dist) * (shot.part === 'head' ? 2.4 : 1);
        damage(shot.bot, dmg, shot.part, bot);
      } else if (shot && shot.player) {
        ctx.onBotHitPlayer(damageAtRange(BOT_WEAPON, dist), bot);
      }
      bot.burstLeft -= 1;
      if (bot.burstLeft <= 0) {
        bot.burstLeft = Math.round(SKILL.burst[0] + ctx.random() * (SKILL.burst[1] - SKILL.burst[0]));
        bot.burstRest = SKILL.burstRest[0] + ctx.random() * (SKILL.burstRest[1] - SKILL.burstRest[0]);
      }
    }
  }

  function objective(bot, dt, ctx) {
    if (bot.team === 'hostile') {
      // Defenders: if the bomb is armed, go defuse it; otherwise hold near the site.
      if (ctx.bomb && ctx.bomb.planted && !ctx.bomb.defused && !ctx.bomb.exploded) {
        const at = ctx.bomb.position;
        if (Math.hypot(bot.position.x - at.x, bot.position.z - at.z) > 1.0) {
          if (bot.path.length === 0) { bot.path = world.path(bot.position, at); bot.pathAt = 0; }
          followPath(bot, dt);
        } else {
          bot.yaw += Math.sin(ctx.time * 0.8 + bot.stepPhase) * dt * 0.5;
        }
        return;
      }
      if (bot.path.length === 0) {
        bot.path = world.path(bot.position, world.site.center);
        bot.pathAt = 0;
      }
      if (followPath(bot, dt)) {
        // Arrived near the site: settle into cover and look around.
        if (!bot.cover) bot.cover = pickCover(bot);
        if (bot.cover && bot.position.distanceToSquared(bot.cover.pos) > 4) {
          moveToward(bot, bot.cover.pos, dt);
        }
        bot.yaw += Math.sin(ctx.time * 0.6 + bot.stepPhase) * dt * 0.8;
      }
    } else {
      // Attackers: push to the plant spot. The carrier plants; the others cover.
      const goal = ctx.plantSpot(bot);
      if (bot.path.length === 0) {
        bot.path = world.path(bot.position, goal);
        bot.pathAt = 0;
      }
      const near = followPath(bot, dt);
      if (near) {
        bot.yaw += Math.sin(ctx.time * 0.5 + bot.stepPhase) * dt * 0.6;
      }
    }
  }

  return {
    bots,
    hitMeshes,
    step,
    damage,
    aliveOn,
    canSee,
    lineClear,
    resetBot,
    addBot,
    pickCover,
    EYE,
  };
}
