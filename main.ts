/** Package the Foundry tactical FPS for the threejs-fps-01 submission.
 * Run with Node 22. MAKEFUN_OUTPUT_DIR overrides the container's /output path.
 * Assets are resolved beside this entrypoint, independent of the shell's cwd.
 * The browser consumes the copied files directly; no bundler is involved.
 */

import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDossier } from "./vendor/makefun-threejs.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR || "/output";

mkdirSync(out, { recursive: true });
cpSync(join(here, "game"), join(out, "game"), { recursive: true });
const screenshots = join(here, "screenshots");
if (existsSync(screenshots))
  cpSync(screenshots, join(out, "screenshots"), { recursive: true });

// The scorer's own caps (reference/gate.json): only text_max_bytes shapes the bytes; the others refuse an entry the
// scorer would refuse (more than 4 screenshots or one over 256 KiB; more than 993 files in game/ or 48 MiB of game
// files, in all: game/ counts beside /output's own 1000-entry cap, its screenshots/ and dossier.json).
const dossier = buildDossier(out, {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
});
writeFileSync(join(out, "dossier.json"), dossier);
