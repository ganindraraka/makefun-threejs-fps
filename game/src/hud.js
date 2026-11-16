// The DOM HUD: crosshair, hit marker, ammo, health/armour/money, the round topbar, the banner
// and objective line, the kill feed, the buy menu and the scoreboard. It never touches the
// simulation; main.js pushes numbers and a buy callback in and reads the play callback out.
import { WEAPONS, ARMOR_COST } from "./weapon.js";

// HUD contract: simulation code pushes state in small, idempotent updates. DOM writes
// are cached through `set()` so a 60 Hz loop does not recreate text nodes every frame.
// Transient effects (hit markers, banners and feed lines) own their timers here; the
// match loop only describes what happened and never needs to know how long it should
// remain visible.

export function createHud() {
  const get = (id) => document.getElementById(id);
  const overlay = get("overlay");
  const title = get("overlay-title");
  const copy = get("overlay-copy");
  const play = get("play");
  const scoreboard = get("scoreboard");
  const buyMoney = get("buy-money");
  const buyList = get("buy-list");
  const buy = get("buy");
  const crosshair = get("crosshair");
  const ammo = get("ammo");
  const ammoMag = get("ammo-mag");
  const ammoReserve = get("ammo-reserve");
  const weaponName = get("weapon-name");
  const health = get("health");
  const healthValue = get("health-value");
  const armor = get("armor");
  const armorValue = get("armor-value");
  const moneyValue = get("money-value");
  const banner = get("banner");
  const objectiveHud = get("objective-hud");
  const feed = get("feed");
  const clockValue = get("clock-value");
  const clockRound = get("clock-round");
  const clock = get("round-clock");
  const scoreAttack = get("score-attack");
  const scoreDefend = get("score-defend");
  const hitmarker = get("hitmarker");
  const tabBoard = get("tab-board");
  const tabAttack = get("tab-attack");
  const tabDefend = get("tab-defend");
  const tabPlayers = get("tab-players");

  let hitTimer = 0;
  let bannerTimer = 0;
  const last = {};
  const set = (key, node, text) => {
    if (last[key] !== text) {
      last[key] = text;
      node.textContent = text;
    }
  };

  let onBuy = null;
  let currentMoney = 0;
  let owned = "rifle";
  let objectiveState = "";

  function renderBuy(money, currentWeapon, hasArmor) {
    currentMoney = money;
    owned = currentWeapon;
    buyMoney.textContent = `$${money} available`;
    const rows = [];
    for (const key of Object.keys(WEAPONS)) {
      const w = WEAPONS[key];
      const isOwned = key === currentWeapon;
      const canAfford = money >= w.cost;
      rows.push({
        key,
        name: w.name,
        stat:
          w === WEAPONS.shotgun
            ? `${w.pellets} pellet · $${w.cost}`
            : `${Math.round(60 / w.fireGap)} rpm · ${w.mag}rd · $${w.cost}`,
        cost: w.cost,
        disabled: isOwned || !canAfford,
        owned: isOwned,
        kind: "weapon",
      });
    }
    rows.push({
      key: "armor",
      name: "Kevlar Vest",
      stat: hasArmor ? "worn" : `+100 armour · $${ARMOR_COST}`,
      cost: ARMOR_COST,
      disabled: hasArmor || money < ARMOR_COST,
      owned: hasArmor,
      kind: "armor",
    });
    buyList.replaceChildren(
      ...rows.map((row) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `buy-item${row.owned ? " owned" : ""}`;
        button.disabled = row.disabled;
        button.innerHTML = `<span class="nm">${row.name}</span><span class="st">${row.stat}</span><span class="pr">${row.owned ? "OWNED" : `$${row.cost}`}</span>`;
        button.addEventListener("click", () => {
          if (onBuy) onBuy(row);
          row.disabled = true;
        });
        return button;
      }),
    );
  }

  return {
    setAmmo(mag, reserve) {
      if (last.mag !== mag || last.reserve !== reserve) {
        last.mag = mag;
        last.reserve = reserve;
        ammoMag.textContent = String(mag);
        ammoReserve.textContent = `/ ${reserve}`;
        ammo.classList.toggle("empty", mag === 0);
      }
    },
    setWeapon(name) {
      set("weapon", weaponName, name);
    },
    setHealth(hp, cap) {
      hp = Math.max(0, Math.round(hp));
      set("hp", healthValue, String(hp));
      health.classList.toggle("low", hp <= 25);
    },
    setArmor(value) {
      set("armor", armorValue, String(Math.max(0, Math.round(value))));
      armor.classList.toggle("none", value <= 0);
    },
    setMoney(value) {
      set("money", moneyValue, String(Math.round(value)));
    },
    setRound(attackerScore, defenderScore, round, seconds) {
      set("sa", scoreAttack, String(attackerScore));
      set("sd", scoreDefend, String(defenderScore));
      set("round", clockRound, `Round ${round}`);
      const s = Math.max(0, Math.ceil(seconds));
      set(
        "clock",
        clockValue,
        `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`,
      );
      clock.classList.toggle("urgent", seconds <= 10);
    },
    hitMarker(killed, holdMs = 90) {
      hitmarker.classList.add("on");
      hitmarker.classList.toggle("kill", !!killed);
      hitmarker.style.transform = killed
        ? "translate(-50%, -50%) rotate(45deg) scale(1.3)"
        : "";
      clearTimeout(hitTimer);
      hitTimer = setTimeout(() => {
        hitmarker.classList.remove("on");
        hitmarker.style.transform = "";
      }, holdMs);
    },
    showBanner(text, tone = "", holdMs = 0) {
      banner.textContent = text;
      banner.className = `on${tone ? ` ${tone}` : ""}`;
      clearTimeout(bannerTimer);
      if (holdMs > 0)
        bannerTimer = setTimeout(() => banner.classList.remove("on"), holdMs);
    },
    hideBanner() {
      banner.classList.remove("on");
    },
    showObjective(text, on) {
      objectiveHud.innerHTML = text;
      objectiveHud.classList.toggle("on", !!on);
      objectiveState = on ? text : "";
    },
    setObjectivePrompt({ text = "", tone = "", progress = null } = {}) {
      if (!text) {
        objectiveHud.classList.remove("on");
        objectiveState = "";
        return;
      }
      const bar =
        progress == null
          ? ""
          : `<span class="objective-progress"><i style="width:${Math.max(0, Math.min(100, progress * 100))}%"></i></span>`;
      objectiveHud.innerHTML = `<strong class="${tone}">${text}</strong>${bar}`;
      objectiveHud.classList.add("on");
      objectiveState = text;
    },
    get objectiveState() {
      return objectiveState;
    },
    setReloadProgress(progress) {
      ammo.classList.toggle("reloading", progress >= 0 && progress < 1);
      ammo.style.setProperty(
        "--reload-progress",
        `${Math.max(0, Math.min(1, progress))}`,
      );
    },
    setDamageFeedback(amount, killed = false) {
      if (amount > 0) {
        hitmarker.dataset.damage = String(Math.round(amount));
        hitmarker.classList.add("damage");
        if (killed) hitmarker.classList.add("kill");
        setTimeout(() => hitmarker.classList.remove("damage"), 120);
      }
    },
    pushFeed(html, holdMs = 4200) {
      const line = document.createElement("div");
      line.className = "feed-line";
      line.innerHTML = html;
      feed.appendChild(line);
      setTimeout(() => line.remove(), holdMs);
      while (feed.children.length > 5) feed.firstChild.remove();
    },
    setCrosshairVisible(visible) {
      crosshair.classList.toggle("hidden", !visible);
    },
    showTabBoard(data) {
      tabAttack.textContent = String(data.attackerScore);
      tabDefend.textContent = String(data.defenderScore);
      tabPlayers.replaceChildren(
        ...data.players.map((p) => {
          const row = document.createElement("div");
          row.className = `p${p.alive ? "" : " dead"}`;
          row.innerHTML = `<span class="${p.team === "ally" ? "a" : "h"}">${p.name}</span><span>${p.alive ? `${Math.max(0, Math.round(p.health))} HP` : "ELIMINATED"}</span>`;
          return row;
        }),
      );
      tabBoard.classList.add("on");
    },
    hideTabBoard() {
      tabBoard.classList.remove("on");
    },
    get tabBoardVisible() {
      return tabBoard.classList.contains("on");
    },
    renderBuy,
    showOverlay(mode, data = {}) {
      const hasBuy = mode === "start" || mode === "buy" || mode === "paused";
      buy.hidden = !hasBuy;
      if (hasBuy)
        renderBuy(
          data.money ?? currentMoney,
          data.weapon ?? owned,
          data.armor ?? false,
        );
      scoreboard.hidden = mode !== "start" && mode !== "buy";
      if (mode === "start" || mode === "buy") {
        scoreboard.replaceChildren(
          scoreRow("Attack", data.attackerScore ?? 0, "attack"),
          scoreRow("Defend", data.defenderScore ?? 0, "defend"),
        );
      }
      if (mode === "start") {
        title.innerHTML = "FOUNDRY";
        copy.innerHTML =
          "Best of 9. As the attacking side, plant the <b>C4</b> at site A or eliminate the defenders. Buy, then click to play.";
        play.textContent = "Click to play";
      } else if (mode === "buy") {
        title.innerHTML = "Buy phase";
        copy.textContent = `Round ${data.round ?? 1}. Spend your money — the fight starts when you close the menu.`;
        play.textContent = "Start round";
      } else if (mode === "paused") {
        title.innerHTML = "Paused";
        copy.textContent = "Click to resume, or press B to buy.";
        play.textContent = "Click to resume";
      } else if (mode === "roundEnd") {
        title.innerHTML = data.winner === "attack" ? "Round won" : "Round lost";
        copy.textContent = data.reason ?? "";
        play.textContent = "Next round";
      } else if (mode === "end") {
        title.innerHTML = data.winner === "attack" ? "Match won" : "Match lost";
        copy.textContent = data.reason ?? "";
        play.textContent = "Play again";
      }
      overlay.hidden = false;
      play.focus();
    },
    hideOverlay() {
      overlay.hidden = true;
    },
    onPlay(handler) {
      play.addEventListener("click", handler);
    },
    onBuy(handler) {
      onBuy = handler;
    },
    get buyVisible() {
      return !overlay.hidden && !buy.hidden;
    },
  };
}

function scoreRow(side, score, cls) {
  const li = document.createElement("li");
  li.className = cls;
  li.innerHTML = `<span class="side">${side}</span><span class="score">${score}</span>`;
  return li;
}
