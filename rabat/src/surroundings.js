// What lies beyond the play area: the rest of Rabat, Salé and Témara as simple blocks, their main roads,
// and the open Atlantic.
//
// None of it can be walked on or driven through; it is there so that the city does not stop at a line.
// The blocks come from the same map as the city itself (see outer() in pipeline/01_fetch_overture.py):
// in each 56 m square the largest real building, grown to stand for its neighbours, at its real angle.

import * as THREE from 'three';
import { buildingsMesh } from './city.js';
import { buildingMaterial, flatMaterial, waterMaterial } from './shaders.js';

const CHUNK = 1400;
const WALLS = [0xe9e3d3, 0xe4dcc8, 0xded6c2, 0xefeadd, 0xdcc9a3, 0xd6c096, 0xc99a72, 0xb9b5aa];
const ROAD = [78, 79, 82];
const hash = (a, b) => Math.abs(Math.sin(a * 127.1 + b * 311.7) * 43758.5453) % 1;

export function addSurroundings(scene, city) {
  const outer = city.outer;
  const stats = { blocks: 0, roads: 0 };
  if (outer) {
    // ---- blocks
    const chunks = new Map();
    const b = outer.boxes;
    for (let i = 0; i + 5 < b.length; i += 6) {
      const x = b[i], z = b[i + 1], L = b[i + 2] / 2, W = b[i + 3] / 2, a = b[i + 4], h = b[i + 5];
      const c = Math.cos(a), s = Math.sin(a);
      const p = [];
      for (const [u, v] of [[-L, -W], [L, -W], [L, W], [-L, W]]) p.push(x + u * c - v * s, z + u * s + v * c);
      const k = hash(x, z);
      const rec = { p, h, c: WALLS[Math.floor(hash(z, x) * WALLS.length)], s: Math.floor(k * 1000), st: h > 11 ? (k < 0.3 ? 4 : 0) : 1 };
      const key = Math.floor(x / CHUNK) * 4096 + Math.floor(z / CHUNK);
      let list = chunks.get(key);
      if (!list) chunks.set(key, (list = []));
      list.push(rec);
      stats.blocks++;
    }
    const material = buildingMaterial();
    for (const list of chunks.values()) {
      const mesh = buildingsMesh(list, material);
      mesh.name = 'Surroundings';
      scene.add(mesh);
    }

    // ---- main roads, as plain ribbons on the ground
    const pos = [], col = [], idx = [];
    for (const r of outer.roads) {
      const p = r.p, hw = r.w / 2;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const x0 = p[i], z0 = p[i + 1], x1 = p[i + 2], z1 = p[i + 3];
        const len = Math.hypot(x1 - x0, z1 - z0);
        if (len < 0.5) continue;
        const nx = (-(z1 - z0) / len) * hw, nz = ((x1 - x0) / len) * hw, v = pos.length / 3;
        pos.push(x0 + nx, 0, z0 + nz, x0 - nx, 0, z0 - nz, x1 + nx, 0, z1 + nz, x1 - nx, 0, z1 - nz);
        for (let k = 0; k < 4; k++) col.push(...ROAD);
        idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
      }
      stats.roads++;
    }
    if (pos.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
      const nor = new Int8Array(pos.length);
      for (let i = 1; i < nor.length; i += 3) nor[i] = 127;
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3, true));
      geo.setAttribute('aColor', new THREE.BufferAttribute(new Uint8Array(col), 3, true));
      geo.setIndex(idx);
      const mesh = new THREE.Mesh(geo, flatMaterial({ decal: true, doubleSide: true, surface: 3 }));
      mesh.renderOrder = -46.5; // over the ground, under the city's own streets
      mesh.frustumCulled = false;
      mesh.name = 'Surroundings roads';
      scene.add(mesh);
    }
  }

  // ---- the open ocean. The map's own water stops a few kilometres out; past a line drawn well offshore,
  // square to the way the sea lies, everything is water as far as the haze.
  const sea = city.meta.sea;
  if (sea) {
    const a = (sea.bearing * Math.PI) / 180, nx = Math.sin(a), nz = -Math.cos(a); // out to sea
    const tx = -nz, tz = nx, d0 = sea.from, d1 = sea.from + 40000, half = 45000;
    const corners = [[d0, -half], [d0, half], [d1, half], [d1, -half]].map(([d, t]) => [nx * d + tx * t, 0, nz * d + tz * t]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(corners.flat()), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const mesh = new THREE.Mesh(geo, waterMaterial());
    mesh.renderOrder = -48.5; // with the map's water, before the piers and streets
    mesh.frustumCulled = false;
    mesh.name = 'Ocean';
    scene.add(mesh);
  }
  return stats;
}
