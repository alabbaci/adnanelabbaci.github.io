// Builds every mesh in the scene from city.json.
//
// Draw order matters for the flat ground layers: they all sit at y = 0 and are painted back to front
// with depth testing off (ground, parks, water, piers, footpaths, roads, crossings), which avoids
// z-fighting entirely. Buildings and bridges are ordinary depth-tested geometry drawn afterwards.

import * as THREE from 'three';
import { Earcut } from 'three/addons/Earcut.js';
import { buildingMaterial, flatMaterial, waterMaterial, lightsMaterial } from './shaders.js';

const CHUNK = 500;
const tick = () => new Promise((r) => setTimeout(r));

function signedArea(p) {
  let s = 0;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) s += p[j] * p[i + 1] - p[i] * p[j + 1];
  return s / 2;
}
function reversed(p) {
  const n = p.length / 2, out = new Array(p.length);
  for (let i = 0; i < n; i++) {
    out[2 * i] = p[2 * (n - 1 - i)];
    out[2 * i + 1] = p[2 * (n - 1 - i) + 1];
  }
  return out;
}
function centroid(p) {
  let cx = 0, cz = 0, a = 0;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const f = p[j] * p[i + 1] - p[i] * p[j + 1];
    cx += (p[j] + p[i]) * f;
    cz += (p[j + 1] + p[i + 1]) * f;
    a += f;
  }
  return Math.abs(a) < 1e-6 ? [p[0], p[1]] : [cx / (3 * a), cz / (3 * a)];
}

// ---------------------------------------------------------------- buildings
function addBuilding(b, o) {
  const outer = signedArea(b.p) < 0 ? reversed(b.p) : b.p;
  const holes = (b.o || []).map((h) => (signedArea(h) > 0 ? reversed(h) : h));
  const base = b.m || 0;
  const pyramid = b.r && !holes.length ? b.r : 0;
  const top = b.h - pyramid;
  const st = b.st || 0;
  const seed = Math.round((b.s / 1000) * 255);
  const glass = b.g ? 255 : 0;
  const cr = (b.c >> 16) & 255, cg = (b.c >> 8) & 255, cb = b.c & 255;
  const rc = b.rc != null ? b.rc : null;
  // roofs here are terraces: lime-washed like the walls on houses, pale screed on larger buildings
  const pale = st === 7 || st === 1 ? 0.9 : st === 6 ? 0.82 : 0.5, lift = st === 7 || st === 1 ? 14 : st === 6 ? 20 : 96;
  const rr = rc != null ? (rc >> 16) & 255 : Math.round(cr * pale + lift);
  const rg = rc != null ? (rc >> 8) & 255 : Math.round(cg * pale + lift);
  const rb = rc != null ? rc & 255 : Math.round(cb * pale + lift - 3);
  // how wide one bay of windows is, by facade style (see the building shader)
  const bay = [3.2, 2.9, 3.0, 1.6, 3.0, 1.8, 1.7, 3.1][st] * (0.9 + 0.2 * (((b.s / 1000) * 7.3) % 1));
  const code = st + (b.cr ? 8 : 0) + (b.kb ? 16 : 0), crownTop = b.t || b.h;

  const wall = (ring) => {
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = ring[2 * i], z0 = ring[2 * i + 1], x1 = ring[2 * j], z1 = ring[2 * j + 1];
      const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      const nx = Math.round((dz / len) * 127), nz = Math.round((-dx / len) * 127);
      const bays = len < 1.4 ? 0 : Math.max(1, Math.round(len / bay));
      const v = o.pos.length / 3;
      o.pos.push(x0, base, z0, x1, base, z1, x1, top, z1, x0, top, z0);
      o.uv.push(0, base, base, top, bays, base, base, top, bays, top, base, top, 0, top, base, top);
      for (let k = 0; k < 4; k++) {
        o.nor.push(nx, 0, nz);
        o.col.push(cr, cg, cb);
        o.info.push(seed, 0, glass, code);
        o.b.push(crownTop, bays ? len / bays : len);
      }
      o.idx.push(v, v + 2, v + 1, v, v + 3, v + 2);
    }
  };
  wall(outer);
  for (const h of holes) wall(h);

  // caps: roof (or the base of a pyramid) and, for raised parts, the underside
  const flat = holes.length ? outer.concat(...holes) : outer;
  let holeIdx = null;
  if (holes.length) {
    holeIdx = [];
    let at = outer.length / 2;
    for (const h of holes) {
      holeIdx.push(at);
      at += h.length / 2;
    }
  }
  const tris = Earcut.triangulate(flat, holeIdx, 2);
  const cap = (y, up, r, g, bl, roofFlag) => {
    const v0 = o.pos.length / 3;
    for (let i = 0; i < flat.length; i += 2) {
      o.pos.push(flat[i], y, flat[i + 1]);
      o.nor.push(0, up ? 127 : -127, 0);
      o.col.push(r, g, bl);
      o.info.push(seed, roofFlag, glass, code);
      o.uv.push(0, y, y, y);
      o.b.push(crownTop, 1);
    }
    for (let i = 0; i < tris.length; i += 3) {
      const a = tris[i], b2 = tris[i + 1], c = tris[i + 2];
      const cross = (flat[2 * b2] - flat[2 * a]) * (flat[2 * c + 1] - flat[2 * a + 1]) - (flat[2 * b2 + 1] - flat[2 * a + 1]) * (flat[2 * c] - flat[2 * a]);
      // a positive 2D cross product faces down in this frame
      if (cross > 0 === up) o.idx.push(v0 + a, v0 + c, v0 + b2);
      else o.idx.push(v0 + a, v0 + b2, v0 + c);
    }
  };
  // a rampart's top is its wall-walk, below the battlements (which the shader cuts out of the wall)
  if (!pyramid) cap(st === 6 ? top - 1.1 : top, true, rr, rg, rb, 255);
  if (base > 0.5) cap(base, false, Math.round(cr * 0.6), Math.round(cg * 0.6), Math.round(cb * 0.6), 255);

  if (pyramid) {
    const [ax, az] = centroid(outer);
    const n = outer.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = outer[2 * i], z0 = outer[2 * i + 1], x1 = outer[2 * j], z1 = outer[2 * j + 1];
      // face normal of (p0, apex, p1), flipped if it points down
      const ux = ax - x0, uy = pyramid, uz = az - z0, wx = x1 - x0, wz = z1 - z0;
      let nx = uy * wz, ny = uz * wx - ux * wz, nz = -uy * wx;
      const l = Math.hypot(nx, ny, nz) || 1;
      const flip = ny < 0;
      const s = (flip ? -127 : 127) / l;
      const v = o.pos.length / 3;
      o.pos.push(x0, top, z0, ax, b.h, az, x1, top, z1);
      for (let k = 0; k < 3; k++) {
        o.nor.push(Math.round(nx * s), Math.round(ny * s), Math.round(nz * s));
        o.col.push(rr, rg, rb);
        o.info.push(seed, 255, glass, code);
        o.uv.push(0, top, top, top);
        o.b.push(crownTop, 1);
      }
      if (flip) o.idx.push(v, v + 2, v + 1);
      else o.idx.push(v, v + 1, v + 2);
    }
  }
}

// One mesh for a list of building records ({ p, h, c, s, st, g, m, ... } as in city.json), drawn with the
// given building material. For anything that wants more buildings than the map holds (src/surroundings.js).
export function buildingsMesh(records, material) {
  const o = { pos: [], nor: [], col: [], uv: [], info: [], b: [], idx: [] };
  for (const b of records) addBuilding(b, o);
  return new THREE.Mesh(buildingGeometry(o), material);
}

function buildingGeometry(o) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(o.pos), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(o.nor), 3, true));
  geo.setAttribute('aColor', new THREE.BufferAttribute(new Uint8Array(o.col), 3, true));
  geo.setAttribute('aUv', new THREE.BufferAttribute(new Float32Array(o.uv), 4));
  geo.setAttribute('aInfo', new THREE.BufferAttribute(new Uint8Array(o.info), 4, true));
  geo.setAttribute('aB', new THREE.BufferAttribute(new Float32Array(o.b), 2));
  const count = o.pos.length / 3;
  geo.setIndex(new THREE.BufferAttribute(count > 65535 ? new Uint32Array(o.idx) : new Uint16Array(o.idx), 1));
  geo.computeBoundingSphere();
  return geo;
}

// ---------------------------------------------------------------- flat layers
const newFlat = () => ({ pos: [], col: [], idx: [] });
function flatGeometry(o, withColour = true) {
  const geo = new THREE.BufferGeometry();
  const n = o.pos.length / 3;
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(o.pos), 3));
  const nor = new Int8Array(n * 3);
  for (let i = 0; i < n; i++) nor[3 * i + 1] = 127;
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3, true));
  if (withColour) geo.setAttribute('aColor', new THREE.BufferAttribute(new Uint8Array(o.col), 3, true));
  if (o.ma) {
    geo.setAttribute('aMarkA', new THREE.BufferAttribute(new Float32Array(o.ma), 4));
    geo.setAttribute('aMarkB', new THREE.BufferAttribute(new Float32Array(o.mb), 4));
  }
  geo.setIndex(new THREE.BufferAttribute(n > 65535 ? new Uint32Array(o.idx) : new Uint16Array(o.idx), 1));
  geo.computeBoundingSphere();
  return geo;
}

function addPolygon(o, a, colour, y = 0) {
  let flat = a.p, holeIdx = null;
  if (a.o) {
    holeIdx = [];
    let at = a.p.length / 2;
    flat = a.p.slice();
    for (const h of a.o) {
      holeIdx.push(at);
      at += h.length / 2;
      for (const v of h) flat.push(v);
    }
  }
  const tris = Earcut.triangulate(flat, holeIdx, 2);
  const v0 = o.pos.length / 3;
  for (let i = 0; i < flat.length; i += 2) {
    o.pos.push(flat[i], y, flat[i + 1]);
    o.col.push(colour[0], colour[1], colour[2]);
  }
  // wind every triangle so that it faces up (a positive 2D cross product faces down in this frame)
  for (let i = 0; i < tris.length; i += 3) {
    const t0 = tris[i], t1 = tris[i + 1], t2 = tris[i + 2];
    const cross = (flat[2 * t1] - flat[2 * t0]) * (flat[2 * t2 + 1] - flat[2 * t0 + 1]) - (flat[2 * t1 + 1] - flat[2 * t0 + 1]) * (flat[2 * t2] - flat[2 * t0]);
    if (cross > 0) o.idx.push(v0 + t0, v0 + t2, v0 + t1);
    else o.idx.push(v0 + t0, v0 + t1, v0 + t2);
  }
}

// Layers that carry road paint also record, per vertex, where on the road it is (see MARKS in shaders.js).
const newRoad = () => ({ pos: [], col: [], idx: [], ma: [], mb: [] });
const NO_PAINT = { lw: 0, lanes: 0, flags: 0, park: 0, kind: 0 };
const ZEBRA = { lw: 0, lanes: 0, flags: 0, park: 0, kind: 2 };
const NODE_KEY = (x, z) => Math.round(x * 10) * 100003 + Math.round(z * 10);

// A road as a ribbon with mitred corners, from point i0 to point i1 of polyline p.
// ys (optional) lifts bridge vertices. paint (optional) says which lines to draw on it.
function addRibbon(o, p, width, ys, yOff, colour, paint = NO_PAINT, i0 = 0, i1 = p.length / 2 - 1) {
  if (i1 - i0 < 1) return;
  const hw = width / 2;
  const v0 = o.pos.length / 3;
  let length = 0, along = 0;
  const rim = ys ? [] : null; // raised ribbons also get a body, built from their edges afterwards
  if (o.ma) for (let i = i0; i < i1; i++) length += Math.hypot(p[2 * i + 2] - p[2 * i], p[2 * i + 3] - p[2 * i + 1]);
  for (let i = i0; i <= i1; i++) {
    const x = p[2 * i], z = p[2 * i + 1];
    let ax = 0, az = 0, bx = 0, bz = 0;
    if (i > i0) {
      ax = x - p[2 * i - 2];
      az = z - p[2 * i - 1];
      const l = Math.hypot(ax, az) || 1;
      along += l;
      ax /= l;
      az /= l;
    }
    if (i < i1) {
      bx = p[2 * i + 2] - x;
      bz = p[2 * i + 3] - z;
      const l = Math.hypot(bx, bz) || 1;
      bx /= l;
      bz /= l;
    }
    if (i === i0) { ax = bx; az = bz; }
    if (i === i1) { bx = ax; bz = az; }
    let tx = ax + bx, tz = az + bz;
    const tl = Math.hypot(tx, tz);
    if (tl < 1e-4) { tx = bx; tz = bz; } else { tx /= tl; tz /= tl; }
    const m = Math.min(1 / Math.max(tx * bx + tz * bz, 0.4), 2.2) * hw;
    const y = (ys ? ys[i] : 0) + yOff;
    // first vertex is the right-hand edge (looking along the road), second the left
    o.pos.push(x - tz * m, y, z + tx * m, x + tz * m, y, z - tx * m);
    o.col.push(colour[0], colour[1], colour[2], colour[0], colour[1], colour[2]);
    if (rim) rim.push(x - tz * m, z + tx * m, x + tz * m, z - tx * m, y, along);
    if (o.ma) {
      o.ma.push(hw, along, length, paint.lw, -hw, along, length, paint.lw);
      o.mb.push(paint.lanes, paint.flags, paint.park, paint.kind, paint.lanes, paint.flags, paint.park, paint.kind);
    }
    if (i < i1) {
      const a = v0 + 2 * (i - i0);
      o.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); // wound to face up
    }
  }
  if (rim) addDeck(o, rim, length, paint.flags);
}

// Gives a raised ribbon some body: an underside, and a low wall along each edge. The walls shrink
// away near junctions so that roads merging on a bridge are not walled off from each other, and
// near the ground so that a ramp grows its walls as it rises.
const DECK_UNDER = [46, 48, 52], DECK_SIDE = [128, 126, 120];
function addDeck(o, rim, length, flags) {
  const n = rim.length / 6;
  const at = (i) => {
    const k = 6 * i, y = rim[k + 4], along = rim[k + 5];
    const gap = Math.min(flags & 2 ? along : 1000, flags & 4 ? length - along : 1000);
    const wall = Math.min(0.9, Math.max(0, y - 0.3)) * Math.min(1, Math.max(0, (gap - 10) / 8));
    return { rx: rim[k], rz: rim[k + 1], lx: rim[k + 2], lz: rim[k + 3], top: y + wall, under: Math.max(0.02, y - 0.9) };
  };
  const strip = (colour, corners) => {
    const v0 = o.pos.length / 3;
    for (let i = 0; i < n; i++) {
      o.pos.push(...corners(at(i)));
      o.col.push(...colour, ...colour);
      if (o.ma) {
        o.ma.push(0, 0, 0, 0, 0, 0, 0, 0);
        o.mb.push(0, 0, 0, 0, 0, 0, 0, 0);
      }
      if (i < n - 1) {
        const a = v0 + 2 * i;
        o.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
  };
  strip(DECK_UNDER, (e) => [e.rx, e.under, e.rz, e.lx, e.under, e.lz]);
  strip(DECK_SIDE, (e) => [e.rx, e.top, e.rz, e.rx, e.under, e.rz]);
  strip(DECK_SIDE, (e) => [e.lx, e.top, e.lz, e.lx, e.under, e.lz]);
}

// Lane lines for a street, laid out exactly where traffic.js puts its lanes.
function lanePaint(r, junctionAtStart, junctionAtEnd) {
  const park = r.c === 0 ? 0 : 2.25; // kerbside parking strip
  let lanes, lw, parkLine;
  if (r.o) {
    lanes = r.l;
    lw = Math.min(3.4, (r.w - 2 * park) / lanes);
    parkLine = (lanes * lw) / 2;
  } else {
    lanes = Math.max(1, Math.floor(r.l / 2));
    lw = Math.min(3.4, (r.w / 2 - park) / lanes);
    parkLine = lanes * lw;
  }
  // only avenues get a painted parking-lane edge, and only where there is room for one
  if (r.c !== 1 || r.w / 2 - parkLine < 1.6) parkLine = 0;
  return { lw, lanes, flags: (r.o ? 1 : 0) + (junctionAtStart ? 2 : 0) + (junctionAtEnd ? 4 : 0), park: parkLine, kind: 0 };
}

const AREA_COLOUR = {
  park: [112, 138, 84], grass: [128, 146, 92], garden: [106, 138, 86], wood: [84, 114, 72], pitch: [96, 146, 96],
  play: [190, 168, 130], pier: [156, 150, 138], plaza: [190, 180, 162], sand: [222, 204, 164], cemetery: [203, 194, 170],
};
const ROAD_COLOUR = [[78, 79, 82], [182, 174, 160], [196, 192, 184]];
const GROUND_COLOUR = [166, 160, 148];
const RAIL_COLOUR = [[104, 108, 102], [112, 104, 96]]; // tram track bed, railway ballast

// ---------------------------------------------------------------- everything
// skip: landmark numbers that have their own model, whose plain extruded pieces should be left out.
export async function buildCity(city, scene, onProgress = () => {}, skip = new Set()) {
  const stats = { triangles: 0, buildings: city.buildings.length, roads: city.roads.length, trees: city.trees.length / 3 };

  // ground
  {
    const g = new THREE.PlaneGeometry(60000, 60000);
    g.rotateX(-Math.PI / 2);
    const col = new Uint8Array(4 * 3);
    for (let i = 0; i < 4; i++) col.set(GROUND_COLOUR, i * 3);
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3, true));
    const ground = new THREE.Mesh(g, flatMaterial({ surface: 1 }));
    ground.renderOrder = -50;
    ground.frustumCulled = false;
    scene.add(ground);
  }

  // parks, water, piers, plazas
  onProgress('Laying out parks, beaches and the river…');
  const green = newFlat(), water = newFlat(), hard = newFlat(), bare = newFlat();
  for (const a of city.areas) {
    if (a.k === 'water') addPolygon(water, a, [0, 0, 0]);
    else if (a.k === 'pier' || a.k === 'plaza') addPolygon(hard, a, AREA_COLOUR[a.k]);
    else if (a.k === 'sand' || a.k === 'cemetery') addPolygon(bare, a, AREA_COLOUR[a.k]);
    else {
      const c = AREA_COLOUR[a.k] || AREA_COLOUR.grass;
      const j = ((Math.abs(a.p[0] * 13.1 + a.p[1] * 7.7) % 1) - 0.5) * 14;
      addPolygon(green, a, [c[0] + j, c[1] + j, c[2] + j * 0.6]);
    }
  }
  const decal = (o, order, material) => {
    if (!o.pos.length) return null;
    const mesh = new THREE.Mesh(flatGeometry(o), material);
    mesh.renderOrder = order;
    mesh.frustumCulled = false;
    scene.add(mesh);
    stats.triangles += o.idx.length / 3;
    return mesh;
  };
  decal(bare, -49.5, flatMaterial({ decal: true, doubleSide: true, surface: 6 }));
  decal(green, -49, flatMaterial({ decal: true, doubleSide: true, surface: 2 }));
  decal(water, -48, waterMaterial());
  decal(hard, -47, flatMaterial({ decal: true, doubleSide: true, surface: 4 }));
  await tick();

  // roads
  onProgress('Paving the streets…');
  const layers = [newRoad(), newFlat(), newRoad()];
  const elevated = newRoad();
  const lamps = [];
  // How many street ends meet at each point: 3 or more is a junction, where lane paint stops.
  const degree = new Map();
  for (const r of city.roads) {
    if (r.k !== 0 || r.c > 2) continue;
    for (let i = 0; i < r.p.length; i += 2) {
      const k = NODE_KEY(r.p[i], r.p[i + 1]);
      degree.set(k, (degree.get(k) || 0) + (i === 0 || i === r.p.length - 2 ? 1 : 2));
    }
  }
  const junction = (r, i) => degree.get(NODE_KEY(r.p[2 * i], r.p[2 * i + 1])) >= 3;
  for (const r of city.roads) {
    const raised = r.y && r.y.some((v) => v > 0.3);
    const into = raised ? elevated : layers[r.k], ys = raised ? r.y : null, yOff = raised ? 0.15 : 0;
    if (r.k === 1) addRibbon(into, r.p, r.w, ys, yOff, ROAD_COLOUR[1]);
    else if (r.k === 2) addRibbon(into, r.p, r.w, ys, yOff, ROAD_COLOUR[0], ZEBRA);
    else if (r.c > 2) addRibbon(into, r.p, r.w, ys, yOff, ROAD_COLOUR[0]);
    else {
      // one ribbon per stretch between junctions, so each stretch knows where its ends are
      const last = r.p.length / 2 - 1;
      let start = 0;
      for (let i = 1; i <= last; i++) {
        if (i < last && !junction(r, i)) continue;
        addRibbon(into, r.p, r.w, ys, yOff, ROAD_COLOUR[0], lanePaint(r, junction(r, start), junction(r, i)), start, i);
        start = i;
      }
    }
    // park and plaza paths have lamps too: lower posts, closer together, all on one side
    const path = r.k === 1 && !raised;
    if (!path && (r.k !== 0 || r.w < 7)) continue;
    // street lights every ~40 m, alternating sides
    let carry = 20, side = 1;
    for (let i = 0; i + 3 < r.p.length; i += 2) {
      const x0 = r.p[i], z0 = r.p[i + 1], x1 = r.p[i + 2], z1 = r.p[i + 3];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 0.01) continue;
      const nx = -(z1 - z0) / len, nz = (x1 - x0) / len;
      while (carry < len) {
        const t = carry / len;
        const y = r.y ? r.y[i / 2] + (r.y[i / 2 + 1] - r.y[i / 2]) * t : 0;
        const off = (r.w / 2 + 0.8) * side;
        lamps.push(x0 + (x1 - x0) * t + nx * off, y + (path ? 4 : 8), z0 + (z1 - z0) * t + nz * off);
        if (!path) side = -side;
        carry += path ? 32 : 40;
      }
      carry -= len;
    }
  }
  decal(layers[1], -46, flatMaterial({ decal: true, doubleSide: true, emissive: [0.008, 0.007, 0.005], surface: 5 }));
  decal(layers[0], -45, flatMaterial({ decal: true, doubleSide: true, marks: true, emissive: [0.012, 0.01, 0.008], surface: 3 }));
  decal(layers[2], -44, flatMaterial({ decal: true, doubleSide: true, marks: true, emissive: [0.012, 0.01, 0.008], surface: 3 }));
  // the tram's track bed and the railway, laid over the streets they share
  const tracks = newFlat();
  for (const r of city.rails || []) addRibbon(tracks, r.p, r.k === 0 ? 2.7 : 3.4, null, 0, RAIL_COLOUR[r.k]);
  decal(tracks, -43, flatMaterial({ decal: true, doubleSide: true, surface: 7 }));
  if (elevated.pos.length) {
    const mesh = new THREE.Mesh(flatGeometry(elevated), flatMaterial({ doubleSide: true, offset: true, marks: true, emissive: [0.012, 0.01, 0.008], surface: 3 }));
    mesh.frustumCulled = false;
    mesh.layers.enable(1); // bridges shade the streets under them
    scene.add(mesh);
    stats.triangles += elevated.idx.length / 3;
  }
  const lampGeo = new THREE.BufferGeometry();
  lampGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lamps), 3));
  const lights = new THREE.Points(lampGeo, lightsMaterial());
  lights.frustumCulled = false;
  lights.visible = false;
  scene.add(lights);
  stats.lamps = lamps.length / 3;
  await tick();

  // buildings, grouped into square chunks so the renderer can cull what is off screen
  const chunks = new Map();
  for (const b of city.buildings) {
    if (b.lm != null && skip.has(b.lm)) continue;
    const k = Math.floor(b.p[0] / CHUNK) * 4096 + Math.floor(b.p[1] / CHUNK);
    let list = chunks.get(k);
    if (!list) chunks.set(k, (list = []));
    list.push(b);
  }
  const material = buildingMaterial();
  let done = 0;
  for (const list of chunks.values()) {
    const o = { pos: [], nor: [], col: [], uv: [], info: [], b: [], idx: [] };
    for (const b of list) addBuilding(b, o);
    const mesh = new THREE.Mesh(buildingGeometry(o), material);
    mesh.layers.enable(1); // layer 1 = things that cast sun shadows
    scene.add(mesh);
    stats.triangles += o.idx.length / 3;
    done += list.length;
    onProgress(`Building ${done.toLocaleString()} / ${city.buildings.length.toLocaleString()}`);
    await tick();
  }


  return { stats, lights };
}
