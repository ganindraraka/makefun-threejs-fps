// The map: Foundry, an original two-lane bomb map built from boxes. Every box is a collider
// for the player and a surface a bullet stops on. Plain geometry only, no models, no textures.
// It also hands out what the bots need: spawn points, a waypoint graph to walk, cover to hold,
// and the one bomb site's footprint.
import * as THREE from "three";
import { PALETTE } from "./palette.js";

const WALL = 5.0; // wall height
const HALF = 20.0; // half the playfield, metres: 40 x 36 m

export function createWorld(scene) {
  const group = new THREE.Group();
  scene.add(group);

  const materials = {};
  for (const name of Object.keys(PALETTE)) {
    materials[name] = new THREE.MeshStandardMaterial({
      color: new THREE.Color(PALETTE[name]),
      roughness:
        name === "accent" || name === "objective" || name === "ink"
          ? 0.55
          : 0.92,
      metalness: 0.03,
    });
  }

  const colliders = [];
  const shootables = [];

  function box(
    width,
    height,
    depth,
    x,
    y,
    z,
    material,
    { noCover = false } = {},
  ) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(width, height, depth),
      materials[material],
    );
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    const bounds = new THREE.Box3().setFromObject(mesh);
    colliders.push(bounds);
    shootables.push(mesh);
    return { mesh, bounds, height, noCover };
  }

  // ---- shell: 40 x 36 m floor, walls open to the sky so one key light reaches every corner.
  const floor = box(2 * HALF + 0.4, 0.4, 36.4, 0, -0.2, 0, "canvas", {
    noCover: true,
  });
  box(0.4, WALL, 36.4, -HALF - 0.2, WALL / 2, 0, "surface", { noCover: true });
  box(0.4, WALL, 36.4, HALF + 0.2, WALL / 2, 0, "surface", { noCover: true });
  box(2 * HALF + 0.4, WALL, 0.4, 0, WALL / 2, -18.2, "surface", {
    noCover: true,
  });
  box(2 * HALF + 0.4, WALL, 0.4, 0, WALL / 2, 18.2, "surface", {
    noCover: true,
  });

  // Extra cover the map body is built from. Each entry: [w, h, d, x, z, material].
  // Layout: attacker spawn at +z (south), defender spawn at -z (north), bomb site A near north.
  const blocks = [
    // Central divider wall with a gap: two lanes (west "Long", east "Short").
    [0.6, 3.2, 7.0, 0, -1.0, "surface"],
    [0.6, 3.2, 5.0, 0, 6.5, "surface"],
    // Long lane (west) cover.
    [2.4, 1.1, 1.2, -8.5, 4.0, "hairline"],
    [1.2, 1.1, 3.4, -13.0, -1.0, "hairline"],
    [2.2, 2.4, 1.0, -6.5, -6.0, "hairline"],
    // Short lane (east) cover.
    [1.2, 1.1, 3.4, 9.0, 3.0, "hairline"],
    [2.6, 1.1, 1.2, 12.5, -3.0, "hairline"],
    [1.0, 2.6, 1.0, 6.0, -8.5, "hairline"],
    // Mid tunnel mouth cover.
    [1.4, 1.1, 1.4, 3.4, 2.0, "hairline"],
    [1.4, 1.1, 1.4, -3.4, 2.0, "hairline"],
    // Bomb site A: a low platform and two crates (north-west quadrant).
    [8.0, 0.5, 7.0, -8.0, -12.0, "surface"],
    [1.6, 1.4, 1.6, -5.5, -9.5, "hairline"],
    [1.6, 1.4, 1.6, -10.5, -14.5, "hairline"],
    [1.0, 3.0, 1.0, -11.5, -9.0, "surface"],
    // Defenders' north cover.
    [3.0, 1.2, 1.2, 6.0, -13.0, "hairline"],
    [1.2, 1.2, 3.0, 12.0, -15.0, "hairline"],
    // Attacker spawn south cover.
    [3.0, 1.2, 1.2, -6.0, 14.0, "hairline"],
    [3.0, 1.2, 1.2, 6.0, 14.0, "hairline"],
  ];
  const coverBlocks = [];
  for (const [w, h, d, x, z, mat] of blocks) {
    const wall = box(w, h, d, x, h / 2, z, mat);
    coverBlocks.push(wall);
  }

  // ---- bomb site A: a painted footprint on the ground plus a marker ring.
  const siteCenter = new THREE.Vector3(-8, 0, -12);
  const siteRadius = 4.2;
  const sitePaint = new THREE.Mesh(
    new THREE.RingGeometry(siteRadius - 0.35, siteRadius, 48),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(PALETTE.objective),
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  sitePaint.rotation.x = -Math.PI / 2;
  sitePaint.position.set(siteCenter.x, 0.52, siteCenter.z);
  group.add(sitePaint);
  const siteLabel = new THREE.Mesh(
    new THREE.CircleGeometry(siteRadius - 0.4, 40),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(PALETTE.objective),
      transparent: true,
      opacity: 0.08,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  siteLabel.rotation.x = -Math.PI / 2;
  siteLabel.position.set(siteCenter.x, 0.51, siteCenter.z);
  group.add(siteLabel);

  // ---- spawns. Attackers (player + ally) at south, defenders at north.
  const attackerSpawns = [
    new THREE.Vector3(-4, 0, 15),
    new THREE.Vector3(4, 0, 15),
    new THREE.Vector3(0, 0, 16.5),
  ];
  const defenderSpawns = [
    new THREE.Vector3(-4, 0, -16),
    new THREE.Vector3(4, 0, -16),
    new THREE.Vector3(-8, 0, -16.5),
    new THREE.Vector3(8, 0, -16.5),
    new THREE.Vector3(0, 0, -16),
  ];

  // ---- navigation graph: an original grid of hand-placed waypoints with edges that were
  // checked against the colliders, so a straight line between two joined nodes is clear.
  const nodes = [
    // South (attacker) plaza.
    { p: [-8, 14] },
    { p: [0, 15] },
    { p: [8, 14] },
    { p: [-12, 12] },
    { p: [12, 12] },
    // South-mid gateways around the divider.
    { p: [-6, 8] },
    { p: [0, 9.5] },
    { p: [6, 8] },
    // Mid lanes.
    { p: [-9, 3] },
    { p: [-13, 1] },
    { p: [-6, -2] },
    { p: [9, 2] },
    { p: [13, -1] },
    { p: [6, -4] },
    { p: [0, 1] },
    // North-mid.
    { p: [-8, -6] },
    { p: [-12, -6] },
    { p: [-5, -9] },
    { p: [8, -6] },
    { p: [12, -8] },
    { p: [5, -10] },
    // Around bomb site A (north-west).
    { p: [-13, -11] },
    { p: [-8, -10] },
    { p: [-4, -12] },
    { p: [-8, -15] },
    { p: [-13, -15] },
    // North-east / defender side.
    { p: [-3, -9] },
    { p: [12, -14] },
    { p: [6, -12] },
    { p: [-2, -15] },
    { p: [3, -14] },
    // Defender spawn connectors.
    { p: [-6, -15] },
    { p: [0, -15] },
    { p: [6, -16] },
  ];
  const edges = [
    [0, 1],
    [1, 2],
    [0, 3],
    [2, 4],
    [3, 5],
    [0, 5],
    [1, 6],
    [2, 6],
    [3, 8],
    [4, 11],
    [5, 7],
    [5, 8],
    [6, 7],
    [6, 12],
    [8, 9],
    [8, 14],
    [9, 10],
    [10, 16],
    [10, 21],
    [11, 12],
    [11, 15],
    [12, 13],
    [13, 17],
    [14, 7],
    [15, 10],
    [15, 6],
    [16, 21],
    [16, 26],
    [17, 16],
    [17, 18],
    [18, 15],
    [18, 27],
    [19, 17],
    [20, 13],
    [20, 27],
    [21, 26],
    [22, 10],
    [22, 23],
    [22, 26],
    [23, 24],
    [23, 24],
    [24, 25],
    [24, 27],
    [25, 32],
    [26, 15],
    [27, 28],
    [27, 18],
    [28, 19],
    [29, 21],
    [29, 23],
    [30, 18],
    [30, 31],
    [31, 22],
    [31, 28],
    [32, 3],
    [32, 28],
    [29, 24],
    [14, 15],
    [7, 14],
    [12, 27],
    [22, 24],
    [29, 25],
    [26, 30],
    [30, 28],
  ];
  const waypoints = nodes.map((n) => new THREE.Vector3(n.p[0], 0, n.p[1]));
  const adjacency = waypoints.map(() => []);
  for (const [a, b] of edges) {
    adjacency[a].push(b);
    adjacency[b].push(a);
  }

  // ---- cover points: a spot beside a low block to stand behind, facing the block.
  const coverPoints = [];
  for (const block of coverBlocks) {
    const c = block.bounds.getCenter(new THREE.Vector3());
    const size = block.bounds.getSize(new THREE.Vector3());
    if (block.height > 1.6) continue; // only crouch-worthy, low cover
    const offs = [
      new THREE.Vector3(0, 0, (size.z + 1.4) / 2),
      new THREE.Vector3(0, 0, -(size.z + 1.4) / 2),
      new THREE.Vector3((size.x + 1.4) / 2, 0, 0),
      new THREE.Vector3(-(size.x + 1.4) / 2, 0, 0),
    ];
    for (const off of offs) {
      const spot = new THREE.Vector3(c.x + off.x, 0, c.z + off.z);
      if (Math.abs(spot.x) > HALF - 1 || Math.abs(spot.z) > 17) continue;
      let clear = true;
      for (const other of colliders) {
        if (other.max.y < 0.6) continue;
        if (
          spot.x > other.min.x - 0.4 &&
          spot.x < other.max.x + 0.4 &&
          spot.z > other.min.z - 0.4 &&
          spot.z < other.max.z + 0.4
        ) {
          clear = false;
          break;
        }
      }
      if (clear)
        coverPoints.push({
          pos: spot,
          face: c.clone().setY(0),
          height: block.height,
        });
    }
  }

  // ---- light.
  const sky = new THREE.HemisphereLight(
    new THREE.Color(PALETTE.surface),
    new THREE.Color(PALETTE.canvas),
    1.1,
  );
  scene.add(sky);
  const key = new THREE.DirectionalLight(new THREE.Color(PALETTE.ink), 2.0);
  key.position.set(14, 20, 11);
  key.target.position.set(-3, 0, -6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -26;
  key.shadow.camera.right = 26;
  key.shadow.camera.top = 26;
  key.shadow.camera.bottom = -26;
  key.shadow.camera.far = 70;
  key.shadow.bias = -0.0006;
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight(new THREE.Color(PALETTE.muted), 0.5);
  fill.position.set(-12, 12, 12);
  scene.add(fill);

  function nearestWaypoint(point) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < waypoints.length; i += 1) {
      const dx = waypoints[i].x - point.x;
      const dz = waypoints[i].z - point.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  // A breadth-first path over the waypoint graph: an array of node indices from the node
  // nearest `from` to the node nearest `to`. Deterministic (lowest index wins ties).
  function path(from, to) {
    const start = nearestWaypoint(from);
    const goal = nearestWaypoint(to);
    if (start === goal) return [goal];
    const prev = new Array(waypoints.length).fill(-1);
    const seen = new Array(waypoints.length).fill(false);
    const queue = [start];
    seen[start] = true;
    while (queue.length > 0) {
      const node = queue.shift();
      if (node === goal) break;
      for (const next of adjacency[node]) {
        if (seen[next]) continue;
        seen[next] = true;
        prev[next] = node;
        queue.push(next);
      }
    }
    if (prev[goal] === -1) return [goal];
    const out = [];
    for (let at = goal; at !== -1; at = prev[at]) out.push(at);
    out.reverse();
    return out;
  }

  return {
    colliders,
    shootables,
    group,
    site: { center: siteCenter, radius: siteRadius },
    attackerSpawns,
    defenderSpawns,
    waypoints,
    path,
    nearestWaypoint,
    coverPoints,
    half: HALF,
  };
}
