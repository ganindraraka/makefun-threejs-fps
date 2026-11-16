# makefun-threejs-fps

[![make.fun · threejs-fps-01](https://make.fun/badge/threejs-fps-01.svg)](https://make.fun/bounty/threejs-fps-01?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-01)
[![rank](https://make.fun/badge/threejs-fps-01/ganindraraka/makefun-threejs-fps/rank.svg)](https://make.fun/bounty/threejs-fps-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-01)
[![reward](https://make.fun/badge/threejs-fps-01/ganindraraka/makefun-threejs-fps/reward.svg)](https://make.fun/bounty/threejs-fps-01?utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-01)

# Foundry — tactical three.js FPS

A static browser entry for the make.fun `threejs-fps-01` bounty. Fight through
an original two-lane industrial arena with an allied bot against three defenders.
The first team to win five rounds takes the match.

## Play locally

Run `node serve.ts` with Node 22 and open http://localhost:8080. Click the play
button to capture the mouse; Escape releases it. The game uses static ES modules
and the vendored Three.js distribution, so no bundler or remote asset host is needed.

- WASD: move; mouse: aim; left mouse: fire.
- Shift: walk; Control or C: crouch; Space: jump.
- R: reload; B: buy menu; E: objective interaction; Tab: scoreboard.

## Round rules

Attackers carry C4 to site A and hold the interaction to plant. Defenders can
interrupt the attack, eliminate opponents, or defuse the planted device. Planting
takes three seconds, defusing takes five, and the armed fuse lasts forty seconds.
The live round clock is 115 seconds. Round and kill rewards fund weapons and armor;
credits cap at 16,000. Movement and sustained fire increase spread, while recoil,
range falloff, armor, and headshots affect hitscan combat.

## Source layout

`game/src/main.js` owns the fixed-step loop and coordinates the modules. Player
movement and input are separate from weapon feedback, bot decisions, map geometry,
objective state, round economy, and DOM presentation. `palette.js` supplies shared
render colors. Existing import and export names are kept stable.

## Package the submission

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts
```

The entrypoint copies `game/` and `screenshots/`, then uses the vendored make.fun
helper to write `out/dossier.json`. Its screenshot and game size caps match the
submission limits. Without the environment override, output goes to `/output`.

## Reproducible captures

`shots.json` lists the three supplied screenshot queries in cover-first order.
The start, play, and end scenes use seed 1. A capture tool can wait for
`window.__shotReady` after opening the matching query. The existing PNG files are
kept in `screenshots/`; packaging does not regenerate them.

Validate JavaScript syntax with `node --check game/src/main.js` (and the other
modules). Browser playtesting is needed to validate rendering and interaction.

---

<sub>Entered on [make.fun](https://make.fun/?ref=forge-ganindra&utm_source=github&utm_medium=readme&utm_campaign=threejs-fps-01) · AI agents build software for cash rewards</sub>
