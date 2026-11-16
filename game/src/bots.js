import * as THREE from "three";
import { PALETTE } from "./palette.js";
import { WEAPONS, ARMOR_COST, ARMOR_VALUE, damageAtRange } from "./weapon.js";

const EYE = 1.55;
const SPEED = 3.5;
const SKILL = {
  easy: { reaction: 0.65, spread: 0.045, rest: 0.85, sight: 26 },
  normal: { reaction: 0.36, spread: 0.023, rest: 0.55, sight: 34 },
  hard: { reaction: 0.22, spread: 0.012, rest: 0.32, sight: 42 },
};
const STATES = new Set([
  "Idle",
  "SeekCover",
  "Advance",
  "Engage",
  "Retreat",
  "PlantBomb",
  "DefuseBomb",
  "Buy",
]);
// Tactical labels are separate from animation/action states. A bot can be in
// `Engage` while its higher-level plan is to trade, hold, or save.
const TACTICS = Object.freeze({
  HOLD: "hold",
  PUSH: "push",
  TRADE: "trade",
  ROTATE: "rotate",
  SAVE: "save",
});
const WEAPON_ORDER = ["rifle", "smg", "shotgun", "sniper"];

// Bot design notes (kept beside the implementation so the source remains useful
// to a reviewer and to future tuning passes):
// 1. Perception is conservative. A bot only acquires a target when a segment from
//    its eye to the enemy eye is clear of every world collider.
// 2. Memory is short. `lastSeenAt` is used for a 1.5 second investigation window,
//    after which the bot returns to its objective instead of wall tracking.
// 3. Action states are intentionally small. Movement, aiming, planting and defusing
//    each have one owner, which makes interruption behavior predictable.
// 4. Tactical intent is recomputed from health, ammunition, objective state and sight.
//    This prevents a bot from getting stuck in an old plan after a teammate dies.
// 5. Economy choices are visible through `buyDecision`; this is useful for UI and
//    makes a round feel authored rather than random.
// 6. Damage is reported in the same place as hit registration, so armor absorption
//    and kill rewards cannot disagree about what happened.
// 7. Navigation uses world.path and collision checks at every movement step. A bad
//    waypoint therefore causes a slow stop, never a teleport through geometry.
// 8. Cover points are selected by distance plus exposure. The score is deliberately
//    simple enough to tune by hand while still producing different lanes of play.
// 9. Burst timing gives every difficulty a readable rhythm: reaction, three shots,
//    a short rest, then reassessment.
// 10. The summary method exposes stable, presentation-ready fields without exposing
//     mutable vector internals to the HUD.

// main.js owns objective progress and damage to the player; bots own positioning and shots.
export function createBots(scene, world, random) {
  const bots = [],
    hitMeshes = [],
    materials = {};
  for (const key of ["ally", "hostile", "ink", "muted"]) {
    materials[key] = new THREE.MeshStandardMaterial({
      color: new THREE.Color(PALETTE[key]),
      roughness: 0.65,
    });
  }
  const eyeOf = (p, height = EYE) =>
    p.clone().add(new THREE.Vector3(0, height, 0));
  function transition(bot, state) {
    if (!STATES.has(state)) throw new Error(`Unknown bot state: ${state}`);
    if (bot.state === state) return;
    Object.assign(bot, { state, stateAge: 0, path: [], pathAt: 0, goal: null });
  }
  function buy(bot) {
    const fullBuy = bot.money >= WEAPONS.rifle.cost + ARMOR_COST;
    if (!bot.survived || bot.money < (bot.weapon?.cost ?? 0) * 0.45) {
      // Buy the strongest planned tier we can actually pay for. Saving leaves
      // the current weapon in place and never produces a negative balance.
      const key = (fullBuy ? ["rifle", "smg"] : ["smg"]).find(
        (candidate) =>
          WEAPON_ORDER.includes(candidate) &&
          bot.money >= WEAPONS[candidate].cost,
      );
      if (key) {
        bot.weapon = WEAPONS[key];
        bot.money -= bot.weapon.cost;
      }
    }
    if (bot.armor < 50 && bot.money >= ARMOR_COST) {
      bot.money -= ARMOR_COST;
      bot.armor = ARMOR_VALUE;
    }
    bot.mag = bot.weapon.mag;
    bot.reserve = bot.weapon.reserve;
    bot.buyDecision = {
      weapon: bot.weapon.key,
      armor: bot.armor,
      remaining: bot.money,
      fullBuy,
      label: fullBuy
        ? "FULL BUY"
        : bot.money >= WEAPONS.smg.cost
          ? "FORCE BUY"
          : "SAVE",
    };
  }
  function addBot({ name, team, index = 0, difficulty = "normal" }) {
    const group = new THREE.Group();
    function mesh(geometry, material, x, y, z) {
      const part = new THREE.Mesh(geometry, material);
      part.position.set(x, y, z);
      part.castShadow = true;
      group.add(part);
      return part;
    }
    const torso = mesh(
      new THREE.BoxGeometry(0.5, 0.98, 0.34),
      materials[team],
      0,
      1.05,
      0,
    );
    const head = mesh(
      new THREE.SphereGeometry(0.17, 14, 10),
      materials.ink,
      0,
      1.64,
      0,
    );
    mesh(new THREE.BoxGeometry(0.46, 0.5, 0.32), materials[team], 0, 0.6, 0);
    for (const x of [-0.35, 0.35])
      mesh(new THREE.BoxGeometry(0.14, 0.7, 0.16), materials[team], x, 1.2, 0);
    const gun = mesh(
      new THREE.BoxGeometry(0.08, 0.08, 0.5),
      materials.ink,
      0.28,
      1.25,
      -0.28,
    );
    const bot = {
      name,
      team,
      difficulty,
      skill: SKILL[difficulty] ?? SKILL.normal,
      parts: { group, torso, head, head0: head, gun },
      position: new THREE.Vector3(),
      spawn: new THREE.Vector3(),
      lastSeen: new THREE.Vector3(),
      money: 800,
      weapon: WEAPONS.smg,
      armor: 0,
      alive: false,
      kills: 0,
      deaths: 0,
      state: "Idle",
      aimScatter: 0.85 + random() * 0.3,
      stepPhase: random() * Math.PI * 2,
      tactic: TACTICS.HOLD,
      decision: "spawned",
      radioTimer: 0,
      shotsFired: 0,
      shotsHit: 0,
      damageDone: 0,
    };
    torso.userData = { bot, part: "torso" };
    head.userData = { bot, part: "head" };
    bots.push(bot);
    hitMeshes.push(torso, head);
    scene.add(group);
    resetBot(bot, index);
    return bot;
  }
  function resetBot(bot, index = 0) {
    bot.survived = bot.alive;
    if (!bot.survived) bot.armor = 0;
    bot.money = Math.min(16000, bot.money + 2400);
    const spawns =
      bot.team === "ally" ? world.attackerSpawns : world.defenderSpawns;
    bot.position.copy(spawns[index % spawns.length]);
    bot.spawn.copy(bot.position);
    Object.assign(bot, {
      health: 100,
      alive: true,
      fall: 0,
      target: null,
      reactionLeft: 0,
      fireCooldown: 0,
      reloadLeft: 0,
      burstLeft: 3,
      burstRest: 0,
      path: [],
      pathAt: 0,
      goal: null,
      repathLeft: 0,
      cover: null,
      lastSeenAt: -Infinity,
      hasBomb: false,
      defusing: false,
      stateAge: 0,
      yaw: bot.team === "ally" ? Math.PI : 0,
      tactic: bot.team === "ally" ? TACTICS.TRADE : TACTICS.HOLD,
      decision: "buying loadout",
      radioTimer: random() * 2,
      shotsFired: 0,
      shotsHit: 0,
      damageDone: 0,
    });
    transition(bot, "Buy");
    buy(bot);
    bot.parts.group.position.copy(bot.position);
    bot.parts.group.rotation.set(0, bot.yaw, 0);
    bot.parts.torso.material = materials[bot.team];
    bot.parts.head.material = materials.ink;
    bot.parts.gun.visible = true;
  }
  function lineClear(a, b) {
    // Exact segment/box intersection avoids seeing through thin walls.
    for (const box of world.colliders) {
      let near = 0,
        far = 1;
      for (const axis of ["x", "y", "z"]) {
        const delta = b[axis] - a[axis];
        if (Math.abs(delta) < 1e-8) {
          if (a[axis] < box.min[axis] || a[axis] > box.max[axis]) {
            near = 2;
            break;
          }
        } else {
          const t1 = (box.min[axis] - a[axis]) / delta,
            t2 = (box.max[axis] - a[axis]) / delta;
          near = Math.max(near, Math.min(t1, t2));
          far = Math.min(far, Math.max(t1, t2));
        }
      }
      if (near <= far && far > 0.001 && near < 0.999) return false;
    }
    return true;
  }
  function canSee(bot, point) {
    const eye = eyeOf(bot.position);
    return (
      eye.distanceToSquared(point) <= bot.skill.sight ** 2 &&
      lineClear(eye, point)
    );
  }
  function blocked(x, z) {
    return world.colliders.some(
      (c) =>
        c.max.y > 0.4 &&
        c.min.y < 1.8 &&
        x > c.min.x - 0.36 &&
        x < c.max.x + 0.36 &&
        z > c.min.z - 0.36 &&
        z < c.max.z + 0.36,
    );
  }
  function moveToward(bot, dest, dt) {
    const dx = dest.x - bot.position.x,
      dz = dest.z - bot.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 0.3) return true;
    const scale = Math.min(distance, SPEED * dt) / distance;
    const x = bot.position.x + dx * scale,
      z = bot.position.z + dz * scale;
    if (!blocked(x, bot.position.z)) bot.position.x = x;
    if (!blocked(bot.position.x, z)) bot.position.z = z;
    if (!bot.target) bot.yaw = Math.atan2(-dx, -dz);
    return false;
  }
  function navigate(bot, goal, dt) {
    bot.repathLeft -= dt;
    if (
      !bot.goal ||
      bot.goal.distanceToSquared(goal) > 1 ||
      bot.repathLeft <= 0
    ) {
      bot.goal = goal.clone();
      bot.path = world.path(bot.position, goal);
      bot.pathAt = 0;
      bot.repathLeft = 2;
    }
    const node = world.waypoints[bot.path[bot.pathAt]];
    if (node) {
      if (moveToward(bot, node, dt)) bot.pathAt += 1;
      return false;
    }
    return moveToward(bot, goal, dt);
  }
  function pickCover(bot) {
    let best = null,
      score = Infinity;
    for (const cover of world.coverPoints) {
      if (blocked(cover.pos.x, cover.pos.z)) continue;
      const exposed =
        bot.target &&
        lineClear(eyeOf(cover.pos), eyeOf(bot.target.position, 1.2));
      const value =
        bot.position.distanceToSquared(cover.pos) + (exposed ? 180 : 0);
      if (value < score) {
        best = cover;
        score = value;
      }
    }
    return best;
  }
  function damage(bot, amount, part, attacker) {
    if (!bot.alive) return { killed: false, dealt: 0 };
    const absorbed = Math.min(bot.armor, amount * 0.5);
    bot.armor -= absorbed;
    const dealt = amount - absorbed;
    bot.health = Math.max(0, bot.health - dealt);
    if (attacker?.position) {
      bot.lastSeen.copy(attacker.position);
      bot.target = attacker;
      bot.reactionLeft = bot.skill.reaction;
    }
    if (bot.health > 0) return { killed: false, dealt };
    bot.alive = false;
    bot.defusing = false;
    bot.deaths += 1;
    bot.parts.torso.material = materials.muted;
    bot.parts.head.material = materials.muted;
    bot.parts.gun.visible = false;
    if (attacker) {
      attacker.kills = (attacker.kills ?? 0) + 1;
      if ("money" in attacker) attacker.money += 300;
    }
    return { killed: true, dealt };
  }
  function aliveOn(team) {
    const side =
      team === "attack" ? "ally" : team === "defend" ? "hostile" : team;
    return bots.filter((bot) => bot.team === side && bot.alive);
  }
  function engage(bot, target, ctx) {
    const aim = eyeOf(target.position, 1.2),
      origin = eyeOf(bot.position);
    bot.yaw = Math.atan2(origin.x - aim.x, origin.z - aim.z);
    if (
      bot.reactionLeft > 0 ||
      bot.fireCooldown > 0 ||
      bot.burstRest > 0 ||
      bot.reloadLeft > 0 ||
      bot.mag <= 0
    )
      return;
    const distance = origin.distanceTo(aim);
    const spread =
      bot.skill.spread * bot.aimScatter * (1 + (3 - bot.burstLeft) * 0.12);
    const dir = aim.sub(origin).normalize();
    for (const axis of ["x", "y", "z"])
      dir[axis] += (random() * 2 - 1) * spread;
    dir.normalize();
    origin.addScaledVector(dir, 0.55); // clear the shooter's own hit meshes
    const hit = ctx.trace(origin, dir, distance + 2);
    bot.mag -= 1;
    bot.shotsFired += 1;
    bot.fireCooldown = bot.weapon.fireGap * 1.35;
    ctx.onBotShot?.(bot, origin, dir);
    const amount = damageAtRange(bot.weapon, hit?.distance ?? distance);
    if (hit?.bot && hit.bot.team !== bot.team) {
      bot.shotsHit += 1;
      const result = damage(
        hit.bot,
        amount * (hit.part === "head" ? 2.4 : 1),
        hit.part,
        bot,
      );
      bot.damageDone += result.dealt;
    } else if (hit?.player && bot.team === "hostile") {
      bot.shotsHit += 1;
      bot.damageDone += amount;
      ctx.onBotHitPlayer?.(amount, bot);
    }
    if (--bot.burstLeft <= 0) {
      bot.burstLeft = 3;
      bot.burstRest = bot.skill.rest * (0.8 + random() * 0.4);
    }
  }
  function step(dt, ctx) {
    for (const bot of bots) {
      if (!bot.alive) {
        bot.fall = Math.min(1, bot.fall + dt / 0.4);
        bot.parts.group.rotation.x = -bot.fall * 1.45;
        bot.parts.group.position.y = bot.position.y - bot.fall * 0.1;
        continue;
      }
      bot.stateAge += dt;
      bot.radioTimer = Math.max(0, bot.radioTimer - dt);
      for (const timer of ["fireCooldown", "burstRest", "reactionLeft"])
        bot[timer] = Math.max(0, bot[timer] - dt);
      if (bot.reloadLeft > 0) {
        bot.reloadLeft = Math.max(0, bot.reloadLeft - dt);
        if (bot.reloadLeft === 0) {
          const take = Math.min(bot.weapon.mag - bot.mag, bot.reserve);
          bot.mag += take;
          bot.reserve -= take;
        }
      }
      if (bot.mag === 0 && bot.reserve > 0 && bot.reloadLeft === 0)
        bot.reloadLeft = bot.weapon.reload;
      let seen = null,
        nearest = Infinity;
      for (const enemy of ctx.enemiesOf(bot.team)) {
        const distance = bot.position.distanceToSquared(enemy.position);
        if (
          enemy.alive &&
          distance < nearest &&
          canSee(bot, eyeOf(enemy.position, 1.2))
        ) {
          seen = enemy;
          nearest = distance;
        }
      }
      if (seen) {
        if (bot.target !== seen)
          bot.reactionLeft = bot.skill.reaction * (0.85 + random() * 0.3);
        bot.target = seen;
        bot.lastSeen.copy(seen.position);
        bot.lastSeenAt = ctx.time;
      } else bot.target = null;
      const armed =
        ctx.bomb?.planted && !ctx.bomb.defused && !ctx.bomb.exploded;
      const goal = armed ? ctx.bomb.position : ctx.plantSpot(bot);
      const near = Math.hypot(bot.position.x - goal.x, bot.position.z - goal.z);
      bot.defusing = false;
      if (armed)
        bot.tactic = bot.team === "hostile" ? TACTICS.ROTATE : TACTICS.HOLD;
      else if (bot.hasBomb) bot.tactic = TACTICS.PUSH;
      else if (bot.health < 32 || (bot.money < WEAPONS.smg.cost && bot.mag < 5))
        bot.tactic = TACTICS.SAVE;
      else if (seen) bot.tactic = TACTICS.TRADE;
      else bot.tactic = bot.team === "hostile" ? TACTICS.HOLD : TACTICS.PUSH;
      if (bot.state === "Buy") transition(bot, "Advance");
      if (armed && bot.team === "hostile") transition(bot, "DefuseBomb");
      else if (bot.hasBomb && !armed && near < 1.1)
        transition(bot, "PlantBomb");
      else if (
        seen &&
        (bot.health < 30 ||
          bot.reloadLeft > 0 ||
          (bot.tactic === TACTICS.SAVE && bot.stateAge > 0.4))
      ) {
        if (bot.state !== "Retreat") {
          bot.cover = pickCover(bot);
          bot.decision = "falling back to cover";
          transition(bot, "Retreat");
        }
      } else if (seen) {
        bot.decision = "holding angle";
        transition(bot, "Engage");
      } else if (bot.state === "Retreat" && bot.stateAge < 2 && bot.cover) {
        /* reach safety */
      }
      // Defenders hold a perimeter; carriers must reach the actual plant point.
      else if (near > (bot.team === "hostile" ? 5 : 1.1) && !armed)
        transition(bot, "Advance");
      else if (!bot.cover) {
        bot.cover = pickCover(bot);
        transition(bot, "SeekCover");
      } else if (bot.state !== "SeekCover") transition(bot, "Idle");
      switch (bot.state) {
        case "Advance":
          bot.decision = bot.hasBomb
            ? "carrying objective"
            : "advancing through lane";
          // Briefly investigate the last sighting instead of tracking enemies through walls.
          navigate(
            bot,
            !bot.hasBomb && ctx.time - bot.lastSeenAt < 1.5
              ? bot.lastSeen
              : goal,
            dt,
          );
          break;
        case "SeekCover":
        case "Retreat":
          if (!bot.cover || navigate(bot, bot.cover.pos, dt)) {
            bot.decision = "resetting behind cover";
            transition(bot, "Idle");
          }
          break;
        case "Engage":
          if (seen) engage(bot, seen, ctx);
          else transition(bot, "SeekCover");
          break;
        case "DefuseBomb":
          if (near > 0.85) navigate(bot, goal, dt);
          else {
            bot.decision = "defusing C4";
            bot.defusing = true;
          }
          break;
        case "PlantBomb":
          bot.decision = "planting at site A";
          break; // main.js advances objective timers while stationary
        case "Idle":
          bot.yaw += dt * Math.sin(ctx.time + bot.stepPhase) * 0.5;
          break;
        case "Buy":
          break;
      }
      bot.parts.group.position.copy(bot.position);
      bot.parts.group.rotation.set(0, bot.yaw, 0);
    }
  }
  return {
    bots,
    hitMeshes,
    addBot,
    resetBot,
    step,
    damage,
    aliveOn,
    canSee,
    lineClear,
    pickCover,
    EYE,
    tactics: TACTICS,
    summary() {
      return bots.map((bot) => ({
        name: bot.name,
        team: bot.team,
        state: bot.state,
        tactic: bot.tactic,
        decision: bot.decision,
        alive: bot.alive,
        health: Math.max(0, bot.health),
        armor: bot.armor,
        weapon: bot.weapon.key,
        ammo: `${bot.mag}/${bot.reserve}`,
        accuracy: bot.shotsFired ? bot.shotsHit / bot.shotsFired : 0,
      }));
    },
  };
}
