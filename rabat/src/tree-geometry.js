import * as THREE from 'three';

export const TREE_SPECIES = [
  { id: 'plane', share: 0.3, height: 12, width: 0.47, start: 0.29, habit: 0.05, curve: 1.08, lean: 0.044, trunk: 1.0, colour: [0.37, 0.49, 0.235] },
  { id: 'locust', share: 0.25, height: 10, width: 0.43, start: 0.32, habit: 0.15, curve: 1.38, lean: 0.06, trunk: 0.74, colour: [0.40, 0.52, 0.255] },
  { id: 'oak', share: 0.2, height: 11, width: 0.52, start: 0.24, habit: -0.045, curve: 1.65, lean: 0.06, trunk: 1.15, colour: [0.32, 0.45, 0.205] },
  { id: 'ginkgo', share: 0.12, height: 9.5, width: 0.31, start: 0.25, habit: 0.20, curve: 0.8, lean: 0.023, trunk: 0.77, colour: [0.45, 0.54, 0.255] },
  { id: 'elm', share: 0.13, height: 13, width: 0.49, start: 0.33, habit: -0.02, curve: 0.61, lean: 0.048, trunk: 0.93, colour: [0.34, 0.48, 0.23] },
];

export const AZIMUTHS = 8, ELEVATIONS = 4, TILE = 128;
export const SPRAY_TILE = 192, SPRAY_COLUMNS = 4;
export const IMPOSTOR_HEIGHT = 0.52, IMPOSTOR_RADIUS = 0.75;

export function treeRandom(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let v = Math.imul(seed ^ (seed >>> 15), seed | 1);
    v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const up = V(0, 1, 0);
const tau = Math.PI * 2;

function geometryWriter() {
  const p = [], n = [], uv = [], payload = [], anchor = [], index = [];
  return {
    get count() { return p.length / 3; },
    vertex(pos, normal, u, v, tile, shade, flex, root) {
      p.push(pos.x, pos.y, pos.z);
      n.push(normal.x, normal.y, normal.z);
      uv.push(u, v);
      payload.push(tile, shade, flex);
      anchor.push(root.x, root.y, root.z);
    },
    index,
    geometry() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setAttribute('aSurface', new THREE.Float32BufferAttribute(payload, 3));
      g.setAttribute('aAnchor', new THREE.Float32BufferAttribute(anchor, 3));
      g.setIndex(index);
      return g;
    },
  };
}

// Tapered connected rings give the trunk and boughs curved profiles and continuous bark grain.
function branch(out, points, radii, sides, shade, height) {
  const first = out.count;
  let length = 0;
  for (let k = 0; k < points.length; k++) {
    const p = points[k];
    const tangent = points[Math.min(k + 1, points.length - 1)].clone().sub(points[Math.max(0, k - 1)]).normalize();
    const side = V(0, 0, 1).cross(tangent).normalize();
    const binormal = tangent.clone().cross(side);
    if (k) length += p.distanceTo(points[k - 1]);
    for (let j = 0; j <= sides; j++) {
      const phase = j / sides * tau;
      const n = side.clone().multiplyScalar(Math.cos(phase)).addScaledVector(binormal, Math.sin(phase));
      const r = radii[k] * (1 + 0.10 * Math.sin(phase * 3 + k * 0.72));
      out.vertex(p.clone().addScaledVector(n, r), n, j / sides, length * 0.68, -1, shade,
        0.36 * (p.y / height) ** 2, p);
      if (k && j) {
        const b = first + k * (sides + 1) + j, a = b - sides - 1;
        out.index.push(a - 1, a, b - 1, a, b, b - 1);
      }
    }
  }
}

function spray(out, p, direction, centre, half, aspect, tile, shade, roll, height) {
  const vertical = direction.clone().normalize();
  const side = vertical.clone().cross(up).normalize().applyAxisAngle(vertical, roll).multiplyScalar(half);
  vertical.multiplyScalar(half * aspect);
  const n = p.clone().sub(centre).normalize();
  const base = out.count;
  for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const v = p.clone().addScaledVector(side, x).addScaledVector(vertical, y);
    const normal = n.clone().addScaledVector(side, x * 0.25).addScaledVector(vertical, y * 0.28).normalize();
    out.vertex(v, normal, (x + 1) / 2, (y + 1) / 2, tile, shade,
      (0.48 + 0.16 * (y + 1)) * (p.y / height) ** 2, p);
  }
  out.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

// All tiers derive from these boughs. The additional near sprays are inside the mid crown and
// mostly visible from below, between its outer sprays.
export function treeGeometry(species) {
  const spec = TREE_SPECIES[species], rnd = treeRandom(23072 + species * 281);
  const H = spec.height, W = H * spec.width, core = geometryWriter(), detail = geometryWriter();
  const path = (y) => V(H * spec.lean * (Math.sin(y * 4.5) + y * y), H * y, H * spec.lean * (Math.cos(y * 5.1) - 1));
  const centre = path(0.56);
  const trunk = [0, 0.028, 0.13, spec.start, 0.47, 0.63, 0.79, 0.91].map(path);
  const girth = [0.032, 0.025, 0.021, 0.017, 0.013, 0.008, 0.004, 0.001].map((r) => r * H * spec.trunk);
  branch(core, trunk, girth, 8, 0.86, H);

  const boughs = [13, 13, 13, 16, 12][species];
  const turn = rnd() * tau;
  for (let k = 0; k < boughs; k++) {
    const t = k / (boughs - 1);
    const az = turn + k * 2.39996 + (rnd() - 0.5) * 0.9;
    const dir = V(Math.cos(az), 0, Math.sin(az));
    const side = V(-dir.z, 0, dir.x);
    const crownBase = spec.start + Math.pow(t, species === 4 ? 1.9 : 1.2) * (0.70 - spec.start) + (rnd() - 0.5) * 0.06;
    const base = path(crownBase);
    const profile = Math.pow(Math.sin(Math.PI * (0.36 + t * 0.60)), species === 3 ? 1.15 : 0.76);
    const reach = W * profile * (0.56 + rnd() * 0.42);
    const rise = H * (0.18 + spec.habit * 0.42 + t * 0.075 + rnd() * 0.08);
    const bend = (rnd() - 0.5) * reach * 0.75;
    const kink = (rnd() - 0.5) * rise * 0.66;
    const at = (u) => base.clone().addScaledVector(dir, reach * u).addScaledVector(side, bend * Math.sin(u * 4.4) * u)
      .addScaledVector(up, rise * Math.pow(u, spec.curve) + kink * Math.sin(u * Math.PI));
    const radius = H * (0.011 - 0.006 * t) * (0.66 + 0.70 * rnd()) * spec.trunk;
    branch(core, [base, at(0.41), at(0.73), at(1)], [radius, radius * 0.67, radius * 0.37, radius * 0.045], 5, 0.77 + rnd() * 0.22, H);

    for (let j = 0; j < 5; j++) {
      const s = 0.4 + j * 0.138, joint = at(s);
      const sign = j % 2 ? 1 : -1;
      const spread = H * (0.086 + rnd() * 0.061) * (1 - 0.28 * t);
      const shoot = dir.clone().multiplyScalar(0.27 + rnd() * 0.44)
        .addScaledVector(side, sign * (0.42 + rnd() * 0.6))
        .addScaledVector(up, 0.32 + rnd() * 0.59).normalize();
      const tip = joint.clone().addScaledVector(shoot, spread);
      tip.y = Math.min(tip.y, H * (0.88 + rnd() * 0.065));
      branch(detail, [joint, tip], [radius * 0.39, 0.007], 3, 0.82, H);
      for (let l = 0; l < 3; l++) {
        const where = joint.clone().lerp(tip, 0.41 + 0.29 * l);
        where.addScaledVector(side, (rnd() - 0.5) * H * 0.11);
        where.y += (rnd() - 0.54) * H * 0.105;
        where.addScaledVector(dir, (rnd() - 0.45) * H * 0.09);
        const along = shoot.clone().addScaledVector(side, rnd() - 0.5).addScaledVector(up, (rnd() - 0.65) * 1.4);
        const half = H * (0.071 + rnd() * 0.035) * (species === 1 ? 0.90 : 1);
        const shade = (0.76 + rnd() * 0.33) * (0.91 + 0.09 * s);
        spray(core, where, along, centre, half, 0.76 + rnd() * 0.22, Math.floor(rnd() * 4), shade, rnd() * tau, H);
      }
      const inner = joint.clone().addScaledVector(shoot, 0.46 * spread).addScaledVector(up, -H * 0.035);
      spray(detail, inner, shoot, centre, H * (0.040 + rnd() * 0.020), 0.9, Math.floor(rnd() * 4), 0.75 + rnd() * 0.16, rnd() * tau, H);
    }
  }
  return { core: core.geometry(), detail: detail.geometry() };
}
