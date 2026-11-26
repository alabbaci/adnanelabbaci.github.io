// Planting for the flat city export. Coordinates and all clearances are in metres.
// From tools/plant-trees.mjs of manhattan-free-roam (MIT, see ../LICENSE), with its Midtown-only anchors emptied.

const clamp = (x, lo, hi) => Math.max(lo, Math.min(x, hi));
const round = (x, places) => Math.round(x * places) / places;
const square = (x) => x * x;
const pointKey = (x, z) => `${x},${z}`;
// Pack local grid coordinates with room for over 67 million rows.
const cellKey = (x, z) => x * 0x4000000 + z;

function random(seed, x, z, salt = 0) {
  let h = seed ^ Math.imul(x, 0x9e3779b1) ^ Math.imul(z, 0x85ebca77) ^ Math.imul(salt, 0xc2b2ae3d);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

class Grid {
  constructor(cell) {
    this.cell = cell;
    this.cells = new Map();
  }

  insert(item, x0, z0, x1 = x0, z1 = z0) {
    const c = this.cell;
    for (let x = Math.floor(x0 / c); x <= Math.floor(x1 / c); x++) {
      for (let z = Math.floor(z0 / c); z <= Math.floor(z1 / c); z++) {
        const key = cellKey(x, z);
        let list = this.cells.get(key);
        if (!list) this.cells.set(key, (list = []));
        list.push(item);
      }
    }
  }

  key(x, z) {
    return cellKey(Math.floor(x / this.cell), Math.floor(z / this.cell));
  }

  at(x, z) {
    return this.cells.get(this.key(x, z)) ?? [];
  }
}

function boundsOf(p) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]);
    z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]);
  }
  return { x0, z0, x1, z1 };
}

function polygonArea(p) {
  let sum = 0;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    sum += p[j] * p[i + 1] - p[i] * p[j + 1];
  }
  return Math.abs(sum) / 2;
}

function inRing(x, z, p) {
  let inside = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const zi = p[i + 1], zj = p[j + 1];
    if (zi > z !== zj > z && x < p[i] + (p[j] - p[i]) * (z - zi) / (zj - zi)) inside = !inside;
  }
  return inside;
}

const inPolygon = (x, z, a) =>
  x >= a.x0 && x <= a.x1 && z >= a.z0 && z <= a.z1 &&
  inRing(x, z, a.p) && !a.o?.some((p) => inRing(x, z, p));

function segment(x, z, bx, bz) {
  const length = Math.hypot(bx - x, bz - z);
  return { x, z, bx, bz, length, ux: (bx - x) / (length || 1), uz: (bz - z) / (length || 1) };
}

const along = (x, z, s) => (x - s.x) * s.ux + (z - s.z) * s.uz;
const across = (x, z, s) => (z - s.z) * s.ux - (x - s.x) * s.uz;

function segmentDistanceSq(x, z, s) {
  const d = clamp(along(x, z, s), 0, s.length);
  return square(x - s.x - d * s.ux) + square(z - s.z - d * s.uz);
}

function edges(p) {
  const result = [];
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    result.push(segment(p[j], p[j + 1], p[i], p[i + 1]));
  }
  return result;
}

const nearEdges = (x, z, border, radius) => border.some((s) => segmentDistanceSq(x, z, s) <= radius * radius);

function indexPolygon(grid, a, margin = 0) {
  grid.insert(a, a.x0 - margin, a.z0 - margin, a.x1 + margin, a.z1 + margin);
}

function indexSegment(grid, s, margin) {
  grid.insert(s, Math.min(s.x, s.bx) - margin, Math.min(s.z, s.bz) - margin,
    Math.max(s.x, s.bx) + margin, Math.max(s.z, s.bz) + margin);
}

function isRaised(r) {
  // The export omits tunnels entirely and adds a height profile to every bridge, even its ramps.
  return r.y != null || r.bridge === true || r.tunnel === true;
}

function streetKind(r) {
  if (r.k !== 0 || (r.c !== 1 && r.c !== 2) || isRaised(r)) return null;
  if (/\bAvenue\b|\bBroadway\b|\bBoulevard\b/i.test(r.n ?? '')) return 'avenue';
  if (/^(?:East|West) \d+(?:st|nd|rd|th) Street$/i.test(r.n ?? '') && r.w < 16) return 'side street';
  return r.c === 1 ? 'avenue' : 'side street';
}

function makeRoadNetwork(roads) {
  const index = new Grid(16);
  const medianRoads = new Grid(38);
  const nodes = new Map();
  const streetSegments = [];
  const paths = [];
  const mitres = new Grid(22);
  const node = (x, z) => {
    const key = pointKey(x, z);
    let n = nodes.get(key);
    if (!n) nodes.set(key, (n = []));
    return n;
  };

  for (const r of roads) {
    const kind = streetKind(r);
    const raised = isRaised(r);
    const segments = [];
    for (let i = 0; i + 3 < r.p.length; i += 2) {
      const s = segment(r.p[i], r.p[i + 1], r.p[i + 2], r.p[i + 3]);
      if (s.length === 0) continue;
      const half = r.w / 2;
      let setback = 0.4;
      if (r.k === 2) setback = 1.75;
      else if (raised) setback = 1.25;
      else if (r.k === 0) setback = r.c === 3 ? 1.8 : 0.65;
      const junction = r.k === 0 && r.c !== 3 && !raised;
      const reach = half + (junction ? 3.4 : setback);
      const x0 = Math.min(s.x, s.bx) - reach, x1 = Math.max(s.x, s.bx) + reach;
      const z0 = Math.min(s.z, s.bz) - reach, z1 = Math.max(s.z, s.bz) + reach;
      Object.assign(s, { r, kind, half, flow: 1, junction, x0, z0, x1, z1, clearance: square(half + setback) });
      index.insert(s, x0, z0, x1, z1);
      if (kind && r.n === 'Park Avenue' && r.o) indexSegment(medianRoads, s, half + 31);
      segments.push(s);
      if (r.k === 0 && r.c !== 3 && !raised) {
        s.a = node(s.x, s.z);
        s.b = node(s.bx, s.bz);
        s.a.push(s);
        s.b.push(s);
      }
      if (kind) streetSegments.push(s);
    }
    if (r.k === 1 && !raised && segments.length) paths.push({ r, segments });
    // Extra coverage where the rendered road ribbon extends outside the round centreline buffer.
    for (let i = 1; i < segments.length; i++) {
      const a = segments[i - 1], b = segments[i];
      const dot = a.ux * b.ux + a.uz * b.uz;
      if (dot > 0.995 || dot < -0.999999) continue;
      const norm = Math.hypot(a.ux + b.ux, a.uz + b.uz);
      const tx = (a.ux + b.ux) / norm, tz = (a.uz + b.uz) / norm;
      const width = b.half * Math.min(2.2, 1 / Math.max(tx * b.ux + tz * b.uz, 0.4));
      const turn = Math.sign(a.ux * b.uz - a.uz * b.ux);
      const p = [
        b.x + turn * a.uz * b.half, b.z - turn * a.ux * b.half,
        b.x + turn * tz * width, b.z - turn * tx * width,
        b.x + turn * b.uz * b.half, b.z - turn * b.ux * b.half,
      ];
      indexPolygon(mitres, { p, ...boundsOf(p), border: edges(p) }, 0.45);
    }
  }

  const continuation = (s, end) => {
    const n = end ? s.b : s.a;
    if (n.length !== 2) return null;
    const other = n[0] === s ? n[1] : n[0];
    if (!other.kind || s.r.n !== other.r.n || s.kind !== other.kind) return null;
    const direction = (other.a === n) === end ? 1 : -1;
    return direction * (s.ux * other.ux + s.uz * other.uz) >= 0.6 ? other : null;
  };

  // Continue through shape vertices and OSM way splits. A branching road starts a new block.
  const visited = new Set();
  const blocks = [];
  const trace = (first, forward) => {
    const run = [];
    let s = first;
    while (s && !visited.has(s)) {
      visited.add(s);
      run.push(forward ? s : { ...s, ...segment(s.bx, s.bz, s.x, s.z), flow: -1 });
      const next = continuation(s, forward);
      forward = next?.a === (forward ? s.b : s.a);
      s = next;
    }
    blocks.push(run);
  };
  for (const s of streetSegments) {
    if (visited.has(s)) continue;
    if (!continuation(s, false)) trace(s, true);
    else if (!continuation(s, true)) trace(s, false);
  }
  for (const s of streetSegments) if (!visited.has(s)) trace(s, true);
  return { index, medianRoads, mitres, blocks, paths };
}

function lineSampler(segments) {
  const length = segments.reduce((sum, s) => sum + s.length, 0);
  let i = 0, start = 0;
  return {
    length,
    at(distance) {
      while (i + 1 < segments.length && distance > start + segments[i].length) start += segments[i++].length;
      return { s: segments[i], t: clamp(distance - start, 0, segments[i].length) };
    },
  };
}

function rotatedBox(p) {
  let best;
  for (const s of edges(p)) {
    if (s.length < 0.5) continue;
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    for (let i = 0; i < p.length; i += 2) {
      const u = p[i] * s.ux + p[i + 1] * s.uz;
      const v = p[i + 1] * s.ux - p[i] * s.uz;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u);
      v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { u0, v0, u1, v1, ux: s.ux, uz: s.uz, area };
  }
  return best;
}

function makeAreaExclusions(polygons) {
  const areas = new Grid(28);
  const borders = new Grid(28);
  for (const a of polygons) {
    if (a.k !== 'water' && a.k !== 'pitch' && a.k !== 'play') continue;
    indexPolygon(areas, a);
    const setback = a.k === 'water' ? 0.7 : 1.05;
    for (const s of a.border) indexSegment(borders, { ...s, area: a, setback }, setback);
  }
  const cache = new Map();
  return (x, z) => {
    const key = areas.key(x, z);
    let cell = cache.get(key);
    if (!cell) {
      // With no edge in this cell, one containment test classifies the entire cell.
      // River polygons span thousands of metres, so most candidates need no ray test.
      const edges = borders.cells.get(key) ?? [];
      const boundaryAreas = new Set(edges.map((s) => s.area));
      const partial = [];
      let full = false;
      for (const a of areas.cells.get(key) ?? []) {
        if (boundaryAreas.has(a)) partial.push(a);
        else if (inPolygon(x, z, a)) { full = true; break; }
      }
      cell = { full, partial, edges };
      cache.set(key, cell);
    }
    return cell.full || cell.partial.some((a) => inPolygon(x, z, a)) ||
      cell.edges.some((s) => segmentDistanceSq(x, z, s) <= square(s.setback));
  };
}

function newSite(city, mapped) {
  const buildings = new Grid(32);
  for (const b of city.buildings) {
    const rec = { ...b, ...boundsOf(b.p), border: [b.p, ...(b.o ?? [])].flatMap(edges) };
    indexPolygon(buildings, rec, 4.6);
  }
  const areas = new Grid(42);
  const shore = new Grid(42);
  const polygons = city.areas.map((a) => ({
    ...a, ...boundsOf(a.p), area: polygonArea(a.p) - (a.o ?? []).reduce((sum, p) => sum + polygonArea(p), 0),
    border: [a.p, ...(a.o ?? [])].flatMap(edges),
  }));
  for (const a of polygons) {
    indexPolygon(areas, a);
    if (a.k === 'water' && a.area > 250000) {
      for (const s of a.border) indexSegment(shore, s, 62);
    }
  }
  const trees = new Grid(8);
  for (let i = 0; i + 2 < mapped.length; i += 3) {
    const [x, z, size] = [mapped[i], mapped[i + 1], mapped[i + 2]];
    trees.insert({ x, z, size, kind: 'mapped' }, x - 6.5, z - 6.5, x + 6.5, z + 6.5);
  }
  return { buildings, areas, shore, polygons, trees,
    excludedArea: makeAreaExclusions(polygons), roads: makeRoadNetwork(city.roads) };
}

function roadBlocked(x, z, roads, owner) {
  for (const s of roads.index.at(x, z)) {
    if (x < s.x0 || x > s.x1 || z < s.z0 || z > s.z1) continue;
    const junction = s.junction && owner && s.r !== owner.r &&
      Math.abs(owner.ux * s.ux + owner.uz * s.uz) < 0.86;
    if (segmentDistanceSq(x, z, s) <= (junction ? square(s.half + 3.4) : s.clearance)) return true;
  }
  return roads.mitres.at(x, z).some((m) => inPolygon(x, z, m) || nearEdges(x, z, m.border, 0.4));
}

const TREE_SIZES = {
  'side street': [0.86, 1.23],
  avenue: [0.78, 1.14],
  median: [0.72, 1.05],
  woodland: [1.16, 1.60],
  lawn: [1.05, 1.52],
  'path row': [0.84, 1.24],
  'formal row': [1.15, 1.44],
  plaza: [0.62, 0.96],
  garden: [0.66, 1.04],
  waterfront: [0.78, 1.19],
};

// Named spots that change how streets are planted around them. The planter this is adapted from knew
// four in Midtown Manhattan (Times Square and its neighbours, kept bare); Rabat has none, so every
// `anchors[...]` lookup below finds nothing and the general rules apply everywhere.
function midtownAnchors() {
  return {};
}

const distanceTo = (x, z, point) => point ? Math.hypot(x - point.x, z - point.z) : Infinity;

function parkAvenuePartner(roadIndex, s, x, z, side) {
  let best = null;
  for (const q of roadIndex.at(x, z)) {
    if (q.r === s.r) continue;
    const denominator = s.ux * q.ux + s.uz * q.uz;
    if (denominator * s.flow > -0.97) continue;
    const offset = -across(x, z, q) / denominator;
    const gap = Math.abs(offset) - s.half - q.half;
    if (side * offset <= 0 || gap < 1.25 || gap > 12 || (best && Math.abs(offset) >= best.offset)) continue;
    const t = along(x - s.uz * offset, z + s.ux * offset, q);
    if (t < -1 || t > q.length + 1) continue;
    best = { offset: Math.abs(offset), center: s.half + gap / 2 };
  }
  return best;
}

function plantStreets(site, anchors, put, seed, boost) {
  for (const block of site.roads.blocks) {
    const first = block[0];
    const kind = first.kind;
    const avenue = kind === 'avenue';
    const sample = lineSampler(block);
    const endGap = avenue ? 8 : 6.5;
    if (sample.length < 2 * endGap + 2) continue;
    const mid = sample.at(sample.length / 2);
    const mx = mid.s.x + mid.t * mid.s.ux, mz = mid.s.z + mid.t * mid.s.uz;
    const bx = Math.round(mx * 2), bz = Math.round(mz * 2);
    const times = distanceTo(mx, mz, anchors['Times Square']);
    const commercial = Math.max(
      clamp(1 - times / 430, 0, 1),
      0.72 * clamp(1 - distanceTo(mx, mz, anchors['Grand Central Terminal']) / 410, 0, 1),
      0.6 * clamp(1 - distanceTo(mx, mz, anchors['Rockefeller Center']) / 340, 0, 1),
    );
    const broad = clamp((mid.s.r.w - 12) / 14, 0, 1);
    const roll = random(seed, bx, bz, 1);
    const bare = (avenue ? 0.10 : 0.045) + commercial * 0.22 + broad * 0.13;
    const sparse = bare + (avenue ? 0.28 : 0.13) + commercial * 0.14;
    const keep = (roll < sparse ? (avenue ? 0.50 : 0.61) : (avenue ? 0.90 : 0.99)) * (1 - 0.45 * commercial - 0.19 * broad);
    const spacing = Math.max(6.4, ((avenue ? 10.6 : 8.25) + 1.6 * broad + 0.9 * commercial) / boost);
    const parkAvenue = mid.s.r.n === 'Park Avenue' && mid.s.r.o;
    const shifts = avenue ? [0] : [0, 1.25, -1.25];
    for (const side of [-1, 1]) {
      const line = lineSampler(block);
      let slot = 0;
      const phase = random(seed, bx, bz, 3 + side);
      const preferred = 1.32 + 0.32 * random(seed, bx, bz, 7 + side);
      const offsets = [preferred, 0.76, 2.05, 2.65, 3.35, 4.05];
      for (let d = endGap + spacing * (0.12 + phase * 0.72); d < line.length - endGap; slot++) {
        const { s, t } = line.at(d);
        d += spacing * (0.84 + 0.32 * random(seed, bx + slot, bz, side + 11));
        const x = s.x + s.ux * t, z = s.z + s.uz * t;
        const partner = parkAvenue ? parkAvenuePartner(site.roads.medianRoads, s, x, z, side) : null;
        if (partner) {
          // Use only one carriageway as the reference for this median row.
          if (-s.uz * side > 0 && random(seed, bx, bz + slot, 68) < 0.91) {
            put(x - s.uz * side * partner.center, z + s.ux * side * partner.center, 'median', s);
          }
          continue;
        }
        if (times < 80 || roll < bare || random(seed, bx + slot, bz, side + 15) > keep) continue;
        if (distanceTo(x, z, anchors['Times Square']) < 82) continue;
        // Shift a missed side-street site a little along the kerb when a path, a driveway
        // or an existing tree takes its usual spot. Keep the lateral line as the first choice.
        for (const shift of shifts) {
          if (t + shift < 0 || t + shift > s.length) continue;
          const planted = offsets.some((offset) => {
            const gap = side * (s.half + offset);
            return put(x + s.ux * shift - s.uz * gap, z + s.uz * shift + s.ux * gap, kind, s);
          });
          if (planted) break;
        }
      }
    }
  }
}

function plantFormalLawn(site, anchors, put, seed, boost) {
  const bryant = anchors['Bryant Park'];
  if (!bryant) return null;
  const nearby = site.areas.at(bryant.x, bryant.z);
  const lawn = nearby.find((a) => a.k === 'grass' && a.area > 1000 && inPolygon(bryant.x, bryant.z, a));
  const park = nearby.find((a) => a.k === 'park' && inPolygon(bryant.x, bryant.z, a));
  if (!lawn || !park) return null;
  const box = rotatedBox(lawn.p);
  const alongU = box.u1 - box.u0 >= box.v1 - box.v0;
  const { ux, uz } = box;
  const [start, end, low, high] = alongU ?
    [box.u0, box.u1, box.v0, box.v1] : [box.v0, box.v1, box.u0, box.u1];
  const spacing = Math.max(7.2, 8.5 / boost);
  for (const side of [-1, 1]) {
    for (let t = start + 3.5; t < end - 2; t += spacing) {
      const lead = t + (random(seed, Math.round(t), side, 70) - 0.5) * 0.85;
      for (const offset of [4.2, 5.8, 7.4, 2.8]) {
        const cross = side < 0 ? low - offset : high + offset;
        const u = alongU ? lead : cross, v = alongU ? cross : lead;
        const x = ux * u - uz * v, z = uz * u + ux * v;
        if (inPolygon(x, z, park) && !inPolygon(x, z, lawn) && put(x, z, 'formal row')) break;
      }
    }
  }
  return park;
}

function plantPaths(site, formalPark, put, seed, boost) {
  for (const { r, segments } of site.roads.paths) {
    const lineLength = segments.reduce((sum, s) => sum + s.length, 0);
    if (lineLength < 23) continue;
    const { x, z } = segments[0];
    const u = Math.round(x), v = Math.round(z);
    const choice = random(seed, u, v, 75);
    if (choice < 0.30 && r.w < 3) continue;
    for (const side of [-1, 1]) {
      const sample = lineSampler(segments);
      const phase = random(seed, u, v, 77 + side);
      const step = Math.max(7.3, (r.w >= 3 ? 10.8 : 12.6) / boost);
      let slot = 0;
      for (let t = 4 + step * phase; t < lineLength - 4; slot++) {
        const { s, t: d } = sample.at(t);
        t += step * (0.87 + 0.26 * random(seed, u + slot, v, 80 + side));
        const offset = (s.half + 2.0) * side;
        const x = s.x + s.ux * d - s.uz * offset, z = s.z + s.uz * d + s.ux * offset;
        const at = site.areas.at(x, z);
        if (formalPark && inPolygon(x, z, formalPark)) continue;
        const shore = nearEdges(x, z, site.shore.at(x, z), 62);
        const greens = at.filter((a) => ['grass', 'wood', 'park', 'garden', 'pier'].includes(a.k) && inPolygon(x, z, a));
        if (greens.some((a) => a.k === 'grass') && !shore) continue;
        if (greens.some((a) => a.k === 'wood') && (r.w < 3 || choice < 0.78)) continue;
        if (!greens.some((a) => a.k === 'park' || a.k === 'garden' || (shore && a.k === 'pier'))) continue;
        const rowThreshold = r.w >= 3 ? 0.25 : side === 1 ? 0.48 : 0.66;
        if (shore || choice > rowThreshold) put(x, z, shore ? 'waterfront' : 'path row', s);
      }
    }
  }
}

function plantPierRows(site, put, seed, boost) {
  const step = Math.max(8, 12.5 / boost);
  for (const pier of site.polygons) {
    if (pier.k !== 'pier' || pier.area < 350) continue;
    for (const s of edges(pier.p)) {
      if (s.length < 24) continue;
      const sx = Math.round(s.x), sz = Math.round(s.z);
      const phase = random(seed, sx, sz, 86);
      for (let t = 5 + 3 * phase; t < s.length - 5; t += step) {
        const d = t + (random(seed, sx, sz + Math.floor(t), 87) - 0.5) * 1.5;
        const x = s.x + s.ux * d, z = s.z + s.uz * d;
        for (const side of [-1, 1]) {
          const px = x - s.uz * side * 3.3, pz = z + s.ux * side * 3.3;
          if (!inPolygon(px, pz, pier) || nearEdges(px, pz, pier.border, 2.25)) continue;
          // Plant leisure piers with mapped green space only where the ground layer is dry.
          if (site.areas.at(px, pz).some((a) => (a.k === 'park' || a.k === 'garden') && inPolygon(px, pz, a))) {
            put(px, pz, 'waterfront');
          }
        }
      }
    }
  }
}

function noise(seed, x, z, scale, salt) {
  const ix = Math.floor(x / scale), iz = Math.floor(z / scale);
  const tx = x / scale - ix, tz = z / scale - iz;
  const u = tx * tx * (3 - 2 * tx), v = tz * tz * (3 - 2 * tz);
  const a = random(seed, ix, iz, salt) * (1 - u) + random(seed, ix + 1, iz, salt) * u;
  const b = random(seed, ix, iz + 1, salt) * (1 - u) + random(seed, ix + 1, iz + 1, salt) * u;
  return a * (1 - v) + b * v;
}

function sampleArea(a, bounds, step, seed, salt, visit) {
  const i0 = Math.floor(Math.max(a.x0, bounds.x0) / step), i1 = Math.floor(Math.min(a.x1, bounds.x1) / step);
  const j0 = Math.floor(Math.max(a.z0, bounds.z0) / step), j1 = Math.floor(Math.min(a.z1, bounds.z1) / step);
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const x = (i + random(seed, i, j, salt)) * step;
      const z = (j + random(seed, i, j, salt + 1)) * step;
      if (inPolygon(x, z, a)) visit(x, z, random(seed, i, j, salt + 2));
    }
  }
}

function plantGreens(site, bounds, formalPark, put, seed, boost) {
  const polygons = site.polygons;
  // A world-aligned jittered sample shares the same sites across overlapping OSM polygons.
  for (const a of polygons) {
    if (a.k !== 'wood' && a.k !== 'park') continue;
    if (a === formalPark) continue;
    const explicit = a.k === 'wood';
    sampleArea(a, bounds, Math.max(3.4, (explicit ? 4.35 : 5.15) / boost), seed, explicit ? 90 : 94, (x, z, pick) => {
      const local = site.areas.at(x, z);
      if (local.some((p) => p !== a && (p.k === 'grass' || p.k === 'garden' || p.k === 'plaza' ||
        (!explicit && p.k === 'wood')) && inPolygon(x, z, p))) return;
      const shore = nearEdges(x, z, site.shore.at(x, z), 62);
      const canopy = 0.75 * noise(seed, x, z, 57, 98) + 0.25 * noise(seed, x, z, 22, 99);
      const cutoff = a.area > 40000 && !shore ? 0.55 : 0.60;
      if (explicit || (canopy > cutoff && pick < clamp((canopy - cutoff) * 5.5, 0, 0.95))) {
        put(x, z, shore ? 'waterfront' : 'woodland');
      } else if (canopy > cutoff - 0.10 && pick < (shore ? 0.06 : 0.028)) {
        put(x, z, shore ? 'waterfront' : 'lawn');
      }
    });
  }
  for (const a of polygons) {
    if (a.k === 'grass' && a.area >= 400) {
      sampleArea(a, bounds, Math.max(10, 21 / boost), seed, 102, (x, z, pick) => {
        if (formalPark && inPolygon(x, z, formalPark)) return;
        if (pick < 0.76 && nearEdges(x, z, a.border, a.area > 2400 ? 8 : 4)) put(x, z, 'lawn');
        else if (a.area > 3000 && pick < 0.035) put(x, z, 'lawn');
      });
    } else if (a.k === 'garden' && a.area >= 16) {
      const step = Math.max(4.8, 8.5 / boost);
      sampleArea(a, bounds, step, seed, 106, (x, z, pick) => {
        if (pick < 0.78 && !nearEdges(x, z, a.border, 0.85)) put(x, z, 'garden');
      });
      if (a.area < 100) {
        const x = (a.x0 + a.x1) / 2, z = (a.z0 + a.z1) / 2;
        if (random(seed, Math.round(x), Math.round(z), 110) < 0.70 &&
          inPolygon(x, z, a) && !nearEdges(x, z, a.border, 1.1)) put(x, z, 'garden');
      }
    }
  }
}

function plantPlazas(site, anchors, formalPark, put, seed, boost) {
  for (const a of site.polygons) {
    if (a.k !== 'plaza' || a.area < 75) continue;
    const box = rotatedBox(a.p);
    if (!box || Math.min(box.u1 - box.u0, box.v1 - box.v0) < 5.4) continue;
    const { u0, u1, v0, v1, ux, uz } = box;
    const cx = (a.x0 + a.x1) / 2, cz = (a.z0 + a.z1) / 2;
    if (distanceTo(cx, cz, anchors['Times Square']) < 105) continue;
    if (formalPark && inPolygon(cx, cz, formalPark)) continue;
    if (random(seed, Math.round(cx), Math.round(cz), 114) < 0.26) continue;
    const step = Math.max(8, 12.8 / boost);
    const nu = Math.max(1, Math.floor((u1 - u0 - 4) / step) + 1);
    const nv = Math.max(1, Math.floor((v1 - v0 - 4) / step) + 1);
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        if (nu >= 4 && nv >= 4 && i > 0 && i < nu - 1 && j > 0 && j < nv - 1) continue;
        const u = (u0 + u1) / 2 + (i - (nu - 1) / 2) * step;
        const v = (v0 + v1) / 2 + (j - (nv - 1) / 2) * step;
        const x = ux * u - uz * v, z = uz * u + ux * v;
        if (inPolygon(x, z, a) && !nearEdges(x, z, a.border, 2.5) &&
          !site.areas.at(x, z).some((p) => ['grass', 'wood', 'garden'].includes(p.k) && inPolygon(x, z, p))) {
          put(x, z, 'plaza');
        }
      }
    }
  }
}

function thin(trees, count, seed) {
  if (count >= trees.length) return trees;
  const groups = new Map();
  for (const t of trees) {
    const key = `${Math.floor(t.x / 170)},${Math.floor(t.z / 170)},${t.kind}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = []));
    group.push(t);
  }
  // Proportional sampling in each neighbourhood and planting type, with a shared rounding
  // remainder. Picking within groups by seeded rank avoids truncating any one row or district.
  const selected = [];
  const phase = random(seed, 0, 0, 120);
  let seen = 0;
  let allocated = 0;
  const score = (t) => random(seed, Math.round(t.x * 10), Math.round(t.z * 10), 121);
  for (const group of groups.values()) {
    seen += group.length;
    const quota = Math.floor(seen * count / trees.length + phase);
    const take = quota - allocated;
    allocated = quota;
    if (take > 0) {
      group.sort((a, b) => score(a) - score(b));
      for (let i = 0; i < take; i++) selected.push(group[i]);
    }
  }
  return selected;
}

function generate(city, mapped, { seed = 1, density = 1, max = 90000 } = {}) {
  if (!(density > 0) || !(max >= 1)) return [];
  const { bounds } = city.meta;
  const site = newSite(city, mapped);
  const anchors = midtownAnchors(city);
  const planted = [];
  const boost = Math.sqrt(Math.max(1, density));
  const put = (x, z, kind, owner) => {
    x = round(x, 10); z = round(z, 10);
    if (x < bounds.x0 || x > bounds.x1 || z < bounds.z0 || z > bounds.z1) return false;
    if (site.excludedArea(x, z)) return false;
    if (roadBlocked(x, z, site.roads, owner)) return false;
    const [lo, hi] = TREE_SIZES[kind];
    let size = lo + (hi - lo) * random(seed, Math.round(10 * x), Math.round(10 * z), 125);
    for (const b of site.buildings.at(x, z)) {
      if (inPolygon(x, z, b)) return false;
      // The stand-in tree's crown is 2.7 m in radius at scale 1. Use smaller trees
      // at narrow kerbs and leave a gap between the crown and the building.
      for (const s of b.border) {
        const gap = segmentDistanceSq(x, z, s);
        if (gap < square(2.7 * size + 0.25)) size = (Math.sqrt(gap) - 0.25) / 2.7;
      }
      if (size < Math.max(0.60, lo - (kind === 'side street' ? 0.23 : 0.13))) return false;
    }
    size = Math.floor(size * 100) / 100;
    for (const t of site.trees.at(x, z)) {
      const distance = Math.max(3.25, 1.85 * (size + t.size));
      if (square(x - t.x) + square(z - t.z) < square(distance)) return false;
    }
    const t = { x, z, size, kind };
    planted.push(t);
    site.trees.insert(t, x - 6.5, z - 6.5, x + 6.5, z + 6.5);
    return true;
  };

  const formalPark = plantFormalLawn(site, anchors, put, seed, boost);
  plantStreets(site, anchors, put, seed, boost);
  plantPaths(site, formalPark, put, seed, boost);
  plantPierRows(site, put, seed, boost);
  plantGreens(site, bounds, formalPark, put, seed, boost);
  plantPlazas(site, anchors, formalPark, put, seed, boost);
  const count = Math.min(Math.floor(max), Math.round(planted.length * Math.min(1, density)));
  return thin(planted, count, seed);
}

const coordinates = (trees) => trees.flatMap(({ x, z, size }) => [x, z, size]);

// Return only new trees as flat [x, z, size] triples. The cap counts additions.
export function plantTrees(city, mapped, { seed = 1, density = 1, max = 90000 } = {}) {
  return coordinates(generate(city, mapped, { seed, density, max }));
}
