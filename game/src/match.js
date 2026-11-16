// The match: best-of-N rounds between two sides, the round clock, the win conditions and the
// money. It owns no rendering: it counts kills and round outcomes and hands out money, and
// main.js reads its state to reset positions, show the scoreboard and open the buy menu.
export const ROUND_SECONDS = 115;
export const FREEZE_SECONDS = 5;
export const BUY_SECONDS = 20; // how long the buy window stays open at round start
export const START_MONEY = 800;
export const MAX_MONEY = 16000;
export const KILL_REWARD = 300;
export const WIN_REWARD = 3250;
export const LOSS_BONUS = [1400, 2100, 2900, 3400]; // grows with a losing streak, capped
export const BOMB_PLANT_REWARD = 300;
export const BOMB_TEAM_PLANT_REWARD = 800;
export const DEFUSE_REWARD = 300;

export const ROUNDS_TO_WIN = 5; // first to 5, best of 9

// 1 (attackers, +z spawn) carries the bomb; 2 (defenders, -z) holds the site.
export const TEAM_ATTACK = "attack";
export const TEAM_DEFEND = "defend";

export function createMatch() {
  const state = {
    phase: "freeze", // freeze | live | roundEnd | matchEnd
    phaseTimer: 0,
    round: 1,
    attackerScore: 0,
    defenderScore: 0,
    playerMoney: START_MONEY,
    playerTeam: TEAM_ATTACK,
    lossStreak: { [TEAM_ATTACK]: 0, [TEAM_DEFEND]: 0 },
    lastRound: null, // { winner, reason }
    matchWinner: null,
    bombCarrier: "player", // 'player' or a bot name
    moneyEarned: 0,
    playerKills: 0,
    playerDeaths: 0,
  };

  function startRound() {
    state.phase = "freeze";
    state.phaseTimer = 0;
    state.bombCarrier = "player";
  }

  function addMoney(amount) {
    state.playerMoney = Math.max(
      0,
      Math.min(MAX_MONEY, state.playerMoney + amount),
    );
    if (amount > 0) state.moneyEarned += amount;
  }

  function roundWinner(winner, reason) {
    // Multiple win conditions may become true on the same simulation frame.
    // Resolve the round once so scores and economy remain transactional.
    if (state.phase === "roundEnd" || state.phase === "matchEnd") return;
    state.phase = "roundEnd";
    state.phaseTimer = 0;
    state.lastRound = { winner, reason, round: state.round };
    const loser = winner === TEAM_ATTACK ? TEAM_DEFEND : TEAM_ATTACK;
    if (winner === TEAM_ATTACK) state.attackerScore += 1;
    else state.defenderScore += 1;
    state.lossStreak[loser] = Math.min(
      state.lossStreak[loser] + 1,
      LOSS_BONUS.length - 1,
    );
    state.lossStreak[winner] = 0;
    // money to the player, by its own side's outcome
    if (state.playerTeam === winner) addMoney(WIN_REWARD);
    else addMoney(LOSS_BONUS[state.lossStreak[state.playerTeam]]);
    if (
      state.attackerScore >= ROUNDS_TO_WIN ||
      state.defenderScore >= ROUNDS_TO_WIN
    ) {
      state.matchWinner =
        state.attackerScore > state.defenderScore ? TEAM_ATTACK : TEAM_DEFEND;
    }
  }

  function nextRound() {
    if (state.matchWinner) {
      state.phase = "matchEnd";
      return;
    }
    state.round += 1;
    startRound();
  }

  return {
    state,
    addMoney,
    roundWinner,
    nextRound,
    startRound,
    resetMatch() {
      state.phase = "freeze";
      state.phaseTimer = 0;
      state.round = 1;
      state.attackerScore = 0;
      state.defenderScore = 0;
      state.playerMoney = START_MONEY;
      state.lossStreak = { [TEAM_ATTACK]: 0, [TEAM_DEFEND]: 0 };
      state.lastRound = null;
      state.matchWinner = null;
      state.bombCarrier = "player";
      state.moneyEarned = 0;
      state.playerKills = 0;
      state.playerDeaths = 0;
    },
  };
}
