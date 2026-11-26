// The structure under raised roads: piers and their caps, kept clear of water and of the streets below.
// From src/bridges.js of manhattan-free-roam (MIT), without its Queensboro Bridge truss.
import * as THREE from 'three';
import { flatMaterial } from './shaders.js';

const SLAB_UNDERSIDE = 0.15 - 0.9; // addRibbon's raised offset minus addDeck's slab thickness
const PIER_SPACING = 32;
const MERGE_DISTANCE = 13;
const CELL = 48;
const EPS = 1e-6;
const mix = (a, b, t) => a + (b - a) * t;

class Grid {
  cells = new Map();

  add(item, x0, z0, x1 = x0, z1 = z0) {
    this.visit(x0, z0, x1, z1, (key) => {
      if (!this.cells.has(key)) this.cells.set(key, []);
      this.cells.get(key).push(item);
    });
  }

  near(x, z, radius) {
    const items = new Set();
    this.visit(x - radius, z - radius, x + radius, z + radius, (key) => {
      for (const item of this.cells.get(key) ?? []) items.add(item);
    });
    return items;
  }

  visit(x0, z0, x1, z1, visitCell) {
    for (let z = Math.floor(z0 / CELL); z <= Math.floor(z1 / CELL); z++) {
      for (let x = Math.floor(x0 / CELL); x <= Math.floor(x1 / CELL); x++) {
        visitCell(x + 65536 * z);
      }
    }
  }
}

function segments(road) {
  const edges = [];
  for (let i = 0; i + 3 < road.p.length; i += 2) {
    const x = road.p[i], z = road.p[i + 1], ex = road.p[i + 2], ez = road.p[i + 3];
    const y = road.y?.[i / 2] ?? 0, ey = road.y?.[i / 2 + 1] ?? 0;
    const length = Math.hypot(ex - x, ez - z);
    if (length > EPS) edges.push({ x, z, y, ex, ez, ey, length, w: road.w, road });
  }
  return edges;
}

function orientedEdge(edge, forward, s) {
  const { x, z, y, ex, ez, ey, length } = edge;
  const points = forward ? { x, z, y, ex, ez, ey } : { x: ex, z: ez, y: ey, ex: x, ez: z, ey: y };
  const direction = forward ? 1 : -1;
  return { ...edge, ...points, s, tx: direction * (ex - x) / length, tz: direction * (ez - z) / length };
}

// Walk through matching way ends so each 32 m rhythm continues across data splits.
function roadPaths(ways) {
  const ends = new Map(), paths = [], used = new Set();
  for (const way of ways) {
    const first = way.edges[0], last = way.edges.at(-1);
    way.keys = [`${first.x},${first.z},${first.y},${way.road.k}`,
      `${last.ex},${last.ez},${last.ey},${way.road.k}`];
    for (const key of way.keys) {
      if (!ends.has(key)) ends.set(key, []);
      ends.get(key).push(way);
    }
  }
  function walk(way, key) {
    const edges = [];
    let length = 0;
    while (way && !used.has(way)) {
      used.add(way);
      const forward = way.keys[0] === key;
      const append = (edge) => {
        edges.push(orientedEdge(edge, forward, length));
        length += edge.length;
      };
      if (forward) {
        for (const e of way.edges) append(e);
      } else {
        for (let i = way.edges.length - 1; i >= 0; i--) append(way.edges[i]);
      }
      key = way.keys[forward ? 1 : 0];
      const next = ends.get(key);
      way = next.length === 2 ? next.find((candidate) => !used.has(candidate)) : null;
    }
    paths.push({ edges, length });
  }
  for (const [key, adjacent] of ends) {
    if (adjacent.length === 2) continue;
    for (const way of adjacent) if (!used.has(way)) walk(way, key);
  }
  for (const way of ways) if (!used.has(way)) walk(way, way.keys[0]);
  return paths;
}

function pointAt(path, s) {
  let lo = 0, hi = path.edges.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (path.edges[mid].s <= s) lo = mid;
    else hi = mid - 1;
  }
  const e = path.edges[lo], t = (s - e.s) / e.length;
  return { x: mix(e.x, e.ex, t), z: mix(e.z, e.ez, t), y: mix(e.y, e.ey, t),
    tx: e.tx, tz: e.tz, w: e.w, road: e.road };
}

function heightRanges(path, y) {
  const runs = [];
  for (const e of path.edges) {
    if (Math.max(e.y, e.ey) <= y) continue;
    const cross = (e.y > y && e.ey > y) ? 0 : e.length * (y - e.y) / (e.ey - e.y);
    const start = e.s + (e.y > y ? 0 : cross);
    const end = e.s + (e.ey > y ? e.length : cross);
    const last = runs.at(-1);
    if (last && Math.abs(last[1] - start) < EPS) last[1] = end;
    else runs.push([start, end]);
  }
  return runs;
}

function indexEdge(grid, e, pad = 0) {
  grid.add(e, Math.min(e.x, e.ex) - pad, Math.min(e.z, e.ez) - pad,
    Math.max(e.x, e.ex) + pad, Math.max(e.z, e.ez) + pad);
}

function clipHeight(e, lo, hi) {
  if (Math.max(e.y, e.ey) < lo || Math.min(e.y, e.ey) > hi) return null;
  if (Math.min(e.y, e.ey) >= lo && Math.max(e.y, e.ey) <= hi) return e;
  const a = (lo - e.y) / (e.ey - e.y), b = (hi - e.y) / (e.ey - e.y);
  const t = Math.max(0, Math.min(a, b)), u = Math.min(1, Math.max(a, b));
  return { ...e, x: mix(e.x, e.ex, t), z: mix(e.z, e.ez, t),
    ex: mix(e.x, e.ex, u), ez: mix(e.z, e.ez, u) };
}

function indexGroundRoad(grid, road) {
  for (const e of segments(road)) {
    const low = clipHeight(e, -Infinity, 0.3);
    if (low) indexEdge(grid, low, road.w / 2 + 0.25);
  }
}

function bounds(ring) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]);
    z0 = Math.min(z0, ring[i + 1]); z1 = Math.max(z1, ring[i + 1]);
  }
  return { x0, z0, x1, z1 };
}

function insideRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const zi = ring[i + 1], zj = ring[j + 1];
    if ((zi > z) !== (zj > z) && x < ring[i] + (ring[j] - ring[i]) * (z - zi) / (zj - zi)) {
      inside = !inside;
    }
  }
  return inside;
}

function segmentHitsBox(p, halfLength, halfWidth, x, z, ex, ez, pad = 0) {
  const ax = (x - p.x) * p.tx + (z - p.z) * p.tz;
  const az = (z - p.z) * p.tx - (x - p.x) * p.tz;
  const bx = (ex - p.x) * p.tx + (ez - p.z) * p.tz;
  const bz = (ez - p.z) * p.tx - (ex - p.x) * p.tz;
  const l = halfLength + pad, w = halfWidth + pad;
  return Math.min(ax, bx) <= l && Math.max(ax, bx) >= -l &&
    Math.min(az, bz) <= w && Math.max(az, bz) >= -w &&
    Math.abs(ax * bz - az * bx) <= l * Math.abs(bz - az) + w * Math.abs(bx - ax);
}

function waterMap(areas) {
  const polygons = [], edges = new Grid();
  for (const a of areas) {
    if (a.k !== 'water' || a.p.length < 6) continue;
    polygons.push({ ...a, ...bounds(a.p) });
    for (const ring of [a.p, ...(a.o ?? [])]) {
      for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
        indexEdge(edges, { x: ring[j], z: ring[j + 1], ex: ring[i], ez: ring[i + 1] });
      }
    }
  }
  const contains = (x, z) => polygons.some((p) => x >= p.x0 && x <= p.x1 &&
    z >= p.z0 && z <= p.z1 && insideRing(x, z, p.p) && !p.o?.some((hole) => insideRing(x, z, hole)));
  return { edges, contains };
}

function shorelineStations(path, start, water) {
  const cuts = [start, path.length];
  for (const e of path.edges) {
    if (e.s + e.length <= start) continue;
    for (const f of water.edges.near((e.x + e.ex) / 2, (e.z + e.ez) / 2, e.length / 2)) {
      const dx = f.ex - f.x, dz = f.ez - f.z;
      const divisor = e.tx * dz - e.tz * dx;
      if (Math.abs(divisor) < EPS) continue;
      const x = f.x - e.x, z = f.z - e.z;
      const along = (x * dz - z * dx) / divisor;
      const across = (x * e.tz - z * e.tx) / divisor;
      if (along >= 0 && along <= e.length && across >= 0 && across <= 1 &&
          e.s + along > start + EPS && e.s + along < path.length - EPS) cuts.push(e.s + along);
    }
  }
  cuts.sort((a, b) => a - b);
  const breaks = cuts.filter((s, i) => !i || s - cuts[i - 1] > EPS);
  const towers = [];
  let wet;
  for (let i = 1; i < breaks.length; i++) {
    const p = pointAt(path, (breaks[i - 1] + breaks[i]) / 2);
    const next = water.contains(p.x, p.z);
    if (i > 1 && wet !== next) towers.push(breaks[i - 1]);
    wet = next;
  }
  return towers;
}

// Intersect a deck edge with the cross-section at p. Parallel carriageways can
// contribute to the same cap or truss panel, even when their way ends differ.
function deckAt(p, e) {
  const ax = e.x - p.x, az = e.z - p.z, dx = e.ex - e.x, dz = e.ez - e.z;
  const forward = dx * p.tx + dz * p.tz;
  if (Math.abs(forward) < e.length * 0.92) return null;
  const t = -(ax * p.tx + az * p.tz) / forward;
  if (t < -EPS || t > 1 + EPS) return null;
  return { y: mix(e.y, e.ey, t), offset: (az + dz * t) * p.tx - (ax + dx * t) * p.tz };
}

function addPiers(boxes, paths, decks, ground, water, towers) {
  const candidates = [], placed = new Grid();
  for (const path of paths) {
    const raised = heightRanges(path, 0.3);
    for (const [a, b] of heightRanges(path, 3)) {
      const [lo, hi] = raised.find(([lo, hi]) => lo <= a + EPS && hi >= b - EPS);
      const start = Math.max(a, pointAt(path, lo).y <= 0.3 + EPS ? lo + 7 : lo);
      const end = Math.min(b, pointAt(path, hi).y <= 0.3 + EPS ? hi - 7 : hi);
      if (end - start < 2) continue;
      const count = Math.max(1, Math.round((end - start) / PIER_SPACING));
      const step = (end - start) / count;
      for (let i = 0; i < count; i++) {
        const s = start + (i + 0.5) * step;
        candidates.push({ path, s, slide: step / 2 - 1, y: pointAt(path, s).y });
      }
    }
  }
  candidates.sort((a, b) => b.y - a.y);
  const nearPier = (p) => [...placed.near(p.x, p.z, MERGE_DISTANCE)]
    .some((q) => Math.hypot(p.x - q.x, p.z - q.z) < MERGE_DISTANCE);
  const hitsWater = (p, l, w) => water.contains(p.x, p.z) ||
    [...water.edges.near(p.x, p.z, Math.hypot(l, w))]
      .some((e) => segmentHitsBox(p, l, w, e.x, e.z, e.ex, e.ez));
  const hitsGround = (p, l, w) => [...ground.near(p.x, p.z, Math.hypot(l, w))]
    .some((e) => segmentHitsBox(p, l, w, e.x, e.z, e.ex, e.ez, e.w / 2 + 0.25));
  const overlapsTower = (p) => towers.some((t) => Math.hypot(t.x - p.x, t.z - p.z) < 21);
  const hitsRoad = (p, l, w, edges) => edges.some((e) =>
    segmentHitsBox(p, l, w, e.x, e.z, e.ex, e.ez, e.w / 2 + 0.25));

  let piers = 0;
  for (const { path, s, slide } of candidates) {
    const target = pointAt(path, s);
    if (nearPier(target)) continue;
    for (const delta of [0, 4, -4, 8, -8, 12, -12]) {
      if (Math.abs(delta) > slide) continue;
      const p = delta ? pointAt(path, s + delta) : target;
      if (p.y <= 3 || nearPier(p) || overlapsTower(p) || water.contains(p.x, p.z)) continue;

      const top = p.y + SLAB_UNDERSIDE;
      const capHeight = Math.min(1.35, 0.55 + p.w * 0.045);
      const capBase = top - capHeight;
      const halfCap = p.w * 0.43;
      let left = -halfCap, right = halfCap;
      const lowerRoads = [], lowClearance = [];
      for (const e of decks.near(p.x, p.z, 24)) {
        if (e.road === p.road) continue;
        const q = deckAt(p, e);
        if (q && Math.abs(q.y - p.y) <= 0.2 &&
            Math.abs(q.offset) <= Math.min(13, (p.w + e.w) / 2 + 2)) {
          left = Math.min(left, Math.max(-14, q.offset - e.w * 0.43));
          right = Math.max(right, Math.min(14, q.offset + e.w * 0.43));
        }
        if (e.road.k === 0) {
          const lower = clipHeight(e, 0.3, p.y - 0.75);
          if (lower) lowerRoads.push(lower);
          const close = clipHeight(e, Math.max(0.3, capBase - 4.8 - 0.15), p.y - 0.75);
          if (close) lowClearance.push(close);
        }
      }
      const shaftWidth = Math.max(0.85, Math.min(10, (right - left) * 0.5));
      const shaftLength = Math.max(1.35, Math.min(3.6, p.w * 0.2));
      const capLength = shaftLength + 0.8;
      const capSpans = [[left, right]];
      if (left < -halfCap || right > halfCap) capSpans.push([-halfCap, halfCap]);

      // An eccentric hammerhead keeps its shaft outside a lower carriageway
      // while the cap still reaches the upper deck at the sampled station.
      let built = false;
      for (const shift of [0, 2, -2, 4, -4, 6, -6, 8, -8]) {
        if (shift && (!lowerRoads.length || Math.abs(shift) > Math.max(4, p.w * 0.8))) continue;
        const shaft = shift ? offset(p, 0, shift) : p;
        const l = shaftLength / 2, w = shaftWidth / 2;
        if (nearPier(shaft) || overlapsTower(shaft) || hitsWater(shaft, l, w) ||
            hitsGround(shaft, l, w) || hitsRoad(shaft, l, w, lowerRoads)) continue;

        for (const [a, b] of capSpans) {
          const lo = Math.min(a, shift - w - 0.15), hi = Math.max(b, shift + w + 0.15);
          const cap = offset(p, 0, (lo + hi) / 2), halfWidth = (hi - lo) / 2;
          if (hitsWater(cap, capLength / 2, halfWidth) ||
              hitsGround(cap, capLength / 2, halfWidth) ||
              hitsRoad(cap, capLength / 2, halfWidth, lowClearance)) continue;
          boxes.pier(shaft, cap, capBase, top, shaftLength, shaftWidth, capLength, halfWidth * 2);
          placed.add(shaft, shaft.x, shaft.z);
          if (shift) placed.add(p, p.x, p.z);
          piers++;
          built = true;
          break;
        }
        if (built) break;
      }
      if (built) break;
    }
  }
  return piers;
}

function offset(p, along, across) {
  return { ...p, x: p.x + along * p.tx - across * p.tz, z: p.z + along * p.tz + across * p.tx };
}

function structureBoxes() {
  const batches = new Map();
  const axisY = new THREE.Vector3(), axisX = new THREE.Vector3(), axisZ = new THREE.Vector3();
  const position = new THREE.Vector3(), scale = new THREE.Vector3();
  const rotation = new THREE.Quaternion(), basis = new THREE.Matrix4(), matrix = new THREE.Matrix4();
  let members = 0;
  function push(name, x, y, z, length, height, width, colour) {
    if (!batches.has(name)) batches.set(name, []);
    batches.get(name).push({
      matrix: matrix.compose(position.set(x, y, z), rotation, scale.set(length, height, width)).clone(),
      colour,
    });
  }
  function block(name, p, base, top, length, width, colour) {
    rotation.setFromAxisAngle(axisY.set(0, 1, 0), Math.atan2(-p.tz, p.tx));
    push(name, p.x, (base + top) / 2, p.z, length, top - base, width, colour);
  }
  return {
    pier(shaft, cap, capBase, top, shaftLength, shaftWidth, capLength, capWidth) {
      const name = `Bridge piers ${Math.floor(shaft.x / 500)},${Math.floor(shaft.z / 500)}`;
      block(name, shaft, 0, capBase, shaftLength, shaftWidth, 0x9f998c);
      block(name, cap, capBase, top, capLength, capWidth, 0xb2aa9b);
    },
    flush(scene) {
      if (!batches.size) return { members, triangles: 0 };
      const geometry = new THREE.BoxGeometry(1, 1, 1);
      geometry.deleteAttribute('uv');
      const colours = new Uint8Array(geometry.attributes.position.count * 3).fill(255);
      geometry.setAttribute('aColor', new THREE.BufferAttribute(colours, 3, true));
      const material = flatMaterial(), tint = new THREE.Color();
      let triangles = 0;
      for (const [name, boxes] of batches) {
        const mesh = new THREE.InstancedMesh(geometry, material, boxes.length);
        mesh.name = name;
        boxes.forEach((box, i) => {
          mesh.setMatrixAt(i, box.matrix);
          // flatMaterial lights authored colours directly in display space.
          mesh.setColorAt(i, tint.setHex(box.colour, THREE.LinearSRGBColorSpace));
        });
        mesh.layers.enable(1);
        mesh.computeBoundingSphere();
        scene.add(mesh);
        triangles += boxes.length * geometry.index.count / 3;
      }
      return { members, triangles };
    },
  };
}

// Builds the structure under and around raised roads and adds it to the scene.
export function addBridgeStructures(scene, city) {
  const roads = city.roads ?? [];
  const ways = [];
  for (const road of roads) {
    if (!road.y?.some((y) => y > 0.3)) continue;
    const edges = segments(road);
    if (edges.length) ways.push({ road, edges });
  }
  if (!ways.length) return { piers: 0, triangles: 0 };

  const water = waterMap(city.areas ?? []);
  const ground = new Grid(), decks = new Grid();
  for (const road of roads) if (road.k === 0) indexGroundRoad(ground, road);
  for (const way of ways) for (const e of way.edges) {
    indexEdge(decks, e, e.w / 2);
  }

  const boxes = structureBoxes();
  const piers = addPiers(boxes, roadPaths(ways), decks, ground, water, []);
  const { triangles } = boxes.flush(scene);
  return { piers, triangles };
}
