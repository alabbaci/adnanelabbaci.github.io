// What stands on the roofs, generated: the stair-head rooms of terrace roofs as plain lime-washed boxes,
// and a minaret for every mosque. Everything is instanced, grouped into the same 500 m squares as the
// buildings so off-screen roofs cost nothing.
//
// Adapted from src/roofs.js of manhattan-free-roam (MIT), where the same code puts water towers on New York.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { flatMaterial } from './shaders.js';

const CHUNK = 500;

function inRing(x, z, p) {
  let inside = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const xi = p[i], zi = p[i + 1], xj = p[j], zj = p[j + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
const inside = (b, x, z) => inRing(x, z, b.p) && !(b.o && b.o.some((h) => inRing(x, z, h)));

export function coloured(geo, rgb) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.attributes.position.count, col = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) col.set(rgb, i * 3);
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3, true));
  g.deleteAttribute('uv');
  return g;
}
function boxGeometry() {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);
  return coloured(g, [255, 255, 255]);
}
const part = (geo, x, y, z, rgb) => coloured(geo.translate(x, y, z), rgb);

// A Moroccan minaret, one metre tall and as wide as it should be for that height (it is scaled to its
// real height where it stands): a square shaft with a band of green tile near the top, stepped merlons,
// a lantern a third as wide, a small dome and the gilded finial.
function minaretGeometry() {
  const STONE = [226, 208, 172], TRIM = [240, 232, 214], TILE = [62, 128, 96], GOLD = [214, 176, 70];
  const w = 0.17, pieces = [];
  pieces.push(part(new THREE.BoxGeometry(w, 0.74, w), 0, 0.37, 0, STONE));
  pieces.push(part(new THREE.BoxGeometry(w * 1.03, 0.05, w * 1.03), 0, 0.655, 0, TILE));
  pieces.push(part(new THREE.BoxGeometry(w * 1.07, 0.012, w * 1.07), 0, 0.74, 0, TRIM));
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]])
    pieces.push(part(new THREE.BoxGeometry(w * 0.2, 0.03, w * 0.2), sx * w * 0.43, 0.761, sz * w * 0.43, TRIM));
  const lw = w * 0.42;
  pieces.push(part(new THREE.BoxGeometry(lw, 0.15, lw), 0, 0.82, 0, STONE));
  pieces.push(part(new THREE.BoxGeometry(lw * 1.05, 0.022, lw * 1.05), 0, 0.855, 0, TILE));
  pieces.push(part(new THREE.SphereGeometry(lw * 0.55, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0, 0.895, 0, TRIM));
  pieces.push(part(new THREE.CylinderGeometry(0.003, 0.003, 0.075, 5), 0, 0.96, 0, GOLD));
  for (const [y, r] of [[0.945, 0.011], [0.966, 0.008], [0.983, 0.0055]]) pieces.push(part(new THREE.SphereGeometry(r, 6, 4), 0, y, 0, GOLD));
  return mergeGeometries(pieces);
}

// skip: landmark numbers drawn as models (nothing is put on those).
export function addRoofDetails(scene, buildings, colliders, skip = new Set()) {
  const groups = new Map();
  const group = (x, z) => {
    const k = Math.floor(x / CHUNK) * 4096 + Math.floor(z / CHUNK);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { boxes: [], minarets: [] }));
    return g;
  };
  let count = 0;
  const minarets = [];
  buildings.forEach((b, index) => {
    if (b.r || b.nr || b.cr || b.st === 6 || b.p.length < 8 || (b.lm != null && skip.has(b.lm))) return;
    let area = 0, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, best = 0, ex = 1, ez = 0, cx = 0, cz = 0;
    const n = b.p.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, ax = b.p[2 * i], az = b.p[2 * i + 1], bx = b.p[2 * j], bz = b.p[2 * j + 1];
      area += ax * bz - bx * az;
      cx += ax / n; cz += az / n;
      x0 = Math.min(x0, ax); x1 = Math.max(x1, ax); z0 = Math.min(z0, az); z1 = Math.max(z1, az);
      const len = Math.hypot(bx - ax, bz - az);
      if (len > best) { best = len; ex = (bx - ax) / len; ez = (bz - az) / len; }
    }
    area = Math.abs(area) / 2;
    // a small repeatable random stream per building
    let seed = (b.s * 7919 + index * 104729) >>> 0;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    const angle = Math.atan2(-ez, ex); // everything on a roof lines up with the building's longest wall

    if (b.mq) {
      // the minaret stands just inside the corner of the mosque furthest from its middle
      let far = 0, vx = cx, vz = cz;
      for (let i = 0; i < n; i++) {
        const d = Math.hypot(b.p[2 * i] - cx, b.p[2 * i + 1] - cz);
        if (d > far) { far = d; vx = b.p[2 * i]; vz = b.p[2 * i + 1]; }
      }
      const h = Math.min(38, Math.max(21, b.h + 13) + rnd() * 5), back = Math.min(far * 0.5, h * 0.11);
      const x = vx + ((cx - vx) / far) * back, z = vz + ((cz - vz) / far) * back;
      const m = { x, z, h, angle, tone: 0.92 + rnd() * 0.12 };
      group(x, z).minarets.push(m);
      minarets.push(m);
      count++;
    }
    if (area < 70 || b.h < 5.5) return;

    // Does a w x d footprint centred at (x, z) sit wholly on this roof, with nothing taller on top of it?
    const fits = (x, z, w, d) => {
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const px = x + ex * sx * w * 0.5 - ez * sz * d * 0.5, pz = z + ez * sx * w * 0.5 + ex * sz * d * 0.5;
        if (!inside(b, px, pz)) return false;
      }
      return !colliders.hitPoint(x, z, b.h + 0.4, b.h + 3);
    };
    const place = (w, d, tries = 7) => {
      for (let t = 0; t < tries; t++) {
        const x = x0 + (0.12 + 0.76 * rnd()) * (x1 - x0), z = z0 + (0.12 + 0.76 * rnd()) * (z1 - z0);
        if (fits(x, z, w + 1.2, d + 1.2)) return [x, z];
      }
      return null;
    };

    // stair-heads and laundry rooms: one to a house, more on a block of flats or a big medina block
    const boxes = Math.min(6, (rnd() < 0.75 ? 1 : 0) + Math.floor(area / 420 + rnd() * 0.9));
    const r = ((b.c >> 16) & 255) / 255, g = ((b.c >> 8) & 255) / 255, bl = (b.c & 255) / 255;
    for (let i = 0; i < boxes; i++) {
      const w = 2.6 + rnd() * 2.6, d = 2.4 + rnd() * 1.8, h = 2.2 + rnd() * 0.7;
      const at = place(w, d);
      if (!at) continue;
      const shade = 0.9 + rnd() * 0.12;
      group(at[0], at[1]).boxes.push({ x: at[0], y: b.h, z: at[1], w, h, d, angle, r: r * shade, g: g * shade, b: bl * shade });
      count++;
    }
  });

  const box = boxGeometry(), minaret = minaretGeometry(), mat = flatMaterial();
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3(), scl = new THREE.Vector3(), tint = new THREE.Color();
  let triangles = 0;
  const add = (geo, list, each) => {
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((it, i) => {
      each(it);
      mesh.setMatrixAt(i, m.compose(pos, q, scl));
      mesh.setColorAt(i, tint);
    });
    mesh.computeBoundingSphere();
    mesh.layers.enable(1); // they cast shadows too
    scene.add(mesh);
    triangles += (geo.attributes.position.count / 3) * list.length;
  };
  for (const g of groups.values()) {
    add(box, g.boxes, (it) => {
      pos.set(it.x, it.y, it.z);
      q.setFromAxisAngle(up, it.angle);
      scl.set(it.w, it.h, it.d);
      tint.setRGB(it.r, it.g, it.b);
    });
    add(minaret, g.minarets, (it) => {
      pos.set(it.x, 0, it.z);
      q.setFromAxisAngle(up, it.angle);
      scl.setScalar(it.h);
      tint.setRGB(it.tone, it.tone, it.tone);
    });
  }
  return { count, minarets, triangles: Math.round(triangles) };
}
