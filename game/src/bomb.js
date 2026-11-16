// The bomb: one objective, one site. Once planted it runs a fuse; the attackers win when it
// goes off, the defenders win by defusing it. The module owns only the state and the numbers;
// main.js decides who plants and defuses and draws the device.
import * as THREE from "three";
import { PALETTE } from "./palette.js";

export const PLANT_SECONDS = 3.0;
export const DEFUSE_SECONDS = 5.0;
export const FUSE_SECONDS = 40.0;
export const SITE_RADIUS = 4.2;

export function createBomb(scene) {
  const group = new THREE.Group();
  const shellMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(PALETTE.canvas),
    roughness: 0.7,
    metalness: 0.4,
  });
  const lampMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(PALETTE.hostile),
    emissive: new THREE.Color(PALETTE.hostile),
    emissiveIntensity: 1.2,
    roughness: 0.4,
  });

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.16, 0.24),
    shellMat,
  );
  body.castShadow = true;
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), lampMat);
  lamp.position.set(0.12, 0.1, 0);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.22, 0.3, 24),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(PALETTE.objective),
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.03;
  group.add(body, lamp, ring);
  group.visible = false;
  scene.add(group);

  const state = {
    planted: false,
    plantedAt: 0,
    fuse: FUSE_SECONDS,
    exploded: false,
    defused: false,
    position: new THREE.Vector3(),
    carrier: null, // 'player' | bot | null
    plantProgress: 0,
    defuseProgress: 0,
    beepTimer: 0,
  };

  function reset() {
    state.planted = false;
    state.plantedAt = 0;
    state.fuse = FUSE_SECONDS;
    state.exploded = false;
    state.defused = false;
    state.carrier = null;
    state.plantProgress = 0;
    state.defuseProgress = 0;
    state.beepTimer = 0;
    group.visible = false;
    lampMat.emissiveIntensity = 1.2;
  }

  function plant(at, time) {
    // A second interaction must not extend an active fuse.
    if (state.planted || state.exploded || state.defused) return;
    state.planted = true;
    state.plantedAt = time;
    state.position.copy(at);
    state.fuse = FUSE_SECONDS;
    state.plantProgress = 0;
    state.defuseProgress = 0;
    state.beepTimer = 0;
    state.carrier = null;
    group.position.set(at.x, 0.1, at.z);
    group.visible = true;
  }

  function step(dt, time) {
    if (!state.planted || state.exploded || state.defused) return;
    state.fuse = Math.max(0, FUSE_SECONDS - (time - state.plantedAt));
    // beep faster as the fuse burns down
    const rate = 0.15 + 0.85 * (1 - state.fuse / FUSE_SECONDS);
    state.beepTimer += dt;
    const lit = Math.sin(state.beepTimer * (6 + 22 * rate)) > 0;
    lampMat.emissiveIntensity = lit ? 2.2 : 0.35;
    ring.material.opacity = 0.35 + 0.4 * (1 - state.fuse / FUSE_SECONDS);
    if (state.fuse <= 0) {
      state.exploded = true;
      group.visible = false;
    }
  }

  return {
    state,
    group,
    reset,
    plant,
    step,
    inSite(point) {
      const dx = point.x - this.siteCenter.x;
      const dz = point.z - this.siteCenter.z;
      return dx * dx + dz * dz <= SITE_RADIUS * SITE_RADIUS;
    },
    siteCenter: new THREE.Vector3(-8, 0, -12),
  };
}
