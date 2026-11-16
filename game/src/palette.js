/** Shared scene colors, aligned with the HTML theme tokens.
 * Neutral surfaces keep team and objective accents legible during a firefight.
 */
export const PALETTE = {
  canvas: "#14161a",
  surface: "#1e2228",
  hairline: "#2c323a",
  ink: "#e9e6df",
  muted: "#98a0a8",
  accent: "#f0a830",
  // Team hues: the player's side is cool, the enemy's side is warm, the objective is orange.
  ally: "#4fb3d9",
  hostile: "#d9554f",
  objective: "#e07b39",
};

export function shade(name) {
  return PALETTE[name];
}
