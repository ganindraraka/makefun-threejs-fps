// Boot and the one loop: a fixed 60 Hz simulation feeding a render at the display's rate. It
// wires the match (rounds, economy, score), the bots, the bomb and the shooting into one game.
// ?shot=start|play|end with &seed=N sets up a deterministic frame for a capture, renders it
// twice, then freezes it and sets window.__shotReady.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { createWorld } from './world.js';
import { createInput } from './input.js';
import { createPlayer } from './player.js';
import { createWeapon, WEAPONS, ARMOR_COST, ARMOR_VALUE, damageAtRange } from './weapon.js';
import { createBots } from './bots.js';
import { createBomb, PLANT_SECONDS, DEFUSE_SECONDS, SITE_RADIUS } from './bomb.js';
import { createMatch, TEAM_ATTACK, TEAM_DEFEND, ROUND_SECONDS, FREEZE_SECONDS, BUY_SECONDS, KILL_REWARD, BOMB_PLANT_REWARD, BOMB_TEAM_PLANT_REWARD, DEFUSE_REWARD } from './match.js';
import { createHud } from './hud.js';

const FIXED_STEP = 1 / 60;
const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seed = Number.parseInt(params.get('seed') ?? '1', 10) || 1;

function mulberry32(initial) {
  let a = initial;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(seed);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.canvas);
scene.fog = new THREE.Fog(new THREE.Color(PALETTE.canvas), 26, 70);
const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 160);
scene.add(camera);

const world = createWorld(scene);
const weapon = createWeapon(camera, random);
const hud = createHud();
const player = createPlayer(world.colliders);
const input = createInput(renderer.domElement, onLockChange);
const raycaster = new THREE.Raycaster();
raycaster.far = 90;
const bots = createBots(scene, world, random);
const bomb = createBomb(scene);
bomb.siteCenter.copy(world.site.center);
const match = createMatch();
const direction = new THREE.Vector3();

// The player as a target the bots (and the ray) can see.
const playerTarget = {
  team: TEAM_ATTACK,
  get position() { return player.state.position; },
  get alive() { return player.state.health > 0; },
  kills: 0,
};

// ---- bots for each side.
bots.addBot({ name: 'Vex', team: 'hostile', index: 0 });
bots.addBot({ name: 'Nova', team: 'hostile', index: 1 });
bots.addBot({ name: 'Kilo', team: 'hostile', index: 2 });
bots.addBot({ name: 'Bishop', team: 'ally', index: 0 });
const hostileNames = { Vex: 0, Nova: 1, Kilo: 2 };
const playerBody = player.state;
playerBody.health = 100;
playerBody.armor = 0;
playerBody.alive = true;

const shootables = world.shootables.concat(bots.hitMeshes);

let elapsed = 0;
let frozen = false;
let started = false;
let accumulator = 0;
let lastTime = performance.now();
let viewKick = { pitch: 0, yaw: 0 };
let plantHold = 0;

// ---------------------------------------------------------------- helpers

// Bullet impacts: a few short-lived sparks at each wall hit, pooled so a fight never allocates.
const impacts = [];
const IMPACT_LIFE = 0.16;
const impactGeometry = new THREE.SphereGeometry(0.03, 6, 4);
const impactMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.accent), transparent: true, depthWrite: false });
for (let i = 0; i < 48; i += 1) {
  const mesh = new THREE.Mesh(impactGeometry, impactMaterial.clone());
  mesh.visible = false;
  scene.add(mesh);
  impacts.push({ mesh, life: 0 });
}

function spawnImpact(point) {
  const slot = impacts.find((s) => s.life <= 0);
  if (!slot) return;
  slot.life = IMPACT_LIFE;
  slot.mesh.position.copy(point);
  slot.mesh.visible = true;
}

function stepImpacts(dt) {
  for (const slot of impacts) {
    if (slot.life <= 0) continue;
    slot.life -= dt;
    slot.mesh.material.opacity = Math.max(0, slot.life / IMPACT_LIFE);
    const grow = 1 + (1 - slot.life / IMPACT_LIFE) * 2;
    slot.mesh.scale.setScalar(grow);
    if (slot.life <= 0) slot.mesh.visible = false;
  }
}

function clearImpacts() {
  for (const slot of impacts) { slot.life = 0; slot.mesh.visible = false; }
}

function syncCamera() {
  camera.position.set(playerBody.position.x, playerBody.position.y + playerBody.eye, playerBody.position.z);
  camera.rotation.set(playerBody.pitch + viewKick.pitch, playerBody.yaw + viewKick.yaw, 0, 'YXZ');
}

function aimAt(point) {
  const dx = point.x - playerBody.position.x;
  const dy = point.y - (playerBody.position.y + playerBody.eye);
  const dz = point.z - playerBody.position.z;
  const length = Math.hypot(dx, dy, dz) || 1;
  playerBody.yaw = Math.atan2(-dx, -dz);
  playerBody.pitch = Math.asin(Math.max(-1, Math.min(1, dy / length)));
  syncCamera();
}

// A hitscan ray from `origin` along `dir` against the world and every living bot (not the
// shooter). Returns what it hit and how far away. Shared by the player and the bots.
function trace(origin, dir, maxDist) {
  raycaster.set(origin, dir);
  raycaster.far = maxDist;
  const hits = raycaster.intersectObjects(shootables, false);
  for (const hit of hits) {
    const mesh = hit.object;
    const bot = mesh.userData.bot;
    if (bot) {
      if (!bot.alive) continue;
      return { bot, part: mesh.userData.part, distance: hit.distance, point: hit.point };
    }
    return { wall: true, distance: hit.distance, point: hit.point };
  }
  const playerHit = tracePlayer(origin, dir, maxDist);
  return playerHit;
}

// Separately test the player's capsule against the ray (the player is not a scene mesh).
function tracePlayer(origin, dir, maxDist) {
  if (!playerTarget.alive) return null;
  const p = playerBody.position;
  const eyeY = playerBody.eye;
  // a vertical capsule segment from feet+0.2 to head
  const ax = p.x, az = p.z;
  const bottom = p.y + 0.2, top = p.y + playerBody.height;
  const ox = origin.x, oy = origin.y, oz = origin.z;
  const dx = dir.x, dy = dir.y, dz = dir.z;
  // solve for the closest approach in the horizontal plane, then check height at t
  const a = dx * dx + dz * dz;
  if (a < 1e-6) return null;
  const t = ((ax - ox) * dx + (az - oz) * dz) / a;
  if (t < 0 || t > maxDist) return null;
  const cx = ox + dx * t, cz = oz + dz * t;
  const radial = Math.hypot(cx - ax, cz - az);
  if (radial > 0.4) return null;
  const cy = oy + dy * t;
  if (cy < bottom || cy > top) return null;
  const part = cy > p.y + 1.35 ? 'head' : 'torso';
  return { player: true, part, distance: t, point: new THREE.Vector3(cx, cy, cz) };
}

// Trace for the bots: a bot shot at (origin, dir) hits the world, another bot, or the player.
function botTrace(origin, dir, maxDist) {
  const hit = trace(origin, dir, maxDist);
  return hit;
}

function damagePlayer(amount) {
  if (playerBody.health <= 0) return;
  let dealt = amount;
  if (playerBody.armor > 0) {
    const toArmor = Math.min(playerBody.armor, amount * 0.5);
    playerBody.armor -= toArmor;
    dealt = amount - toArmor;
  }
  playerBody.health -= dealt;
  hud.setHealth(playerBody.health);
  hud.setArmor(playerBody.armor);
  if (playerBody.health <= 0) {
    playerBody.health = 0;
    playerBody.alive = false;
    match.state.playerDeaths += 1;
    hud.pushFeed(`<span class="h">BOT</span> eliminated <span class="a">you</span>`);
    hud.showBanner('You were eliminated — spectating', 'hostile', 4000);
    hud.setCrosshairVisible(false);
    checkRoundEnd();
  }
}

// ---------------------------------------------------------------- shooting

function playerShoot(spread) {
  if (!weapon.takeRound()) return false;
  const pellets = weapon.state.weapon.pellets ?? 1;
  let hitSomething = false;
  let killedAny = false;
  for (let i = 0; i < pellets; i += 1) {
    camera.getWorldDirection(direction);
    const s = spread * (pellets > 1 ? 1 : 1);
    direction.x += (random() * 2 - 1) * s;
    direction.y += (random() * 2 - 1) * s;
    direction.z += (random() * 2 - 1) * s;
    direction.normalize();
    const hit = trace(camera.position, direction, raycaster.far);
    if (hit && hit.bot && hit.bot.team === TEAM_DEFEND) {
      hitSomething = true;
      const head = hit.part === 'head';
      const dmg = damageAtRange(weapon.state.weapon, hit.distance) * (head ? 2.5 : 1);
      const result = bots.damage(hit.bot, dmg, hit.part, playerTarget);
      if (result.killed) { killedAny = true; onPlayerKill(hit.bot, head); }
    } else if (hit && hit.wall) {
      spawnImpact(hit.point);
    }
  }
  weapon.pullTrigger();
  // Recoil: a pitch kick that settles, plus a small view sway and a random yaw drift.
  const kick = weapon.recoilKick();
  player.recoil(kick, (random() * 2 - 1) * kick * 0.35);
  viewKick.pitch += kick * 0.5;
  hud.setAmmo(weapon.state.mag, weapon.state.reserve);
  if (hitSomething) hud.hitMarker(killedAny, shot ? 4000 : 110);
  return true;
}

function onPlayerKill(bot, head) {
  match.state.playerKills += 1;
  match.addMoney(KILL_REWARD);
  hud.setMoney(match.state.playerMoney);
  hud.pushFeed(`<span class="a">You</span> eliminated <span class="h">${bot.name}</span>${head ? ' · headshot' : ''}`);
  // The bomb drops where the carrier fell — the player can pick it up.
  if (bot.hasBomb) { bot.hasBomb = false; match.state.bombCarrier = null; dropBomb(bot.position); }
  checkRoundEnd();
}

function onBotShot(bot, origin, dir) {
  // A short tracer-free muzzle flash light would go here; kept to a nudge so screenshots stay clean.
}

function onBotHitPlayer(amount, bot) {
  damagePlayer(amount);
}

// ---------------------------------------------------------------- bomb

let droppedBomb = null;          // { position } while the C4 lies on the ground
let droppedBombMesh = null;

function dropBomb(position) {
  if (!droppedBombMesh) {
    droppedBombMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.16, 0.24),
      new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.canvas), roughness: 0.7, metalness: 0.4 }),
    );
    droppedBombMesh.castShadow = true;
    scene.add(droppedBombMesh);
  }
  droppedBomb = { position: position.clone() };
  droppedBombMesh.visible = true;
  droppedBombMesh.position.set(position.x, 0.1, position.z);
}

function playerOnSite() {
  const p = playerBody.position;
  const dx = p.x - world.site.center.x;
  const dz = p.z - world.site.center.z;
  return dx * dx + dz * dz <= SITE_RADIUS * SITE_RADIUS;
}

function stepBombObjective(dt) {
  if (match.state.phase !== 'live') return;
  const state = bomb.state;
  if (state.exploded || state.defused) return;

  if (!state.planted) {
    // Attacker bots may plant if they carry it and stand on site.
    for (const bot of bots.aliveOn(TEAM_DEFEND)) { /* noop */ }
    for (const bot of bots.aliveOn(TEAM_ATTACK)) {
      if (bot.hasBomb && onSite(bot.position)) {
        state.plantProgress += dt / PLANT_SECONDS;
        if (state.plantProgress >= 1) {
          plantBomb(bot.position, 'BOT');
          bot.hasBomb = false;
          match.addMoney(BOMB_TEAM_PLANT_REWARD);
          hud.setMoney(match.state.playerMoney);
        }
        break;
      } else if (bot.hasBomb) {
        state.plantProgress = 0;
      }
    }
    // Player plants: hold E on site while carrying the bomb.
    if (match.state.bombCarrier === 'player' && playerTarget.alive) {
      if (input.state.keys.has('KeyE') && playerOnSite()) {
        plantHold += dt;
        hud.showObjective(`Planting… <b>${Math.round(Math.min(1, plantHold / PLANT_SECONDS) * 100)}%</b>`, true);
        if (plantHold >= PLANT_SECONDS) {
          plantBomb(playerBody.position, 'You');
          match.state.bombCarrier = null;
          match.addMoney(BOMB_PLANT_REWARD + BOMB_TEAM_PLANT_REWARD);
          hud.setMoney(match.state.playerMoney);
        }
      } else {
        plantHold = 0;
      }
    }
    // The player picks up a dropped C4 by walking over it.
    if (droppedBomb && playerTarget.alive && match.state.bombCarrier == null) {
      const dx = playerBody.position.x - droppedBomb.position.x;
      const dz = playerBody.position.z - droppedBomb.position.z;
      if (dx * dx + dz * dz < 1.6) {
        droppedBomb = null;
        if (droppedBombMesh) droppedBombMesh.visible = false;
        match.state.bombCarrier = 'player';
        hud.showBanner('Bomb recovered — press E at site A to plant', 'ally', 2600);
      }
    }
  } else {
    // Defenders (bots or the player) can defuse.
    let defusing = false;
    for (const bot of bots.aliveOn(TEAM_DEFEND)) {
      if (bot.position.distanceToSquared(state.position) < 2.2) {
        bot.defusing = true;
        defusing = true;
        state.defuseProgress += dt / DEFUSE_SECONDS;
        if (state.defuseProgress >= 1) { defuseBomb(bot.name); return; }
      } else {
        bot.defusing = false;
      }
    }
    // The player is an attacker, so the player cannot defuse; the defenders' bots do.
    if (!defusing) state.defuseProgress = Math.max(0, state.defuseProgress - dt * 0.5);
  }
}

function onSite(position) {
  const dx = position.x - world.site.center.x;
  const dz = position.z - world.site.center.z;
  return dx * dx + dz * dz <= SITE_RADIUS * SITE_RADIUS;
}

function plantBomb(position, by) {
  bomb.plant(position, elapsed);
  hud.showBanner('BOMB PLANTED', 'hostile', 2500);
  hud.showObjective('Bomb armed — detonating on the timer', true);
  hud.pushFeed(`<span class="o">C4</span> planted by <span class="a">${by}</span>`);
}

function defuseBomb(by) {
  bomb.state.defused = true;
  bomb.group.visible = false;
  hud.showBanner('BOMB DEFUSED', 'ally', 2500);
  hud.pushFeed(`<span class="o">C4</span> defused by <span class="h">${by}</span>`);
  match.roundWinner(TEAM_DEFEND, `The defenders defused the bomb at site A.`);
  endRound();
}

// ---------------------------------------------------------------- round flow

function checkRoundEnd() {
  if (match.state.phase !== 'live') return;
  const attackers = playerTarget.alive ? 1 + bots.aliveOn(TEAM_ATTACK).length : bots.aliveOn(TEAM_ATTACK).length;
  const defenders = bots.aliveOn(TEAM_DEFEND).length;
  if (defenders === 0) {
    match.roundWinner(TEAM_ATTACK, 'The defenders were eliminated.');
    endRound();
  } else if (attackers === 0) {
    match.roundWinner(TEAM_DEFEND, 'The attackers were eliminated.');
    endRound();
  }
}

function endRound() {
  if (document.pointerLockElement) document.exitPointerLock();
  hud.showOverlay(match.state.matchWinner ? 'end' : 'roundEnd', {
    winner: match.state.lastRound.winner === TEAM_ATTACK ? 'attack' : 'defend',
    reason: describeLastRound(),
    attackerScore: match.state.attackerScore,
    defenderScore: match.state.defenderScore,
  });
}

function describeLastRound() {
  const r = match.state.lastRound;
  if (!r) return '';
  const won = r.winner === match.state.playerTeam;
  const score = `${match.state.attackerScore} – ${match.state.defenderScore}`.replace(' – ', ' : ');
  return `${r.reason} ${won ? 'Your side takes the round.' : 'Your side loses the round.'} Series ${match.state.attackerScore}–${match.state.defenderScore}.`;
}

function resetRound() {
  match.startRound();
  playerBody.health = 100;
  playerBody.alive = true;
  playerBody.armor = match.state.savedArmor ?? playerBody.armor;
  playerBody.position.copy(world.attackerSpawns[0]);
  playerBody.velocity.set(0, 0, 0);
  playerBody.pitch = 0;
  playerBody.yaw = Math.PI; // face north, toward the site
  viewKick = { pitch: 0, yaw: 0 };
  plantHold = 0;
  bomb.reset();
  droppedBomb = null;
  if (droppedBombMesh) droppedBombMesh.visible = false;
  clearImpacts();
  match.state.bombCarrier = 'player';
  let hi = 0;
  for (const bot of bots.bots) {
    const idx = bot.team === 'hostile' ? hostileNames[bot.name] ?? 0 : hi++;
    bots.resetBot(bot, idx);
    bot.hasBomb = false;
    bot.defusing = false;
  }
  weapon.refill();
  hud.setAmmo(weapon.state.mag, weapon.state.reserve);
  hud.setHealth(playerBody.health);
  hud.setArmor(playerBody.armor);
  hud.hideBanner();
  hud.showObjective('Bomb site <b>A</b> — plant the <b>C4</b>', true);
  hud.setCrosshairVisible(true);
  syncCamera();
}

function beginLive() {
  match.state.phase = 'live';
  match.state.phaseTimer = 0;
  hud.hideOverlay();
  hud.hideBanner();
  hud.showBanner('Round ' + match.state.round + ' — GO', 'ally', 1400);
}

// ---------------------------------------------------------------- buy

function handleBuy(row) {
  const money = match.state.playerMoney;
  if (row.kind === 'armor') {
    if (money < ARMOR_COST || playerBody.armor > 0) return;
    match.addMoney(-ARMOR_COST);
    playerBody.armor = ARMOR_VALUE;
    hud.setArmor(playerBody.armor);
  } else {
    const w = WEAPONS[row.key];
    if (money < w.cost) return;
    match.addMoney(-w.cost);
    weapon.equip(row.key);
    hud.setWeapon(w.name);
  }
  hud.setMoney(match.state.playerMoney);
  hud.renderBuy(match.state.playerMoney, weapon.state.weapon.key, playerBody.armor > 0);
}

// ---------------------------------------------------------------- input wiring

hud.onBuy(handleBuy);

hud.onPlay(() => {
  if (shot) return;
  if (match.state.phase === 'matchEnd') { restartMatch(); return; }
  if (match.state.phase === 'roundEnd') { nextRound(); return; }
  // start / buy / paused: close the menu and (re)enter the round.
  if (match.state.phase === 'freeze' || match.state.phase === 'buy') { beginLive(); return; }
  input.requestLock();
});

function nextRound() {
  hud.hideOverlay();
  match.nextRound();
  resetRound();
  input.requestLock();
}

function restartMatch() {
  hud.hideOverlay();
  match.resetMatch();
  resetRound();
  playerBody.armor = 0;
  hud.setArmor(0);
  weapon.equip('rifle');
  hud.setWeapon(WEAPONS.rifle.name);
  input.requestLock();
}

function onLockChange(locked) {
  if (shot) return;
  if (locked) {
    started = true;
    hud.hideOverlay();
  } else if (match.state.phase === 'live' || match.state.phase === 'freeze') {
    hud.showOverlay('paused', {
      money: match.state.playerMoney,
      weapon: weapon.state.weapon.key,
      armor: playerBody.armor > 0,
      attackerScore: match.state.attackerScore,
      defenderScore: match.state.defenderScore,
    });
  }
}

// The player presses Tab to hold the scoreboard open.
input.addKeyPress?.('Tab', () => showTabBoard());
input.addKeyRelease?.('Tab', () => hud.hideTabBoard());

function showTabBoard() {
  if (shot) return;
  const players = [
    { name: 'You', team: 'ally', alive: playerTarget.alive, health: playerBody.health },
    ...bots.bots.map((b) => ({ name: b.name, team: b.team, alive: b.alive, health: b.health })),
  ];
  hud.showTabBoard({ attackerScore: match.state.attackerScore, defenderScore: match.state.defenderScore, players });
}

// The player presses B to open the buy menu at any time before the fight settles.
input.addKeyPress?.('KeyB', () => {
  if (shot) return;
  if (match.state.phase === 'freeze' || match.state.phase === 'buy' || match.state.phase === 'live') {
    hud.showOverlay('buy', {
      money: match.state.playerMoney,
      weapon: weapon.state.weapon.key,
      armor: playerBody.armor > 0,
      round: match.state.round,
      attackerScore: match.state.attackerScore,
      defenderScore: match.state.defenderScore,
    });
    if (document.pointerLockElement) document.exitPointerLock();
  }
});

// ---------------------------------------------------------------- the step

function step(dt) {
  elapsed += dt;
  match.state.phaseTimer += dt;
  const phase = match.state.phase;

  if (phase === 'freeze') {
    if (match.state.phaseTimer >= FREEZE_SECONDS) {
      match.state.phase = 'live';
      match.state.phaseTimer = 0;
    }
  }

  if (phase === 'live' || phase === 'freeze') {
    player.step(dt, input.state.keys);
    weapon.step(dt);
    if (phase === 'live') {
      const ctx = {
        time: elapsed,
        random,
        bomb: bomb.state,
        plantSpot: () => world.site.center,
        enemiesOf: (team) => {
          // A defender's enemies are the attackers (the player plus the ally bots); an
          // attacker's enemies are the defenders. `team` is a bot's own team.
          if (team === 'hostile' || team === TEAM_DEFEND) {
            return playerTarget.alive ? [playerTarget, ...bots.aliveOn('ally')] : bots.aliveOn('ally');
          }
          return bots.aliveOn('hostile');
        },
        trace: botTrace,
        onBotShot,
        onBotHitPlayer,
      };
      bots.step(dt, ctx);
      stepBombObjective(dt);
      bomb.step(dt, elapsed);
      checkTimers();
      checkRoundEnd();
    } else {
      // Freeze: still animate bots standing at spawn.
      bots.step(dt, { time: elapsed, random, bomb: bomb.state, plantSpot: () => world.site.center, enemiesOf: () => [], trace: () => null, onBotShot, onBotHitPlayer });
    }
  }

  // view kick settles
  viewKick.pitch += (0 - viewKick.pitch) * Math.min(1, dt * 8);
  viewKick.yaw += (0 - viewKick.yaw) * Math.min(1, dt * 8);
  stepImpacts(dt);

  // player relocks firing only when alive
  if (playerTarget.alive && input.state.firing && weapon.ready() && phase === 'live') {
    playerShoot(shot ? 0 : weapon.spread(player.groundSpeed()));
  }
  if (input.state.keys.has('KeyR')) weapon.reload();

  updateHud();
}

function checkTimers() {
  const timeLeft = ROUND_SECONDS - match.state.phaseTimer;
  if (timeLeft <= 0) {
    // Time out: if the bomb is planted, it still runs; else defenders win.
    if (!bomb.state.planted) {
      match.roundWinner(TEAM_DEFEND, 'Time ran out before the bomb was planted.');
      endRound();
    }
  }
  if (bomb.state.exploded) {
    match.roundWinner(TEAM_ATTACK, 'The C4 detonated at site A.');
    endRound();
  }
}

function updateHud() {
  const phase = match.state.phase;
  hud.setAmmo(weapon.state.mag, weapon.state.reserve);
  hud.setMoney(match.state.playerMoney);
  let secs;
  if (bomb.state.planted && !bomb.state.defused && !bomb.state.exploded) secs = bomb.state.fuse;
  else if (phase === 'freeze') secs = FREEZE_SECONDS - match.state.phaseTimer;
  else secs = ROUND_SECONDS - match.state.phaseTimer;
  hud.setRound(match.state.attackerScore, match.state.defenderScore, match.state.round, Math.max(0, secs));
  if (bomb.state.planted && !bomb.state.defused && !bomb.state.exploded) {
    hud.showObjective(`<b>C4</b> armed — ${Math.ceil(bomb.state.fuse)}s`, true);
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  if (!frozen) {
    const look = input.takeLook();
    player.look(look.x, look.y);
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_STEP && steps < 5) {
      step(FIXED_STEP);
      accumulator -= FIXED_STEP;
      steps += 1;
    }
    if (accumulator > FIXED_STEP * 5) accumulator = 0;
    syncCamera();
  }
  renderer.render(scene, camera);
}

function settle(steps) {
  for (let index = 0; index < steps; index += 1) step(FIXED_STEP);
}

// ---------------------------------------------------------------- deterministic shots

function runShot(name) {
  hud.setCrosshairVisible(name !== 'start');
  playerBody.pitch = 0;
  if (name === 'start') {
    resetRound();
    match.state.attackerScore = 3;
    match.state.defenderScore = 2;
    match.state.round = 6;
    match.state.playerMoney = 6400;
    playerBody.armor = ARMOR_VALUE;
    weapon.equip('rifle');
    hud.setWeapon(WEAPONS.rifle.name);
    hud.setArmor(playerBody.armor);
    playerBody.position.copy(world.attackerSpawns[0]);
    playerBody.yaw = Math.PI;
    aimAt(new THREE.Vector3(world.site.center.x, 1.2, world.site.center.z));
    playerBody.position.set(-6, 0, 9);
    syncCamera();
    settle(4);
    hud.showOverlay('start', { money: match.state.playerMoney, weapon: 'rifle', armor: true, attackerScore: 3, defenderScore: 2 });
    hud.hideBanner();
    hud.showObjective('Bomb site <b>A</b> — plant the <b>C4</b>', true);
    paintTwiceThenReady();
    return;
  }

  // play and end both start a live round, place the player and the bots, and fight.
  resetRound();
  match.state.phase = 'live';
  match.state.phaseTimer = name === 'play' ? 22 : 108;
  hud.setCrosshairVisible(true);
  hud.hideOverlay();
  hud.hideBanner();

  // Hand the bomb to an attacker bot so a plant can be shown, and push the bots into the site.
  const carrier = bots.bots.find((b) => b.team === 'ally');
  if (carrier) { carrier.hasBomb = true; match.state.bombCarrier = carrier.name; }

  if (name === 'play') {
    // Mid-round, mid-fight: the player pushed up the west lane toward site A, one defender
    // trading fire in front, the ally bot beside, the bomb planted on the site behind them.
    playerBody.position.set(-6.5, 0, -3.0);
    playerBody.yaw = Math.PI;
    settle(8);
    positionBotsForShot('play');
    aimAt(new THREE.Vector3(world.site.center.x + 0.4, 1.15, world.site.center.z + 1.0));
    for (let i = 0; i < 7; i += 1) { playerShoot(0); settle(3); }
    positionBotsForShot('play');
    // the C4 is armed on the site, its ring glowing behind the fight
    bomb.plant(new THREE.Vector3(world.site.center.x + 1.0, 0, world.site.center.z - 0.5), elapsed - 6);
    bomb.state.planted = true;
    // aim slightly past the nearest defender so it sits at the centre of the frame
    const lead = bots.bots.find((b) => b.team === 'hostile' && b.alive) ?? { position: world.site.center };
    aimAt(new THREE.Vector3(lead.position.x - 0.1, 1.2, lead.position.z - 1.5));
    settle(2);
    hud.showBanner('ROUND ' + match.state.round + ' — 1:42', 'ally');
  } else {
    // end: the round has resolved — the bomb detonated, defenders down, the series flipped.
    playerBody.position.set(-6.0, 0, -5.0);
    playerBody.yaw = Math.PI * 0.9;
    positionBotsForShot('end');
    aimAt(new THREE.Vector3(world.site.center.x, 1.0, world.site.center.z));
    const defenders = bots.bots.filter((b) => b.team === 'hostile');
    if (defenders[0]) bots.damage(defenders[0], 200, 'torso', playerTarget);
    if (defenders[2]) bots.damage(defenders[2], 200, 'head', playerTarget);
    for (const d of defenders) { if (!d.alive) { d.fall = 1; d.parts.group.rotation.x = -1.45; d.parts.group.position.set(d.position.x, -0.1, d.position.z); } }
    match.state.attackerScore = 5;
    match.state.defenderScore = 2;
    match.state.round = 8;
    match.state.playerMoney = 8150;
    match.state.playerKills = 7;
    hud.pushFeed(`<span class="a">You</span> eliminated <span class="h">Vex</span> · headshot`);
    hud.pushFeed(`<span class="o">C4</span> armed at site A`);
    settle(2);
    hud.showOverlay('end', { winner: 'attack', reason: 'The defenders were eliminated. Your side takes the round. Series 5–2.', attackerScore: 5, defenderScore: 2 });
    hud.hideBanner();
    hud.showObjective('<b>C4</b> armed — 12s', true);
  }
  updateHud();
  syncCamera();
  paintTwiceThenReady();
}

function positionBotsForShot(which) {
  const c = world.site.center;
  const hosts = bots.bots.filter((b) => b.team === 'hostile');
  const allies = bots.bots.filter((b) => b.team === 'ally');
  // The player stands around (-6.5, -3) facing north (-z). These spots put the bots in the
  // lane ahead, 4–10 m out, spread across the view so the frame reads as a firefight.
  if (which === 'play') {
    if (hosts[0]) placeBot(hosts[0], -5.0, -6.4, Math.PI);
    if (hosts[1]) placeBot(hosts[1], -9.4, -9.0, Math.atan2(1, -1) + Math.PI);
    if (hosts[2]) placeBot(hosts[2], -7.2, -12.5, Math.PI);
    if (allies[0]) placeBot(allies[0], -4.4, -9.0, Math.PI);
  } else {
    // The player stands around (-6, -5) facing the site; one defender stands, the rest are down.
    if (hosts[1]) placeBot(hosts[1], -7.5, -10.0, Math.PI * 0.85);
    if (hosts[0]) placeBot(hosts[0], -4.6, -8.4, Math.PI);
    if (hosts[2]) placeBot(hosts[2], -9.6, -12.5, Math.PI);
    if (allies[0]) placeBot(allies[0], -9.0, -7.5, Math.PI);
  }
}

function placeBot(bot, x, z, yaw) {
  bot.position.set(x, 0, z);
  bot.yaw = yaw;
  bot.parts.group.position.set(x, 0, z);
  bot.parts.group.rotation.y = yaw;
}

function paintTwiceThenReady() {
  let painted = 0;
  function paint() {
    requestAnimationFrame(paint);
    syncCamera();
    renderer.render(scene, camera);
    painted += 1;
    if (painted === 2) {
      window.__shotReady = true;
      frozen = true;
    }
  }
  requestAnimationFrame(paint);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// A small debug surface for the deterministic shots (read by the capture harness).
window.__dbg = { bots: bots.bots, player: playerBody, bomb, match, weapon, world, camera, input, hud, get elapsed() { return elapsed; } };

// ---------------------------------------------------------------- boot

resetRound();
match.state.phase = 'buy';
if (match.state.phase === 'buy') match.state.phaseTimer = 0;
hud.setHealth(playerBody.health);
hud.setArmor(playerBody.armor);
hud.setMoney(match.state.playerMoney);
hud.setWeapon(WEAPONS.rifle.name);
hud.setCrosshairVisible(true);
hud.showObjective('Bomb site <b>A</b> — plant the <b>C4</b>', true);
hud.showOverlay('start', { money: match.state.playerMoney, weapon: 'rifle', armor: false, attackerScore: 0, defenderScore: 0 });

syncCamera();
if (shot) runShot(shot);
else requestAnimationFrame(frame);
