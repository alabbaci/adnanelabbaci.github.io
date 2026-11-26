// Turns the raw downloads in rabat/pipeline/.cache/raw/ (written by 01_fetch_overture.py) into the compact
// rabat/data/city.json the game loads.
// Usage: node rabat/pipeline/02_build_city.mjs
// Coordinates in the output are metres in a local frame: +x east, +z south, origin at the bbox centre.
//
// Adapted from tools/build-city.mjs of manhattan-free-roam (MIT, see ../LICENSE).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plantTrees } from './plant-trees.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AREA = JSON.parse(await readFile(join(HERE, 'area.json'), 'utf8'));

const { south, west, north, east } = AREA.bbox;
const lat0 = (south + north) / 2;
const lon0 = (west + east) / 2;
const MX = 111320 * Math.cos((lat0 * Math.PI) / 180);
const MZ = 110574;
const X = (lon) => (lon - lon0) * MX;
const Z = (lat) => -(lat - lat0) * MZ;
const r1 = (v) => Math.round(v * 10) / 10;

const BOUNDS = { x0: X(west), x1: X(east), z0: Z(north), z1: Z(south) };
const grow = (b, m) => ({ x0: b.x0 - m, x1: b.x1 + m, z0: b.z0 - m, z1: b.z1 + m });

// ---------- small helpers ----------
const num = (v) => {
  if (v == null) return NaN;
  const m = String(v).match(/-?\d+(\.\d+)?/);
  if (!m) return NaN;
  let n = parseFloat(m[0]);
  if (/ft|'/.test(String(v))) n *= 0.3048;
  return n;
};
const hash = (n) => {
  let h = (Math.abs(Math.floor(n)) ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const toRing = (geom) => {
  const pts = geom.map((g) => [X(g.lon), Z(g.lat)]);
  if (pts.length > 1) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01) pts.pop();
  }
  // drop consecutive duplicates
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > 0.02 || Math.abs(q[1] - p[1]) > 0.02) out.push(p);
  }
  return out;
};
const isClosed = (geom) => {
  if (!geom || geom.length < 4) return false;
  const a = geom[0], b = geom[geom.length - 1];
  return a.lat === b.lat && a.lon === b.lon;
};
const area = (ring) => {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return s / 2;
};
const centroid = (ring) => {
  let cx = 0, cz = 0, a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    cx += (ring[j][0] + ring[i][0]) * f;
    cz += (ring[j][1] + ring[i][1]) * f;
    a += f;
  }
  if (Math.abs(a) < 1e-6) return ring[0];
  return [cx / (3 * a), cz / (3 * a)];
};
const inRing = (x, z, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
};
const inPoly = (x, z, poly) => inRing(x, z, poly.outer) && !poly.holes.some((h) => inRing(x, z, h));
const bboxOf = (ring) => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of ring) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return { x0, x1, z0, z1 };
};
const overlaps = (a, b) => a.x0 <= b.x1 && a.x1 >= b.x0 && a.z0 <= b.z1 && a.z1 >= b.z0;
const interiorPoint = (ring) => {
  const c = centroid(ring);
  if (inRing(c[0], c[1], ring)) return c;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], d = ring[(i + 2) % ring.length];
    const p = [(a[0] + b[0] + d[0]) / 3, (a[1] + b[1] + d[1]) / 3];
    if (inRing(p[0], p[1], ring)) return p;
  }
  return c;
};

// Sutherland–Hodgman clip of a ring against an axis-aligned box.
function clipRing(ring, b) {
  const edges = [
    [(p) => p[0] >= b.x0, (p, q) => [b.x0, p[1] + ((q[1] - p[1]) * (b.x0 - p[0])) / (q[0] - p[0])]],
    [(p) => p[0] <= b.x1, (p, q) => [b.x1, p[1] + ((q[1] - p[1]) * (b.x1 - p[0])) / (q[0] - p[0])]],
    [(p) => p[1] >= b.z0, (p, q) => [p[0] + ((q[0] - p[0]) * (b.z0 - p[1])) / (q[1] - p[1]), b.z0]],
    [(p) => p[1] <= b.z1, (p, q) => [p[0] + ((q[0] - p[0]) * (b.z1 - p[1])) / (q[1] - p[1]), b.z1]],
  ];
  let out = ring;
  for (const [inside, cut] of edges) {
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const cur = src[i], prev = src[(i + src.length - 1) % src.length];
      const ci = inside(cur), pi = inside(prev);
      if (ci) {
        if (!pi) out.push(cut(prev, cur));
        out.push(cur);
      } else if (pi) out.push(cut(prev, cur));
    }
    if (out.length < 3) return [];
  }
  return out;
}

// Stitch the member ways of a multipolygon relation into closed rings.
function assemble(members) {
  const key = (g) => `${g.lat},${g.lon}`;
  const build = (ways) => {
    const rings = [];
    const pool = ways.filter((w) => w.geometry && w.geometry.length > 1).map((w) => w.geometry.slice());
    while (pool.length) {
      let chain = pool.pop();
      let guard = 0;
      while (key(chain[0]) !== key(chain[chain.length - 1]) && guard++ < 10000) {
        const end = key(chain[chain.length - 1]);
        const i = pool.findIndex((g) => key(g[0]) === end || key(g[g.length - 1]) === end);
        if (i < 0) break;
        let next = pool.splice(i, 1)[0];
        if (key(next[0]) !== end) next = next.slice().reverse();
        chain = chain.concat(next.slice(1));
      }
      if (chain.length >= 4 && key(chain[0]) === key(chain[chain.length - 1])) rings.push(toRing(chain));
    }
    return rings.filter((r) => r.length >= 3);
  };
  const outers = build(members.filter((m) => m.type === 'way' && m.role !== 'inner'));
  const inners = build(members.filter((m) => m.type === 'way' && m.role === 'inner'));
  const polys = outers.map((outer) => ({ outer, holes: [] }));
  for (const h of inners) {
    const p = polys.find((pl) => inRing(h[0][0], h[0][1], pl.outer));
    if (p) p.holes.push(h);
  }
  return polys;
}

const polysOf = (el) => {
  if (el.type === 'way') {
    if (!isClosed(el.geometry)) return [];
    const outer = toRing(el.geometry);
    return outer.length >= 3 ? [{ outer, holes: [] }] : [];
  }
  if (el.type === 'relation' && el.members) return assemble(el.members);
  return [];
};

// ---------- colours ----------
const NAMED = {
  black: 0x1c1d1f, white: 0xf2f1ec, gray: 0x8c8c8c, grey: 0x8c8c8c, silver: 0xb9bcc0, red: 0xa63a2e, maroon: 0x6e2a25,
  brown: 0x7b5a42, beige: 0xd9cdb0, tan: 0xc8ab84, yellow: 0xdcc66a, orange: 0xc98346, green: 0x5f7f5a, blue: 0x4f6f96,
  navy: 0x2c3b5a, pink: 0xd9a9a5, purple: 0x6b5878, gold: 0xc9a54a, ivory: 0xece8d6, khaki: 0xc3b68a, cream: 0xe8dfc4,
  darkgray: 0x55585b, darkgrey: 0x55585b, lightgray: 0xc4c5c6, lightgrey: 0xc4c5c6, dimgray: 0x666666, dimgrey: 0x666666,
  slategray: 0x67727d, slategrey: 0x67727d, lightblue: 0x9db9cf, darkblue: 0x2b3f66, darkred: 0x7a2a22, darkgreen: 0x35543a,
  olive: 0x77774a, teal: 0x3f7a7a, cyan: 0x6fb6c2, turquoise: 0x5fb0a8, salmon: 0xd08f7c, coral: 0xcf7a5f, sienna: 0x94553a,
  peru: 0xb8834f, wheat: 0xdccfa9, linen: 0xe9e2d4, bisque: 0xe6d2b5, chocolate: 0x8a4f2c, firebrick: 0x9a3328, glass: 0x6f8ea3,
  lightbrown: 0xa9825f, darkbrown: 0x5a4131, sandstone: 0xcbb994, terracotta: 0xb5674a, copper: 0x7fa58c, bronze: 0x7a6248,
};
function parseColour(v) {
  if (!v) return null;
  let s = String(v).trim().toLowerCase().split(';')[0].replace(/[\s_-]/g, '');
  if (NAMED[s] != null) return NAMED[s];
  let m = s.match(/^#([0-9a-f]{6})$/);
  if (m) return parseInt(m[1], 16);
  m = s.match(/^#([0-9a-f]{3})$/);
  if (m) return parseInt(m[1].split('').map((c) => c + c).join(''), 16);
  return null;
}
// Keep façades readable: lift near-black, calm near-white.
function tame(c) {
  let r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  const l = 0.299 * r + 0.587 * g + 0.114 * b;
  if (l < 42) {
    const k = 42 - l;
    r += k; g += k; b += k * 1.1;
  } else if (l > 236) {
    const k = 236 / l;
    r *= k; g *= k; b *= k;
  }
  const c8 = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return (c8(r) << 16) | (c8(g) << 8) | c8(b);
}
// Rabat is whitewash, cream and ochre: lime-washed medina houses, the white ville nouvelle, pink-ochre
// rammed earth, and only a little glass.
const PAL = {
  white: [0xefeadd, 0xe9e3d3, 0xe4dcc8, 0xf1eee6, 0xded6c2, 0xe8e1d0, 0xece6da],
  cream: [0xdcc9a3, 0xd6c096, 0xcdb58b, 0xe0d0ad, 0xd9c7a6],
  ochre: [0xc99a72, 0xbf8a64, 0xd0a680, 0xb98463, 0xc7926c],
  grey: [0xb9b5aa, 0xa9a69c, 0xc4c0b4, 0x9d9a92],
  glass: [0x6f8ea3, 0x5f7f96, 0x7c9aa9, 0x53708a, 0x86a2ae, 0x6a8791],
  steel: [0x5c6468, 0x6b7378, 0x7a8287],
  brick: [0xb5795a, 0xa86c50, 0xc08a6a],
  stone: [0xd3c4a2, 0xc9b890, 0xbfae8a, 0xdccfb0],
};
function fallbackColour(seed, h, material, old) {
  const pick = (arr, k = 1) => arr[Math.floor(hash(seed * 7 + k) * arr.length)];
  if (material === 'brick') return { c: pick(PAL.brick), g: 0 };
  if (material === 'glass' || material === 'mirror') return { c: pick(PAL.glass), g: 1 };
  if (material === 'metal' || material === 'steel') return { c: pick(PAL.steel), g: 1 };
  if (material === 'concrete') return { c: pick(PAL.grey), g: 0 };
  if (material === 'stone' || material === 'limestone' || material === 'marble' || material === 'granite' || material === 'sandstone') return { c: pick(PAL.stone), g: 0 };
  const r = hash(seed * 3 + 11);
  if (old) return r < 0.8 ? { c: pick(PAL.white), g: 0 } : r < 0.95 ? { c: pick(PAL.cream), g: 0 } : { c: pick(PAL.ochre), g: 0 };
  if (h > 45) return r < 0.55 ? { c: pick(PAL.glass), g: 1 } : r < 0.75 ? { c: pick(PAL.white), g: 0 } : { c: pick(PAL.grey), g: 0 };
  if (h > 17) return r < 0.07 ? { c: pick(PAL.glass), g: 1 } : r < 0.62 ? { c: pick(PAL.white), g: 0 } : r < 0.83 ? { c: pick(PAL.cream), g: 0 } : r < 0.91 ? { c: pick(PAL.ochre), g: 0 } : { c: pick(PAL.grey), g: 0 };
  return r < 0.6 ? { c: pick(PAL.white), g: 0 } : r < 0.84 ? { c: pick(PAL.cream), g: 0 } : r < 0.94 ? { c: pick(PAL.ochre), g: 0 } : { c: pick(PAL.grey), g: 0 };
}
// The old towns (see low_districts in area.json): lime-washed, low, close-packed.
const OLD = (AREA.low_districts || []).map((d) => ({ x: X(d.lon), z: Z(d.lat), r: d.radius, name: d.name }));
const KASBAH = OLD.find((d) => /Kasbah/i.test(d.name));
const oldTown = (x, z) => OLD.some((d) => (x - d.x) ** 2 + (z - d.z) ** 2 < d.r * d.r);

// ---------- load ----------
const load = async (n) => JSON.parse(await readFile(join(HERE, '.cache', 'raw', `${n}.json`), 'utf8')).elements;
const [rawB, rawR, rawN, rawX] = await Promise.all([load('buildings'), load('roads'), load('nature'), load('extras')]);
const rawOuter = JSON.parse(await readFile(join(HERE, '.cache', 'raw', 'outer.json'), 'utf8'));

// ---------- buildings ----------
const FLOOR = 3.2;
const outlines = [];
const parts = [];
for (const el of rawB) {
  const t = el.tags || {};
  if (el.type === 'relation' && t.type !== 'multipolygon') continue;
  if (t.location === 'underground' || num(t.layer) < 0) continue;
  const isPart = t['building:part'] && t['building:part'] !== 'no';
  const isBuilding = t.building && t.building !== 'no';
  if (!isPart && !isBuilding) continue;
  for (const poly of polysOf(el)) {
    const a = Math.abs(area(poly.outer));
    if (a < 4) continue;
    // the download reaches a little past the play area; keep what stands inside it
    const [mx, mz] = interiorPoint(poly.outer);
    if (mx < BOUNDS.x0 - 40 || mx > BOUNDS.x1 + 40 || mz < BOUNDS.z0 - 40 || mz > BOUNDS.z1 + 40) continue;
    // slivers: machine-detected footprints a metre or two wide stand up as bare sheets
    if (!isPart && (a < 10 || tightBox(poly.outer).W < 1.8)) continue;
    const rec = { id: el.id, t, poly, area: a, bb: bboxOf(poly.outer), partArea: 0, parent: null };
    (isPart ? parts : outlines).push(rec);
  }
}

// Which outline does each part belong to? (Simple 3D Buildings: parts replace the outline.)
const CELL = 120;
const grid = new Map();
const cellKey = (i, j) => i * 100000 + j;
outlines.forEach((o, idx) => {
  for (let i = Math.floor(o.bb.x0 / CELL); i <= Math.floor(o.bb.x1 / CELL); i++)
    for (let j = Math.floor(o.bb.z0 / CELL); j <= Math.floor(o.bb.z1 / CELL); j++) {
      const k = cellKey(i, j);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(idx);
    }
});
for (const p of parts) {
  const [cx, cz] = interiorPoint(p.poly.outer);
  const cand = grid.get(cellKey(Math.floor(cx / CELL), Math.floor(cz / CELL))) || [];
  let best = null;
  for (const idx of cand) {
    const o = outlines[idx];
    if (cx < o.bb.x0 || cx > o.bb.x1 || cz < o.bb.z0 || cz > o.bb.z1) continue;
    if (!inRing(cx, cz, o.poly.outer)) continue;
    if (!best || o.area < best.area) best = o;
  }
  if (best) {
    p.parent = best;
    best.partArea += p.area;
  }
}

// ---------- landmarks ----------
// The monuments the game draws as a hand-built model instead of an extruded footprint (src/landmarks.js).
// For each we work out where it stands (the tightest rectangle around its mapped outline) and which mapped
// buildings it replaces.
//   name: the outline's name in the map;  h: height in metres, to the very top;
//   fit: 'smallest' takes the smallest outline of that name for the box (a tower mapped with its podium)
const LANDMARKS = [
  { id: 'hassan', name: /^Tour Hassan$/i, h: 44 },
  { id: 'mausolee', name: /^Mausolée Mohammed V$/i, h: 24 },
  { id: 'tourm6', name: /^(Tour Mohamed VI|Mohammed VI Tower)$/i, h: 250, fit: 'smallest' },
  { id: 'theatre', name: /^Grand Théâtre national de Rabat$/i, h: 27 },
  { id: 'cathedrale', name: /^Cathédrale Saint-Pierre$/i, h: 31 },
];
// Smallest rectangle around a ring: try the direction of every edge and keep the tightest box.
function tightBox(ring) {
  let best = null;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.5) continue;
    const ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, z] of ring) {
      const u = x * ux + z * uz, v = -x * uz + z * ux;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (best && area >= best.area) continue;
    const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
    const long = u1 - u0 >= v1 - v0;
    best = {
      area,
      x: cu * ux - cv * uz, z: cu * uz + cv * ux,
      L: Math.max(u1 - u0, v1 - v0), W: Math.min(u1 - u0, v1 - v0),
      // direction of the long side, as an angle in the x-z plane
      a: long ? Math.atan2(uz, ux) : Math.atan2(ux, -uz),
    };
  }
  return best;
}
const landmarks = [];
for (const def of LANDMARKS) {
  const all = outlines.concat(parts);
  const recs = all.filter((o) => def.name.test(o.t.name || '')).sort((p, q) => q.area - p.area);
  if (!recs.length) {
    console.log(`landmark ${def.id}: no outline found in the map data, skipped`);
    continue;
  }
  const ring = def.fit === 'smallest' ? recs[recs.length - 1].poly.outer : recs[0].poly.outer;
  const box = tightBox(ring);
  landmarks.push({ id: def.id, recs, only: null, out: { id: def.id, x: r1(box.x), z: r1(box.z), L: r1(box.L), W: r1(box.W), a: Math.round(box.a * 1000) / 1000, h: def.h } });
}
// The Hassan Tower stands at the north end of a mosque that was never finished: a field of columns runs
// from it towards the mausoleum. The game needs to know which way.
{
  const tower = landmarks.find((l) => l.id === 'hassan'), tomb = landmarks.find((l) => l.id === 'mausolee');
  const mosque = outlines.find((o) => /^Mosquée Hassan$/i.test(o.t.name || ''));
  if (tower && tomb) {
    const m = mosque ? interiorPoint(mosque.poly.outer) : [tomb.out.x, tomb.out.z];
    const dx = (tomb.out.x + m[0]) / 2 - tower.out.x, dz = (tomb.out.z + m[1]) / 2 - tower.out.z, len = Math.hypot(dx, dz);
    tower.out.ax = [Math.round((dx / len) * 1000) / 1000, Math.round((dz / len) * 1000) / 1000];
    tower.out.run = r1(len);
  }
}
const landmarkOf = (rec) => {
  for (let i = 0; i < landmarks.length; i++) {
    if (landmarks[i].only) {
      if (landmarks[i].only.has(rec)) return i;
      continue;
    }
    const [cx, cz] = interiorPoint(rec.poly.outer);
    for (const o of landmarks[i].recs) {
      if (rec === o || rec.parent === o) return i;
      if (cx >= o.bb.x0 && cx <= o.bb.x1 && cz >= o.bb.z0 && cz <= o.bb.z1 && inRing(cx, cz, o.poly.outer)) return i;
    }
  }
  return -1;
};

// ---------- the look and shape of ordinary buildings ----------
// The map gives most buildings an outline and a height and nothing more. Each one is given a facade
// style here (the game's building shader draws it).
//   st: 0 rendered masonry with tall windows (the ville nouvelle), 1 low house, 2 stepped tower,
//       3 glass curtain wall, 4 ribbon windows (modern offices and flats), 5 dark metal-and-glass grid,
//       6 rampart (no windows, battlements), 7 old-town house (blank lime-washed walls, few small windows)
function styleOf(c, g, h, seed, old) {
  const k = hash(seed * 5 + 3);
  if (g) return h < 40 && k < 0.5 ? 4 : 3;
  if (old) return 7;
  if (h < 10.5) return 1;
  if (h < 60) return k < 0.3 ? 4 : 0;
  return k < 0.5 ? 4 : 2;
}
function hullArea(ring) {
  const pts = ring.map((p) => [p[0], p[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list) => {
    const out = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return Math.abs(area(half(pts).concat(half(pts.slice().reverse()))));
}
// The ring moved inwards by d on every side, or null if it does not survive that.
function inset(ring, d) {
  const n = ring.length, a0 = area(ring), sign = Math.sign(a0);
  if (!sign || n < 3) return null;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    const ex = q[0] - p[0], ez = q[1] - p[1], len = Math.hypot(ex, ez);
    if (len < 0.3) continue;
    // the inward side of an edge depends on which way round the ring goes
    const nx = (-ez / len) * sign, nz = (ex / len) * sign;
    lines.push({ x: p[0] + nx * d, z: p[1] + nz * d, ex: ex / len, ez: ez / len, len });
  }
  if (lines.length < 3) return null;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const a = lines[(i + lines.length - 1) % lines.length], b = lines[i];
    const den = a.ex * b.ez - a.ez * b.ex;
    if (Math.abs(den) < 0.05) out.push([b.x, b.z]);
    else {
      const t = ((b.x - a.x) * b.ez - (b.z - a.z) * b.ex) / den;
      out.push([a.x + a.ex * t, a.z + a.ez * t]);
    }
  }
  const a1 = area(out);
  if (Math.sign(a1) !== sign || Math.abs(a1) < Math.abs(a0) * 0.12 || Math.abs(a1) >= Math.abs(a0)) return null;
  // no side may have turned round or all but vanished
  for (let i = 0; i < out.length; i++) {
    const p = out[i], q = out[(i + 1) % out.length], l = lines[i];
    if ((q[0] - p[0]) * l.ex + (q[1] - p[1]) * l.ez < Math.min(1.5, l.len * 0.25)) return null;
  }
  return out;
}
const COPPER = [0x6f9a8a, 0x7f8f78, 0xb09a5a, 0x5f6f6a, 0x8c8478];
function massing(ring, h, st, seed) {
  const a = Math.abs(area(ring));
  if (st > 5 || h < 45 || ring.length > 12 || a < 260 || a / hullArea(ring) < 0.9) return null;
  const W = tightBox(ring).W;
  if (W < 14) return null;
  const k = (i) => hash(seed * 13 + i * 7.7);
  const tiers = [];
  if (st === 2 || st === 0) {
    const steps = st === 2 ? (h > 180 ? 3 : 2) + (k(1) < 0.35 ? 1 : 0) : h >= 60 && k(1) < 0.55 ? 1 : 0;
    if (!steps) return null;
    let at = h * (st === 2 ? 0.46 + 0.16 * k(2) : 0.68 + 0.14 * k(2)), cur = ring, base = 0;
    const each = Math.min(W * (0.07 + 0.05 * k(3)), 7);
    for (let i = 0; i < steps; i++) {
      const next = inset(cur, each * (1 + 0.25 * i));
      if (!next) break;
      tiers.push({ ring: cur, m: base, h: at, nr: 1 });
      base = at;
      cur = next;
      at += (h - at) * (i === steps - 2 ? 1 : 0.42 + 0.2 * k(4 + i));
    }
    if (!tiers.length) return null;
    const last = { ring: cur, m: base, h };
    if (st === 2 && k(9) < 0.45) {
      last.r = Math.min(tightBox(cur).W * (0.5 + 0.5 * k(10)), (h - base) * 0.5);
      last.rc = COPPER[Math.floor(k(11) * COPPER.length)];
    }
    tiers.push(last);
    return tiers;
  }
  if (h < 70) return null;
  let cur = ring, base = 0;
  if (a > 1100 && k(1) < 0.6) {
    const next = inset(cur, Math.min(W * (0.08 + 0.1 * k(3)), 9));
    if (next) {
      tiers.push({ ring: cur, m: 0, h: 16 + 14 * k(2), nr: 1 });
      base = tiers[0].h;
      cur = next;
    }
  }
  if (h > 150 && k(4) < 0.5) {
    const next = inset(cur, Math.min(W * 0.07, 5));
    if (next) {
      const at = h * (0.62 + 0.18 * k(5));
      tiers.push({ ring: cur, m: base, h: at, nr: 1 });
      base = at;
      cur = next;
    }
  }
  const crown = 6 + 6 * k(6), screen = inset(cur, 1.2 + 1.5 * k(7));
  if (screen && h - base > crown * 3) {
    tiers.push({ ring: cur, m: base, h: h - crown, nr: 1 });
    tiers.push({ ring: screen, m: h - crown, h, cr: 1 });
  } else tiers.push({ ring: cur, m: base, h });
  return tiers.length > 1 ? tiers : null;
}

const buildings = [];
const places = [];
const mosques = new Set();
let skippedOutlines = 0, shaped = 0;
const flat = (ring) => {
  const out = [];
  for (const [x, z] of ring) out.push(r1(x), r1(z));
  return out;
};
function emit(rec, isPart) {
  const t = rec.t;
  const pt = rec.parent ? rec.parent.t : {};
  const seedId = rec.parent ? rec.parent.id : rec.id;
  let h = num(t.height);
  const levels = num(t['building:levels']);
  if (!(h > 0)) h = levels > 0 ? levels * FLOOR + 1.5 : isPart ? 10 : 6.5 + hash(rec.id) * 6;
  let mh = num(t.min_height);
  if (!(mh >= 0)) {
    const ml = num(t['building:min_level']);
    mh = ml > 0 ? ml * FLOOR : 0;
  }
  if (h > 600) h = 600;
  if (h <= mh + 0.5) h = mh + 3;

  const material = (t['building:material'] || pt['building:material'] || '').toLowerCase();
  let c = parseColour(t['building:colour'] || t['building:color'] || pt['building:colour'] || pt['building:color']);
  let g = material === 'glass' || material === 'mirror' || material === 'metal' ? 1 : 0;
  const [ox, oz] = interiorPoint(rec.poly.outer);
  const old = oldTown(ox, oz) && h < 14;
  if (c == null) {
    const fb = fallbackColour(seedId, rec.parent ? num(pt.height) || h : h, material, old);
    c = fb.c;
    g = fb.g;
  }
  const out = { p: flat(rec.poly.outer), h: r1(h), c: tame(c), s: Math.floor(hash(seedId) * 1000) };
  // one style for a whole building, however many parts it is mapped in
  out.st = styleOf(out.c, g, rec.parent ? Math.max(num(pt.height) || 0, h) : h, seedId, old);
  // a mosque gets its minaret in the game (src/roofs.js); one per building, on its largest piece
  const kind = `${t.building || ''} ${t.name || ''} ${t['name:ar'] || ''}`;
  if (!isPart && rec.area > 120 && /mosque|mosqu[ée]e|masjid|مسجد|جامع/i.test(kind) && !mosques.has(seedId)) {
    mosques.add(seedId);
    out.mq = 1;
    out.rc = 0x4f8a66; // green glazed tiles
  }
  if (old && KASBAH && (ox - KASBAH.x) ** 2 + (oz - KASBAH.z) ** 2 < KASBAH.r * KASBAH.r) out.kb = 1; // blue-footed walls
  if (isPart) out.pt = 1;
  if (rec.poly.holes.length) out.o = rec.poly.holes.map(flat);
  if (mh > 0) out.m = r1(mh);
  if (g) out.g = 1;
  const rc = parseColour(t['roof:colour'] || t['roof:color']);
  if (rc != null) out.rc = tame(rc);
  const shape = t['roof:shape'];
  if (shape === 'pyramidal' || shape === 'dome' || shape === 'cone' || shape === 'onion') {
    let rh = num(t['roof:height']);
    if (!(rh > 0)) rh = Math.min((h - mh) * 0.4, Math.sqrt(rec.area) * 0.6);
    rh = Math.min(rh, h - mh);
    if (rh > 0.5) out.r = r1(rh);
  }
  const lm = landmarkOf(rec);
  if (lm >= 0) out.lm = lm; // part of landmark number lm
  // a plain tall outline: give it the massing of its kind
  const plain = !isPart && !rec.partArea && !(mh > 0) && !rec.poly.holes.length && lm < 0 && !shape;
  const tiers = plain ? massing(rec.poly.outer, h, out.st, seedId) : null;
  if (!tiers) {
    buildings.push(out);
    return;
  }
  shaped++;
  for (const tier of tiers) {
    const piece = { ...out, p: flat(tier.ring), h: r1(tier.h), t: r1(h) };
    if (tier.m > 0) piece.m = r1(tier.m);
    if (tier.nr) piece.nr = 1; // a terrace, not a roof: no plant rooms or water towers on it
    if (tier.cr) piece.cr = 1; // the screened plant floors at the top
    if (tier.r) {
      piece.r = r1(tier.r);
      piece.rc = tier.rc;
    }
    buildings.push(piece);
  }
}
for (const o of outlines) {
  const [cx, cz] = interiorPoint(o.poly.outer);
  if (o.t.name) {
    const place = { n: o.t.name, x: r1(cx), z: r1(cz), h: r1(num(o.t.height) || 0) };
    if (o.t['name:ar']) place.ar = o.t['name:ar'];
    if (!/^(\d+|IMM|habitat|residentiel|banque|administration|Batiment \d+|Bâtiment \w)$/i.test(o.t.name)) places.push(place);
  }
  if (o.partArea >= o.area * 0.3) {
    skippedOutlines++;
    continue;
  }
  emit(o, false);
}
for (const p of parts) emit(p, true);

// Ramparts: the Almohad and Andalusian walls, the Kasbah, the Chellah. The download gives them as thick
// outlines already opened where streets pass through; here they become buildings of their own style.
{
  const RAMPART = [0xb9774f, 0xb57048, 0xc08258, 0xae6c47];
  let count = 0;
  for (const el of rawX) {
    const t = el.tags || {};
    if (t.barrier !== 'city_wall') continue;
    for (const poly of polysOf(el)) {
      const [mx, mz] = interiorPoint(poly.outer);
      if (mx < BOUNDS.x0 - 40 || mx > BOUNDS.x1 + 40 || mz < BOUNDS.z0 - 40 || mz > BOUNDS.z1 + 40) continue;
      const seed = Math.floor(hash(el.id * 31 + count) * 1000);
      const out = { p: flat(poly.outer), h: r1(num(t.height) || 9), c: RAMPART[Math.floor(hash(el.id) * RAMPART.length)], s: seed, st: 6, nr: 1 };
      if (poly.holes.length) out.o = poly.holes.map(flat);
      buildings.push(out);
      count++;
    }
  }
  console.log(`ramparts: ${count} pieces`);
}

// ---------- roads ----------
const VEH = {
  motorway: 11, motorway_link: 6.5, trunk: 11, trunk_link: 6.5, primary: 10, primary_link: 6.5, secondary: 10,
  secondary_link: 6.5, tertiary: 9, tertiary_link: 6, residential: 7.5, unclassified: 7.5, living_street: 5,
  service: 4.5, busway: 7,
};
const FOOT = { footway: 2.4, pedestrian: 4, path: 1.8, cycleway: 2.2, steps: 2.2 };
const nodeKey = (g) => `${g.lat},${g.lon}`;
const roadBox = grow(BOUNDS, 250);
const roadWays = [];
const plazas = [];
for (const el of rawR) {
  const t = el.tags || {};
  const hw = t.highway;
  const veh = VEH[hw] != null;
  if (!veh && FOOT[hw] == null) continue;
  if (t.tunnel && t.tunnel !== 'no' && t.tunnel !== 'building_passage') continue;
  if (num(t.layer) < 0 || num(t.level) < 0 || t.indoor === 'yes' || t.location === 'underground') continue;
  if (t.access === 'no' && hw === 'service') continue;
  if (t.area === 'yes') {
    if (isClosed(el.geometry)) {
      const outer = toRing(el.geometry);
      if (outer.length >= 3) plazas.push({ k: 'plaza', poly: { outer, holes: [] } });
    }
    continue;
  }
  let kind = veh ? 0 : 1;
  if (!veh && t.footway === 'crossing') kind = 2;
  let w;
  if (veh) {
    const lanes = num(t.lanes);
    w = Math.max(VEH[hw], lanes > 0 ? lanes * 3.3 + 2 : 0);
    const tw = num(t.width);
    if (tw > 2 && tw < 40) w = Math.max(w * 0.7, tw);
  } else {
    w = FOOT[hw];
    if (t.footway === 'sidewalk') w = 3.6;
    if (kind === 2) w = 3.6;
    const tw = num(t.width);
    if (tw > 0.8 && tw < 30) w = tw;
  }
  {
    // the lanes of the old towns are a few metres wide, whatever their class says
    const g = el.geometry[Math.floor(el.geometry.length / 2)];
    if (oldTown(X(g.lon), Z(g.lat))) w = veh ? Math.min(w, hw === 'residential' || hw === 'living_street' || hw === 'service' ? 3.6 : w) : Math.min(w, 3);
  }
  const bridge = t.bridge && t.bridge !== 'no';
  const layer = bridge ? Math.min(Math.max(num(t.layer) || 1, 1), 5) : 0;
  // What traffic needs: direction, lane count, and a coarse class
  // (0 highway, 1 avenue / main street, 2 side street, 3 service lane).
  let oneway = false, cls = 3, lanes = 1;
  if (veh) {
    const o = t.oneway;
    if (o === 'yes' || o === 'true' || o === '1') oneway = true;
    else if (o === '-1' || o === 'reverse') {
      oneway = true;
      el.geometry = el.geometry.slice().reverse();
    } else if (o !== 'no' && (hw === 'motorway' || hw === 'motorway_link' || t.junction === 'roundabout')) oneway = true;
    cls = /^(motorway|trunk)/.test(hw) ? 0 : /^(primary|secondary)/.test(hw) ? 1 : hw === 'service' || hw === 'busway' ? 3 : 2;
    const tagged = num(t.lanes);
    lanes = tagged > 0 ? Math.min(Math.round(tagged), 8) : cls === 0 ? (oneway ? 3 : 4) : cls === 1 ? (oneway ? 3 : 4) : cls === 2 ? (oneway ? 1 : 2) : 1;
  }
  // a lane too narrow for two cars to pass has no parking and one lane each way at most
  if (veh && w < 5) { cls = 3; lanes = 1; }
  roadWays.push({ el, kind, w, bridge, layer, name: t.name, hw, oneway, cls, lanes });
}

// Bridge heights: vehicle bridges ramp up from wherever they touch a ground-level road.
// The map's "layer" is only a stacking order, not a height; 7 m per layer looks about right here.
const SLOPE = 0.06, LAYER_H = 7;
const groundNodes = new Set();
for (const r of roadWays) if (!r.bridge && r.kind === 0) for (const g of r.el.geometry) groundNodes.add(nodeKey(g));
const adj = new Map();
const cap = new Map();
for (const r of roadWays) {
  if (!r.bridge || r.kind !== 0) continue;
  const gs = r.el.geometry;
  for (let i = 0; i < gs.length; i++) {
    const k = nodeKey(gs[i]);
    cap.set(k, Math.max(cap.get(k) || 0, r.layer * LAYER_H));
    if (!adj.has(k)) adj.set(k, []);
    if (i > 0) {
      const k0 = nodeKey(gs[i - 1]);
      const d = Math.hypot(X(gs[i].lon) - X(gs[i - 1].lon), Z(gs[i].lat) - Z(gs[i - 1].lat));
      adj.get(k).push([k0, d]);
      adj.get(k0).push([k, d]);
    }
  }
}
const dist = new Map();
{
  const queue = [];
  for (const k of adj.keys()) if (groundNodes.has(k)) { dist.set(k, 0); queue.push(k); }
  // Small graph: a simple label-correcting pass is plenty.
  while (queue.length) {
    const k = queue.shift();
    const d = dist.get(k);
    for (const [n, w] of adj.get(k)) {
      if (d + w < (dist.get(n) ?? Infinity) - 1e-6) {
        dist.set(n, d + w);
        queue.push(n);
      }
    }
  }
}
const roads = [];
for (const r of roadWays) {
  const gs = r.el.geometry;
  let run = null;
  const flush = () => {
    if (run && run.p.length >= 4) roads.push(run);
    run = null;
  };
  for (const g of gs) {
    const x = X(g.lon), z = Z(g.lat);
    if (x < roadBox.x0 || x > roadBox.x1 || z < roadBox.z0 || z > roadBox.z1) { flush(); continue; }
    if (!run) {
      run = { k: r.kind, w: r1(r.w), p: [] };
      if (r.kind === 0) {
        run.c = r.cls;
        run.l = r.lanes;
        if (r.oneway) run.o = 1;
      }
      if (r.name) run.n = r.name;
      if (r.bridge) run.y = [];
    }
    run.p.push(r1(x), r1(z));
    if (r.bridge) {
      let y = r.layer * LAYER_H;
      if (r.kind === 0) {
        const k = nodeKey(g);
        y = Math.min(SLOPE * (dist.get(k) ?? Infinity), cap.get(k) ?? y);
      }
      run.y.push(r1(y));
    }
  }
  flush();
}

// ---------- areas (parks, water, piers, plazas) ----------
const areaBox = grow(BOUNDS, 300);
const waterBox = grow(BOUNDS, 3500);
const areas = [];
const kindOf = (t) => {
  if (t.natural === 'water') return 'water';
  if (t.natural === 'beach') return 'sand';
  if (t.landuse === 'cemetery') return 'cemetery';
  if (t.place === 'square') return 'plaza';
  if (t.natural === 'wetland') return 'grass';
  if (t.man_made === 'pier') return 'pier';
  if (t.leisure === 'park') return 'park';
  if (t.leisure === 'garden') return 'garden';
  if (t.leisure === 'pitch') return 'pitch';
  if (t.leisure === 'playground' || t.leisure === 'dog_park') return 'play';
  if (t.natural === 'wood' || t.natural === 'scrub' || t.landuse === 'forest') return 'wood';
  if (t.landuse) return 'grass';
  return null;
};
const scatterSrc = [];
function addArea(k, poly) {
  const box = k === 'water' || k === 'sand' ? waterBox : areaBox;
  const bb = bboxOf(poly.outer);
  if (!overlaps(bb, box)) return;
  const inside = bb.x0 >= box.x0 && bb.x1 <= box.x1 && bb.z0 >= box.z0 && bb.z1 <= box.z1;
  const outer = inside ? poly.outer : clipRing(poly.outer, box);
  if (outer.length < 3 || Math.abs(area(outer)) < 6) return;
  const holes = poly.holes.map((h) => (inside ? h : clipRing(h, box))).filter((h) => h.length >= 3);
  const rec = { k, p: flat(outer) };
  if (holes.length) rec.o = holes.map(flat);
  areas.push(rec);
  scatterSrc.push({ k, poly: { outer, holes }, bb: bboxOf(outer), area: Math.abs(area(outer)) });
}
for (const el of rawN) {
  if (el.type === 'node') continue;
  const t = el.tags || {};
  const k = kindOf(t);
  if (!k) continue;
  for (const poly of polysOf(el)) addArea(k, poly);
}
for (const pz of plazas) addArea('plaza', pz.poly);

// ---------- more places to search for ----------
const named = new Set(places.map((p) => p.n));
const addPlace = (n, ar, x, z, extra = {}) => {
  if (!n || named.has(n) || x < BOUNDS.x0 || x > BOUNDS.x1 || z < BOUNDS.z0 || z > BOUNDS.z1) return;
  named.add(n);
  places.push({ n, ...(ar ? { ar } : {}), x: r1(x), z: r1(z), h: 0, ...extra });
};
// named parks, squares, beaches and cemeteries
for (const el of rawN) {
  const t = el.tags || {};
  if (!t.name || /^espace vert$/i.test(t.name)) continue;
  if (el.type === 'node') {
    if (t.place === 'named') addPlace(t.name, t['name:ar'], X(el.lon), Z(el.lat));
    continue;
  }
  if (!(t.leisure === 'park' || t.leisure === 'garden' || t.place === 'square' || t.natural === 'beach' || t.landuse === 'cemetery')) continue;
  const poly = polysOf(el)[0];
  if (!poly) continue;
  const ring = clipRing(poly.outer, BOUNDS);
  if (ring.length < 3 || Math.abs(area(ring)) < 400) continue;
  const [cx, cz] = interiorPoint(ring);
  addPlace(t.name, t['name:ar'], cx, cz);
}
// gates, bridges, viewpoints
for (const el of rawX) if (el.type === 'node' && el.tags?.place === 'named') addPlace(el.tags.name, el.tags['name:ar'], X(el.lon), Z(el.lat));
// well-known spots that are not a single mapped thing (star: 1 puts them first in the search)
for (const [n, ar, lat, lon] of [
  ['Kasbah des Oudayas', 'قصبة الأوداية', 34.0312, -6.8362],
  ['Médina de Rabat', 'المدينة العتيقة', 34.0262, -6.8372],
  ['Rue des Consuls', 'زنقة القناصل', 34.0277, -6.8331],
  ['Avenue Mohammed V', 'شارع محمد الخامس', 34.0188, -6.8352],
  ['Chellah', 'شالة', 34.0068, -6.8209],
  ['Palais Royal (Dar al-Makhzen)', 'القصر الملكي', 34.0057, -6.8330],
  ['Esplanade de la Tour Hassan', 'ساحة صومعة حسان', 34.0234, -6.8222],
  ['Marina Bouregreg', 'مارينا أبي رقراق', 34.0296, -6.8226],
  ['Embouchure du Bouregreg', 'مصب أبي رقراق', 34.0350, -6.8375],
  ['Médina de Salé', 'مدينة سلا العتيقة', 34.0385, -6.8225],
  ['Agdal', 'أكدال', 34.0015, -6.8480],
  ["Quartier de l'Océan", 'حي المحيط', 34.0215, -6.8475],
  ['Quartier Hassan', 'حي حسان', 34.0200, -6.8270],
  ['Bab El Had', 'باب الحد', 34.0219, -6.8404],
  ['Jardin d\'Essais Botaniques', 'حديقة التجارب', 34.0130, -6.8440],
]) {
  named.delete(n);
  addPlace(n, ar, X(lon), Z(lat), { star: 1 });
}
for (const p of places) if (/^(Tour Hassan|Mausolée Mohammed V|Tour Mohamed VI|Grand Théâtre national de Rabat|Cathédrale Saint-Pierre|Gare Rabat Ville|Parlement|Mosquée Assounna|Théâtre National Mohammed V|Musée des Oudayas|Bab Rouah|Pont Hassan II)$/i.test(p.n)) p.star = 1;
const ORDER = ['sand', 'cemetery', 'park', 'grass', 'garden', 'wood', 'pitch', 'play', 'water', 'pier', 'plaza'];
areas.sort((a, b) => ORDER.indexOf(a.k) - ORDER.indexOf(b.k));

// ---------- tram and railway ----------
const rails = [];
for (const el of rawX) {
  const t = el.tags || {};
  if (!t.railway) continue;
  let run = null;
  const flush = () => {
    if (run && run.p.length >= 4) rails.push(run);
    run = null;
  };
  for (const g of el.geometry) {
    const x = X(g.lon), z = Z(g.lat);
    if (x < roadBox.x0 || x > roadBox.x1 || z < roadBox.z0 || z > roadBox.z1) { flush(); continue; }
    if (!run) run = { k: t.railway === 'tram' ? 0 : 1, p: [] };
    run.p.push(r1(x), r1(z));
  }
  flush();
}

// ---------- trees ----------
const trees = [];
const treeBox = grow(BOUNDS, 100);
for (const el of rawN) {
  if (el.type !== 'node' || el.tags?.natural !== 'tree') continue;
  const x = X(el.lon), z = Z(el.lat);
  trees.push(r1(x), r1(z), Math.round((0.75 + hash(el.id) * 0.55) * 100) / 100);
}
const mappedTrees = trees.length / 3;
// The rest of the city's trees are planted by rule (tools/plant-trees.mjs): rows along the kerbs,
// woods, groves and path-side rows in the parks, with the lawns left open.
const planted = plantTrees(
  { buildings, roads, areas, meta: { bounds: { x0: r1(BOUNDS.x0), x1: r1(BOUNDS.x1), z0: r1(BOUNDS.z0), z1: r1(BOUNDS.z1) } } },
  trees.slice(),
  // Manhattan lines nearly every kerb with trees; Rabat's avenues are planted, its lanes are not
  { seed: 7, density: 0.4 },
);
for (let i = 0; i < planted.length; i += 3) trees.push(r1(planted[i]), r1(planted[i + 1]), Math.round(planted[i + 2] * 100) / 100);

// ---------- write ----------
const city = {
  meta: {
    name: AREA.name,
    lat0, lon0, mx: MX, mz: MZ,
    bounds: { x0: r1(BOUNDS.x0), x1: r1(BOUNDS.x1), z0: r1(BOUNDS.z0), z1: r1(BOUNDS.z1) },
    spawn: { x: r1(X(AREA.spawn.lon)), z: r1(Z(AREA.spawn.lat)), y: AREA.spawn.alt, yaw: AREA.spawn.yaw || 0 },
    attribution: '© OpenStreetMap contributors · Overture Maps Foundation',
    // which way the open ocean lies (degrees from north) and how far from the centre it is all water
    sea: AREA.sea,
  },
  buildings, roads, rails, areas, trees, places,
  // the city beyond the play area: blocks as [x, z, long side, short side, angle, height], and main roads
  outer: { boxes: rawOuter.boxes.flat(), roads: rawOuter.roads },
  landmarks: landmarks.map((l) => l.out),
};
const OUT = join(HERE, '..', 'data');
await mkdir(OUT, { recursive: true });
const json = JSON.stringify(city);
await writeFile(join(OUT, 'city.json'), json);
const count = (arr, f) => arr.reduce((m, e) => ((m[f(e)] = (m[f(e)] || 0) + 1), m), {});
console.log(`buildings: ${buildings.length} (${outlines.length} outlines, ${parts.length} parts, ${skippedOutlines} outlines replaced by parts)`);
console.log(`roads: ${roads.length}`, count(roads, (r) => ['vehicle', 'foot', 'crossing'][r.k]), `elevated: ${roads.filter((r) => r.y).length}`);
console.log('areas:', count(areas, (a) => a.k));
console.log(`trees: ${trees.length / 3} (${mappedTrees} mapped, ${planted.length / 3} planted)`);
console.log(`places: ${places.length}`);
console.log("landmarks:", landmarks.map((l) => `${l.id} ${l.out.L}x${l.out.W}x${l.out.h} m, ${buildings.filter((b) => b.lm === landmarks.indexOf(l)).length} OSM pieces`).join("; "));
console.log(`tallest: ${Math.max(...buildings.map((b) => b.h))} m`);
console.log(`styles: ${[0, 1, 2, 3, 4, 5, 6, 7].map((k) => buildings.filter((b) => b.st === k).length).join(', ')}; ${shaped} tall outlines given setbacks, podiums or crowns`);
console.log(`rails: ${rails.length}; mosques: ${mosques.size}`);
console.log(`rabat/data/city.json: ${(json.length / 1e6).toFixed(2)} MB`);
