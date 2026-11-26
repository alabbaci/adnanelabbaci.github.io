// Rabat's monuments, built by hand in code.
//
// city.json lists each landmark with the rectangle it stands on (centre, long side L, short side W, the
// direction of the long side) and its height. Each builder below makes its monument in a frame of its own
// (+x along the long side, +z along the short one, y up, the origin on the ground at the middle of the
// rectangle) to exactly that size, and it is then turned and moved onto the map. The plain extruded
// outlines it replaces are left out of the city (see the `lm` tag on buildings).
//
// The Manhattan project this is adapted from loads a generated 3D model for each landmark instead; here
// they are a few hundred boxes, cylinders and lofted shells each. They are likenesses, not surveys.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildingsMesh } from './city.js';
import { buildingMaterial, flatMaterial } from './shaders.js';
import { coloured } from './roofs.js';

const SANDSTONE = [178, 108, 76], SANDSTONE_LIGHT = [198, 132, 96], SANDSTONE_DARK = [118, 68, 50];
const MARBLE = [240, 236, 226], MARBLE_WARM = [226, 216, 194], TILE_GREEN = [58, 124, 90], GOLD = [214, 176, 70];
const SHADOW = [58, 48, 42], COLUMN = [212, 198, 174], WHITE = [240, 238, 232];

// ---------------------------------------------------------------- pieces
const box = (w, h, d, x, y, z, rgb) => coloured(new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z), rgb);
const cylinder = (r0, r1, h, x, y, z, rgb, sides = 12) => coloured(new THREE.CylinderGeometry(r1, r0, h, sides).translate(x, y + h / 2, z), rgb);
// a four-sided pyramid whose base is w x d
function pyramid(w, d, h, x, y, z, rgb) {
  const g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1, false, Math.PI / 4);
  g.scale(w, h, d).translate(x, y + h / 2, z);
  return coloured(g, rgb);
}
function join(pieces) {
  const geo = mergeGeometries(pieces.map((p) => (p.index ? p.toNonIndexed() : p)));
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------- the Hassan Tower
// The minaret of a mosque begun in 1195 and never finished: 44 m of red sandstone, 16 m square, each
// face carved with a different pattern of blind arches and lattice.
function hassan(lm) {
  const s = Math.max(lm.L, lm.W), h = lm.h, pieces = [];
  pieces.push(box(s + 1.6, 1.2, s + 1.6, 0, 0, 0, SANDSTONE_DARK));
  pieces.push(box(s, h - 1.2, s, 0, 1.2, 0, SANDSTONE));
  // the broken top: a low parapet with pieces missing
  for (let i = 0; i < 12; i++) {
    const side = i % 4, k = Math.floor(i / 4) - 1, along = k * s * 0.3, tall = 0.5 + ((i * 7) % 5) * 0.22;
    const x = side === 0 ? along : side === 1 ? s / 2 - 0.5 : side === 2 ? along : -s / 2 + 0.5;
    const z = side === 0 ? -s / 2 + 0.5 : side === 1 ? along : side === 2 ? s / 2 - 0.5 : along;
    pieces.push(box(side % 2 ? 1 : s * 0.24, tall, side % 2 ? s * 0.24 : 1, x, h, z, SANDSTONE));
  }
  // on each face: a tall arched panel low down, paired windows, and the great lattice panel above
  for (let f = 0; f < 4; f++) {
    const face = [];
    const out = s / 2 + 0.08;
    face.push(box(s * 0.36, h * 0.2, 0.3, 0, h * 0.1, out, SANDSTONE_LIGHT));
    face.push(box(s * 0.16, h * 0.15, 0.4, 0, h * 0.11, out, SHADOW));
    for (const dx of [-0.2, 0.2]) {
      face.push(box(s * 0.2, h * 0.13, 0.3, s * dx, h * 0.36, out, SANDSTONE_LIGHT));
      face.push(box(s * 0.07, h * 0.08, 0.4, s * dx, h * 0.38, out, SHADOW));
    }
    face.push(box(s * 0.78, h * 0.3, 0.3, 0, h * 0.56, out, SANDSTONE_LIGHT));
    // the lattice (sebka): a diamond net, here as rows of small dark lozenges
    for (let r = 0; r < 6; r++)
      for (let c = 0; c < 5 + (r % 2); c++) {
        const lozenge = box(s * 0.07, h * 0.026, 0.42, (c - (4 + (r % 2)) / 2) * s * 0.13, h * (0.585 + r * 0.045), out, SANDSTONE_DARK);
        face.push(lozenge);
      }
    face.push(box(s * 0.9, 0.5, 0.5, 0, h * 0.9, out, SANDSTONE_LIGHT));
    const g = join(face).rotateY((f * Math.PI) / 2);
    pieces.push(g);
  }
  return { geo: join(pieces), glow: [0.15, 0.085, 0.04] };
}

// The columns of the unfinished prayer hall, between the tower and the mausoleum: drums of stone standing
// to different heights. lm.ax is the way from the tower to the far end of the hall, lm.run how far it is.
function hassanColumns(scene, lm, landmarks, material) {
  if (!lm.ax) return null;
  const [ax, az] = lm.ax, px = -az, pz = ax;
  const keepOff = landmarks.filter((l) => l.id === 'mausolee').map((l) => ({ x: l.x, z: l.z, r: Math.max(l.L, l.W) * 0.5 + 14 }));
  const spots = [];
  const rnd = (i, k) => Math.abs(Math.sin(i * 127.1 + k * 311.7) * 43758.5453) % 1;
  for (let row = 0; row * 8 + 20 < lm.run - 26; row++)
    for (let col = -8; col <= 8; col++) {
      if (Math.abs(col) < 1) continue; // the central aisle stays open
      const d = 20 + row * 8, o = col * 7.6;
      const x = lm.x + ax * d + px * o, z = lm.z + az * d + pz * o;
      if (keepOff.some((k) => Math.hypot(x - k.x, z - k.z) < k.r)) continue;
      spots.push({ x, z, h: 2.4 + rnd(row * 31 + col, 1) * 3.6, tone: 0.9 + rnd(row * 17 + col, 2) * 0.14 });
    }
  const geo = coloured(new THREE.CylinderGeometry(0.62, 0.68, 1, 10).translate(0, 0.5, 0), COLUMN);
  const mesh = new THREE.InstancedMesh(geo, material, spots.length);
  const m = new THREE.Matrix4(), tint = new THREE.Color();
  spots.forEach((s, i) => {
    mesh.setMatrixAt(i, m.makeScale(1, s.h, 1).setPosition(s.x, 0, s.z));
    mesh.setColorAt(i, tint.setRGB(s.tone, s.tone, s.tone));
  });
  mesh.computeBoundingSphere();
  mesh.layers.enable(1);
  mesh.name = 'hassan columns';
  scene.add(mesh);
  return mesh;
}

// ---------------------------------------------------------------- the Mausoleum of Mohammed V
// White marble on a raised terrace, a carved cornice, and a pyramid of green glazed tiles.
function mausolee(lm) {
  const s = Math.min(lm.L, lm.W) + 2, h = lm.h, pieces = [];
  const podium = h * 0.13, body = h * 0.47, cornice = h * 0.045, roof = h * 0.3;
  pieces.push(box(lm.L + 7, podium * 0.5, lm.W + 7, 0, 0, 0, MARBLE_WARM));
  pieces.push(box(s + 5, podium * 0.5, s + 5, 0, podium * 0.5, 0, MARBLE));
  pieces.push(box(s, body, s, 0, podium, 0, MARBLE));
  for (let f = 0; f < 4; f++) {
    const face = [], out = s / 2 + 0.06;
    // three arches to a side; the middle one is the door
    for (const dx of [-0.3, 0, 0.3]) {
      face.push(box(s * 0.2, body * 0.66, 0.3, s * dx, podium, out, MARBLE_WARM));
      face.push(box(s * 0.13, body * 0.52, 0.42, s * dx, podium, out, dx === 0 ? [96, 70, 40] : SHADOW));
    }
    // steps up to the door
    for (let k = 0; k < 4; k++) face.push(box(s * 0.3, podium * (1 - (k + 1) / 5), 1.1, 0, 0, s / 2 + 3.05 + k * 1.1, MARBLE_WARM));
    face.push(box(s * 0.96, body * 0.1, 0.3, 0, podium + body * 0.78, out, MARBLE_WARM));
    pieces.push(join(face).rotateY((f * Math.PI) / 2));
  }
  pieces.push(box(s + 1.4, cornice, s + 1.4, 0, podium + body, 0, MARBLE_WARM));
  pieces.push(pyramid(s + 1.8, s + 1.8, roof, 0, podium + body + cornice, 0, TILE_GREEN));
  const top = podium + body + cornice + roof;
  pieces.push(cylinder(0.14, 0.1, h - top, 0, top - 0.3, 0, GOLD, 6));
  for (const [y, r] of [[0.15, 0.55], [0.45, 0.42], [0.7, 0.3]]) pieces.push(coloured(new THREE.SphereGeometry(r, 8, 6).translate(0, top + (h - top) * y, 0), GOLD));
  return { geo: join(pieces), glow: [0.2, 0.18, 0.14] };
}

// ---------------------------------------------------------------- Saint Peter's Cathedral
// White, plain and art deco (1921): a long nave and two slender square towers at the front.
function cathedrale(lm) {
  const pieces = [], L = lm.L, W = lm.W, h = lm.h, nave = h * 0.52, tw = Math.min(6.5, W * 0.17);
  pieces.push(box(L * 0.86, nave, W * 0.46, L * 0.05, 0, 0, WHITE));
  pieces.push(pyramidRoof(L * 0.86, W * 0.46, h * 0.1, L * 0.05, nave, MARBLE_WARM));
  pieces.push(box(L * 0.86, nave * 0.6, W * 0.92, L * 0.05, 0, 0, WHITE)); // side aisles
  pieces.push(box(L * 0.2, nave, W * 0.98, L * 0.18, 0, 0, WHITE)); // transept
  // the front: a porch between two towers that step in as they rise
  const fx = -L / 2 + tw / 2;
  pieces.push(box(tw * 1.1, nave * 1.08, W * 0.5, fx, 0, 0, WHITE));
  pieces.push(box(0.5, nave * 0.5, W * 0.14, fx - tw * 0.56, nave * 0.08, 0, SHADOW));
  for (const side of [-1, 1]) {
    const z = side * (W * 0.25 + tw * 0.1);
    pieces.push(box(tw, h * 0.6, tw, fx, 0, z, WHITE));
    pieces.push(box(tw * 0.8, h * 0.2, tw * 0.8, fx, h * 0.6, z, WHITE));
    pieces.push(box(tw * 0.58, h * 0.13, tw * 0.58, fx, h * 0.8, z, WHITE));
    pieces.push(pyramid(tw * 0.58, tw * 0.58, h * 0.07, fx, h * 0.93, z, MARBLE_WARM));
    for (const y of [0.34, 0.63, 0.83]) pieces.push(box(tw * 0.3, h * 0.07, tw * 0.3, fx - tw * 0.36, h * y, z, SHADOW));
  }
  // the front faces the square to the north-west: put the towers at whichever end that is
  const dot = Math.cos(lm.a) * -0.707 + Math.sin(lm.a) * -0.707;
  const geo = join(pieces);
  if (dot > 0) geo.rotateY(Math.PI);
  return { geo, glow: [0.15, 0.14, 0.12] };
}
// a low hipped roof over a w x d rectangle
function pyramidRoof(w, d, h, x, y, rgb) {
  return pyramid(w, d, h, x, y, 0, rgb);
}

// ---------------------------------------------------------------- the Grand Theatre of Rabat
// Zaha Hadid's building on the Bouregreg: one white shell, low at both ends and swelling to a peak over
// the auditorium, like a dune or a wave. Here it is a loft through half-oval ribs.
function theatre(lm) {
  const L = lm.L * 0.9, W = lm.W * 0.86, H = lm.h, ribs = 44, around = 18;
  const pos = [], idx = [];
  const half = (t) => {
    // plan: pointed at both ends, widest a little before the middle, with a waist towards the tail
    const body = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.85)), 0.62);
    return (W / 2) * body * (1 - 0.22 * Math.exp(-(((t - 0.72) / 0.1) ** 2)));
  };
  const crest = (t) => H * (0.16 + 0.84 * Math.exp(-(((t - 0.36) / 0.2) ** 2)) + 0.3 * Math.exp(-(((t - 0.8) / 0.11) ** 2))) * Math.pow(Math.sin(Math.PI * t), 0.35);
  const lean = (t) => W * 0.08 * Math.sin(Math.PI * 2 * t); // the ridge wanders from side to side
  for (let i = 0; i <= ribs; i++) {
    const t = 0.002 + 0.996 * (i / ribs), x = (t - 0.5) * L, w = half(t), top = Math.min(crest(t), H);
    for (let j = 0; j <= around; j++) {
      const a = (j / around) * Math.PI, c = Math.cos(a), s = Math.sin(a);
      // a flattened arch: fuller shoulders than a half circle
      const z = w * Math.sign(c) * Math.pow(Math.abs(c), 0.7), y = top * Math.pow(s, 0.8);
      pos.push(x, y, z + lean(t) * Math.pow(s, 2));
    }
  }
  const row = around + 1;
  for (let i = 0; i < ribs; i++)
    for (let j = 0; j < around; j++) {
      const a = i * row + j, b = a + row;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  let shell = new THREE.BufferGeometry();
  shell.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  shell.setIndex(idx);
  shell.computeVertexNormals();
  // (smooth normals from the shared vertices; then un-share them so it merges with the flat pieces)
  shell = coloured(shell.toNonIndexed(), WHITE);
  const pieces = [shell];
  // the glazed foyer under the tall end, and the terrace the building stands on
  pieces.push(box(L * 0.2, H * 0.3, W * 0.5, -L * 0.14, 0, 0, [70, 88, 100]));
  pieces.push(box(L * 1.04, 0.5, W * 1.08, 0, 0, 0, [214, 208, 196]));
  const geo = mergeGeometries(pieces);
  return { geo, glow: [0.16, 0.16, 0.18] };
}

// ---------------------------------------------------------------- the Mohammed VI Tower
// 250 m, 55 floors, on the Salé bank: a slim glass body that swells slightly above the ground and tapers
// to a point, like a rocket on its pad. Built from ordinary building pieces so that it gets the building
// shader: mirrored glass by day, lit floors at night.
function tourM6(lm) {
  const records = [], H = lm.h, rx = Math.max(lm.L, lm.W) * 0.5 * 1.1, rz = Math.min(lm.L, lm.W) * 0.5 * 0.92;
  const c = Math.cos(lm.a), s = Math.sin(lm.a);
  const ring = (kx, kz, n = 28) => {
    const p = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      // an oval with flattened sides
      const ex = Math.sign(Math.cos(a)) * Math.pow(Math.abs(Math.cos(a)), 0.8) * rx * kx, ez = Math.sign(Math.sin(a)) * Math.pow(Math.abs(Math.sin(a)), 0.8) * rz * kz;
      p.push(Math.round((lm.x + ex * c - ez * s) * 10) / 10, Math.round((lm.z + ex * s + ez * c) * 10) / 10);
    }
    return p;
  };
  const width = (t) => (t < 0.18 ? 0.94 + 0.12 * Math.sin((t / 0.18) * Math.PI * 0.5) : 1.06 - 0.86 * Math.pow((t - 0.18) / 0.82, 1.9));
  // a plinth of shops and the lobby
  records.push({ p: ring(2.3, 2.6, 20), h: 9, c: 0xd9d4c8, s: 412, st: 4, nr: 1 });
  const tiers = 26, body = H * 0.9;
  for (let i = 0; i < tiers; i++) {
    const t0 = i / tiers, t1 = (i + 1) / tiers, k = width((t0 + t1) / 2);
    const rec = { p: ring(k, k), h: Math.round(body * t1 * 10) / 10, c: 0x6f8ea3, s: 412, st: 3, g: 1, t: H, nr: 1 };
    if (i > 0) rec.m = Math.round(body * t0 * 10) / 10;
    records.push(rec);
  }
  // the spire
  records.push({ p: ring(0.07, 0.07, 8), h: H, m: body, c: 0xc9ccd0, s: 412, st: 5, g: 1, nr: 1 });
  return records;
}

const BUILDERS = { hassan, mausolee, cathedrale, theatre };

// Stands each monument on its spot. Returns the set of landmark numbers that now have a model, so the
// city builder can leave out the plain pieces they replace.
export function placeLandmarks(scene, city) {
  const placed = new Set();
  const list = city.landmarks || [];
  const columnMaterial = flatMaterial();
  list.forEach((lm, i) => {
    if (lm.id === 'tourm6') {
      const mesh = buildingsMesh(tourM6(lm), buildingMaterial());
      mesh.layers.enable(1);
      mesh.name = lm.id;
      scene.add(mesh);
      placed.add(i);
      return;
    }
    const build = BUILDERS[lm.id];
    if (!build) return;
    const { geo, glow } = build(lm);
    geo.applyMatrix4(new THREE.Matrix4().makeTranslation(lm.x, 0, lm.z).multiply(new THREE.Matrix4().makeRotationY(-lm.a)));
    geo.computeBoundingSphere();
    // floodlit after dark, as these are
    const mesh = new THREE.Mesh(geo, flatMaterial({ emissive: glow }));
    mesh.layers.enable(1); // casts sun shadows
    mesh.name = lm.id;
    scene.add(mesh);
    placed.add(i);
    if (lm.id === 'hassan') hassanColumns(scene, lm, list, columnMaterial);
  });
  return placed;
}
