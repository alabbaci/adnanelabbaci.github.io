// Car models and their instanced rendering.
//
// Every car is one instance of a per-type mesh, in one of two levels of detail. Bodies are modelled
// in white and multiplied by a per-instance tint, so one mesh gives every paint colour.
// Parked cars are static and grouped into square chunks; moving cars are re-uploaded each frame.
//
// The shapes built here are simple stand-ins. loadModels() swaps a type's close-up shape for a real
// textured model when one exists; far away, cars stay as the stand-in.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { flatMaterial, glowMaterial, carMaterial } from './shaders.js';

// Model space: the car faces -z, sits on y = 0, and is centred on x and z.
export const CAR_TYPES = {
  sedan: { len: 4.6, w: 1.85, h: 1.45 },
  suv: { len: 4.8, w: 1.95, h: 1.75 },
  taxi: { len: 4.7, w: 1.85, h: 1.5, tint: [0.1, 0.3, 0.7] }, // Rabat's petits taxis are blue
  van: { len: 5.3, w: 2.0, h: 2.1 },
  truck: { len: 7.6, w: 2.4, h: 3.2 },
  bus: { len: 12, w: 2.55, h: 3.1, tint: [1, 1, 1] },
  // These only appear once their real model exists (see EXTRA_TYPES); `shape` is the stand-in they borrow.
  pickup: { len: 5.6, w: 2.0, h: 1.85, shape: 'suv' },
  police: { len: 4.9, w: 1.9, h: 1.5, shape: 'sedan', tint: [0.93, 0.95, 1.0] },
  ambulance: { len: 6.4, w: 2.3, h: 2.8, shape: 'van', tint: [1, 1, 1] },
  firetruck: { len: 9.0, w: 2.5, h: 3.2, shape: 'truck', tint: [0.8, 0.1, 0.08] },
  schoolbus: { len: 10.5, w: 2.5, h: 3.0, shape: 'bus', band: [236, 236, 236], tint: [1.0, 0.74, 0.1] },
};
export const EXTRA_TYPES = ['pickup', 'police', 'ambulance', 'firetruck', 'schoolbus'];
const PAINT = [
  [22, [1, 1, 1]], [14, [0.75, 0.77, 0.8]], [16, [0.5, 0.52, 0.55]], [20, [0.15, 0.15, 0.17]], [8, [0.2, 0.28, 0.48]],
  [7, [0.72, 0.16, 0.14]], [5, [0.25, 0.45, 0.75]], [3, [0.2, 0.36, 0.27]], [3, [0.82, 0.76, 0.62]], [2, [0.42, 0.3, 0.22]],
];
const PAINT_TOTAL = PAINT.reduce((s, p) => s + p[0], 0);
export function paintFor(type, r) {
  if (CAR_TYPES[type].tint) return CAR_TYPES[type].tint;
  let t = r * (type === 'truck' || type === 'van' ? 52 : PAINT_TOTAL); // vans and trucks: white to grey only
  for (const [w, c] of PAINT) if ((t -= w) < 0) return c;
  return PAINT[0][1];
}

// ---------------------------------------------------------------- stand-in geometry
const WHITE = [236, 236, 236], GLASS = [38, 48, 60], TYRE = [24, 24, 27], BLUE = [40, 84, 152], GREY = [150, 152, 156];

function quad(o, p0, p1, p2, p3, col) {
  const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
  const wx = p3[0] - p0[0], wy = p3[1] - p0[1], wz = p3[2] - p0[2];
  let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  // corners are given so that the normal should point away from the car's centre line
  const cx = (p0[0] + p2[0]) / 2, cy = (p0[1] + p2[1]) / 2 - o.cy, cz = (p0[2] + p2[2]) / 2 - o.cz;
  const flip = nx * (cx - o.cx) + ny * cy + nz * cz < 0;
  if (flip) { nx = -nx; ny = -ny; nz = -nz; }
  const v = o.pos.length / 3;
  o.pos.push(...p0, ...p1, ...p2, ...p3);
  for (let i = 0; i < 4; i++) {
    o.nor.push(Math.round(nx * 127), Math.round(ny * 127), Math.round(nz * 127));
    o.col.push(...col);
  }
  if (flip) o.idx.push(v, v + 2, v + 1, v, v + 3, v + 2);
  else o.idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
}
// A box whose top face may be shorter than its base (zt0..zt1), which gives sloped windscreens.
function prism(o, x0, x1, y0, y1, z0, z1, col, zt0 = z0, zt1 = z1) {
  o.cx = (x0 + x1) / 2; o.cy = (y0 + y1) / 2; o.cz = (z0 + z1) / 2;
  quad(o, [x0, y0, z0], [x1, y0, z0], [x1, y1, zt0], [x0, y1, zt0], col); // front
  quad(o, [x0, y0, z1], [x1, y0, z1], [x1, y1, zt1], [x0, y1, zt1], col); // back
  quad(o, [x0, y0, z0], [x0, y0, z1], [x0, y1, zt1], [x0, y1, zt0], col); // left
  quad(o, [x1, y0, z0], [x1, y0, z1], [x1, y1, zt1], [x1, y1, zt0], col); // right
  quad(o, [x0, y1, zt0], [x1, y1, zt0], [x1, y1, zt1], [x0, y1, zt1], col); // top
}
function wheels(o, w, zs) {
  for (const z of zs)
    for (const s of [-1, 1]) {
      const x = s * (w / 2 - 0.11);
      prism(o, x - 0.13, x + 0.13, 0, 0.66, z - 0.33, z + 0.33, TYRE);
    }
}
function standIn(name, detailed) {
  const { len: L, w: W, h: H, shape, band } = CAR_TYPES[name];
  const type = shape || name;
  const o = { pos: [], nor: [], col: [], idx: [], cx: 0, cy: 0, cz: 0 };
  const f = -L / 2, b = L / 2, x = W / 2;
  if (type === 'bus') {
    prism(o, -x, x, 0.32, 1.25, f, b, band || BLUE);
    prism(o, -x + 0.03, x - 0.03, 1.25, 2.3, f + 0.05, b - 0.05, GLASS);
    prism(o, -x, x, 2.3, H, f, b, WHITE);
    if (detailed) wheels(o, W, [f + 2.2, b - 2.6]);
  } else if (type === 'truck') {
    const cab = f + L * 0.27;
    prism(o, -x + 0.1, x - 0.1, 0.45, 1.5, f, cab, WHITE);
    prism(o, -x + 0.14, x - 0.14, 1.5, 2.45, f + 0.05, cab, GLASS, f + 0.5, cab);
    prism(o, -x, x, 0.85, H, cab + 0.15, b, WHITE);
    prism(o, -x + 0.3, x - 0.3, 0.45, 0.85, cab, b - 0.2, GREY);
    if (detailed) wheels(o, W, [f + 1.1, b - 2.4, b - 1.3]);
  } else if (type === 'van') {
    prism(o, -x, x, 0.3, 1.05, f, b, WHITE);
    prism(o, -x + 0.05, x - 0.05, 1.05, H, f + 0.75, f + 2.0, GLASS, f + 1.35, f + 2.0);
    prism(o, -x, x, 1.05, H, f + 2.0, b, WHITE);
    if (detailed) wheels(o, W, [f + 0.95, b - 1.05]);
  } else {
    const tall = type === 'suv';
    const belt = tall ? 1.0 : 0.82;
    prism(o, -x, x, 0.28, belt, f, b, WHITE);
    // glasshouse, then a thin painted roof on top of it
    const c0 = f + L * (tall ? 0.26 : 0.3), c1 = b - L * (tall ? 0.06 : 0.16);
    prism(o, -x + 0.1, x - 0.1, belt, H - 0.07, c0, c1, GLASS, c0 + 0.55, c1 - (tall ? 0.2 : 0.5));
    prism(o, -x + 0.16, x - 0.16, H - 0.07, H, c0 + 0.55, c1 - (tall ? 0.2 : 0.5), WHITE);
    if (name === 'taxi' && detailed) prism(o, -0.3, 0.3, H, H + 0.17, -0.22, 0.02, [255, 250, 225]);
    if (detailed) wheels(o, W, [f + L * 0.19, b - L * 0.2]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(o.pos), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(o.nor), 3, true));
  geo.setAttribute('aColor', new THREE.BufferAttribute(new Uint8Array(o.col), 3, true));
  geo.setIndex(o.idx);
  return geo;
}

// Head- and tail-lights for one car, in a unit box (x and z in -0.5..0.5; the front is -z) scaled per
// car, with the light the headlamps throw on the road ahead. Colours are light added to the picture
// (see glowMaterial), brighter than white for the lamps themselves so that they glow.
function lightsGeometry() {
  const pos = [], col = [], idx = [];
  const lamp = (x, y, z, s, t, c) => {
    const v = pos.length / 3;
    pos.push(x - s, y - t, z, x + s, y - t, z, x + s, y + t, z, x - s, y + t, z);
    for (let i = 0; i < 4; i++) col.push(...c);
    idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
  };
  lamp(-0.33, 0.6, -0.505, 0.085, 0.04, [2.1, 2.0, 1.7]);
  lamp(0.33, 0.6, -0.505, 0.085, 0.04, [2.1, 2.0, 1.7]);
  lamp(-0.36, 0.68, 0.505, 0.07, 0.035, [3.2, 0.2, 0.1]);
  lamp(0.36, 0.68, 0.505, 0.07, 0.035, [3.2, 0.2, 0.1]);
  // the beam on the road: a fan widening ahead of the car, brightest a few metres out
  const rows = [[-0.52, 0], [-0.95, 0.09], [-1.7, 0.07], [-2.8, 0.03], [-4.0, 0]], across = [[-1, 0], [-0.5, 0.7], [0, 1], [0.5, 0.7], [1, 0]];
  const first = pos.length / 3;
  for (const [r, [z, along]] of rows.entries())
    for (const [x, side] of across) {
      pos.push(x * (0.75 + 0.38 * r), 0.03, z);
      col.push(along * side, along * side * 0.93, along * side * 0.76);
    }
  for (let r = 0; r + 1 < rows.length; r++)
    for (let c = 0; c + 1 < across.length; c++) {
      const v = first + r * across.length + c;
      idx.push(v, v + across.length, v + 1, v + 1, v + across.length, v + across.length + 1);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(col), 3));
  geo.setIndex(idx);
  return geo;
}

// ---------------------------------------------------------------- real models
// Merge everything in a loaded glTF scene into one geometry (position, normal, uv) and find its colour map.
export function bake(scene) {
  scene.updateMatrixWorld(true);
  const parts = [];
  let map = null;
  scene.traverse((o) => {
    if (!o.isMesh) return;
    let g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    parts.push(g);
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!map && m && m.map) map = m.map;
  });
  if (!parts.length) throw new Error('model has no meshes');
  if (map) {
    map.colorSpace = THREE.NoColorSpace; // colours are used as authored, like everything else here
    map.anisotropy = 4;
    map.needsUpdate = true;
  }
  return { geo: parts.length === 1 ? parts[0] : mergeGeometries(parts), map };
}

// Put a baked model into the game's car frame: nose towards -z, wheels on y = 0, centred, and sized
// to the type's nominal dimensions.
function normalise(scene, dims, flip) {
  const { geo, map } = bake(scene);
  geo.computeBoundingBox();
  const size = geo.boundingBox.getSize(new THREE.Vector3());
  if (size.x > size.z) geo.rotateY(Math.PI / 2);
  if (flip) geo.rotateY(Math.PI);
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  geo.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
  // Generated cars tend to be stubbier than real ones. Fit the width to the lane first, then allow a
  // slight lengthwise stretch towards the nominal length (not enough to make the wheels look oval).
  const L = b.max.z - b.min.z, W = b.max.x - b.min.x;
  const s = Math.min(dims.len / L, (dims.w * 1.06) / W);
  const stretch = Math.min(dims.len / (L * s), 1.12);
  geo.scale(s, s, s * stretch);
  return { geo, map };
}

// ---------------------------------------------------------------- instancing
const CHUNK = 250, NEAR = 170, CLOSE = 120, FAR = 1500, CAP = 640;
const UNPAINTED = [1, 1, 1];
const m4 = new THREE.Matrix4(), s4 = new THREE.Matrix4(), tint = new THREE.Color();
const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);
const tiltM = new THREE.Matrix4();
const place = (c) => {
  m4.makeRotationY(-c.h);
  if (c.pitch) m4.multiply(tiltM.makeRotationX(c.pitch));
  return m4.setPosition(c.x, c.y || 0, c.z);
};

export class Cars {
  constructor(scene) {
    this.scene = scene;
    this.material = flatMaterial();
    this.models = {};
    this.dynamic = {};
    for (const type of Object.keys(CAR_TYPES)) {
      this.models[type] = { hi: standIn(type, true), lo: standIn(type, false), material: this.material };
      const pair = {};
      for (const lod of ['hi', 'lo']) {
        const mesh = new THREE.InstancedMesh(this.models[type][lod], this.material, CAP);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.setColorAt(0, tint.setRGB(1, 1, 1));
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
        mesh.count = 0;
        mesh.frustumCulled = false;
        scene.add(mesh);
        pair[lod] = mesh;
      }
      this.dynamic[type] = pair;
    }
    this.lights = new THREE.InstancedMesh(lightsGeometry(), glowMaterial(), CAP * 2);
    this.lights.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.lights.count = 0;
    this.lights.frustumCulled = false;
    scene.add(this.lights);
    this.chunks = new Map();
    this.parkedCount = 0;
    this.closeSet = new Set();
    this.closeList = [];
    this.tick = 0;
  }

  // Load whichever real models exist (public/models/cars/manifest.json, written by tools/build-models.mjs).
  // They replace the close-up shape only; distant cars stay as the cheap stand-in. Returns the types loaded.
  async loadModels(base = '/models/cars/') {
    let manifest;
    try {
      const res = await fetch(base + 'manifest.json');
      if (!res.ok) return [];
      manifest = await res.json();
    } catch {
      return [];
    }
    const loader = new GLTFLoader();
    const loaded = [];
    for (const [type, cfg] of Object.entries(manifest)) {
      if (!CAR_TYPES[type]) continue;
      try {
        const gltf = await loader.loadAsync(base + cfg.file);
        const { geo, map } = normalise(gltf.scene, CAR_TYPES[type], cfg.flip);
        if (!map) throw new Error('model has no colour texture');
        const model = this.models[type];
        model.hi = geo;
        model.hiMaterial = carMaterial(map);
        // a model that comes with its own livery (taxi, bus) must not be multiplied by the stand-in's paint
        // (paint: true in the manifest: a plain model that takes the type's colour, as Rabat's blue taxis do)
        model.ownColour = !!CAR_TYPES[type].tint && !cfg.paint;
        this.dynamic[type].hi.geometry = geo;
        this.dynamic[type].hi.material = model.hiMaterial;
        loaded.push(type);
      } catch (err) {
        console.warn(`car model "${type}" not used:`, err.message);
      }
    }
    return loaded;
  }

  // list: [{ x, z, h, type, tint }]
  buildParked(list) {
    const groups = new Map();
    for (const car of list) {
      const k = Math.floor(car.x / CHUNK) * 4096 + Math.floor(car.z / CHUNK);
      let chunk = groups.get(k);
      if (!chunk) groups.set(k, (chunk = { x: 0, z: 0, n: 0, types: {}, cars: [] }));
      chunk.cars.push(car);
      chunk.x += car.x;
      chunk.z += car.z;
      chunk.n++;
    }
    for (const [k, chunk] of groups) {
      chunk.x /= chunk.n;
      chunk.z /= chunk.n;
      const byType = {};
      for (const car of chunk.cars) (byType[car.type] ||= []).push(car);
      for (const [type, cars] of Object.entries(byType)) {
        // one cheap stand-in mesh per chunk and type; the few cars near the camera are drawn in
        // full detail by drawDynamic instead (see refreshCloseUps)
        const mesh = new THREE.InstancedMesh(this.models[type].lo, this.material, cars.length);
        cars.forEach((car, i) => {
          mesh.setMatrixAt(i, place(car));
          mesh.setColorAt(i, tint.setRGB(car.tint[0], car.tint[1], car.tint[2]));
          car.slot = i;
          car.chunk = chunk;
        });
        mesh.computeBoundingSphere();
        mesh.visible = false;
        this.scene.add(mesh);
        chunk.types[type] = mesh;
      }
      this.chunks.set(k, chunk);
    }
    this.parkedCount = list.length;
  }

  updateParked(cam) {
    for (const chunk of this.chunks.values()) {
      const show = Math.hypot(chunk.x - cam.x, cam.y, chunk.z - cam.z) < FAR;
      for (const mesh of Object.values(chunk.types)) mesh.visible = show;
    }
    if (++this.tick % 12 === 0) this.refreshCloseUps(cam);
  }

  // Parked cars within CLOSE metres swap their stand-in for the full model (drawn with the moving cars).
  refreshCloseUps(cam) {
    const list = cam.y > 160 ? [] : this.parkedNear(cam.x, cam.z, CLOSE, []);
    const next = new Set(list);
    for (const car of this.closeSet) if (!next.has(car) && !car.gone) this._standIn(car, true);
    for (const car of list) if (!this.closeSet.has(car)) this._standIn(car, false);
    this.closeSet = next;
    this.closeList = list;
  }
  _standIn(car, on) {
    const mesh = car.chunk.types[car.type];
    mesh.setMatrixAt(car.slot, on ? place(car) : HIDE);
    mesh.instanceMatrix.needsUpdate = true;
  }

  // Parked cars within r of (x, z).
  parkedNear(x, z, r, out = []) {
    out.length = 0;
    const i0 = Math.floor((x - r) / CHUNK), i1 = Math.floor((x + r) / CHUNK);
    const j0 = Math.floor((z - r) / CHUNK), j1 = Math.floor((z + r) / CHUNK);
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const chunk = this.chunks.get(i * 4096 + j);
        if (!chunk) continue;
        for (const car of chunk.cars) if (!car.gone && (car.x - x) ** 2 + (car.z - z) ** 2 < r * r) out.push(car);
      }
    return out;
  }

  // Take a parked car off the kerb (it becomes a driven car).
  removeParked(car) {
    car.gone = true;
    this._standIn(car, false);
    const i = this.closeList.indexOf(car);
    if (i >= 0) this.closeList.splice(i, 1);
    this.closeSet.delete(car);
  }

  // cars: [{ type, tint, x, y, z, h }], re-uploaded every frame.
  drawDynamic(cars, cam, night) {
    for (const pair of Object.values(this.dynamic)) pair.hi.count = pair.lo.count = 0;
    let lamps = 0;
    for (const c of this.closeList.length ? cars.concat(this.closeList) : cars) {
      const d2 = (c.x - cam.x) ** 2 + (c.z - cam.z) ** 2 + cam.y * cam.y;
      const close = d2 < NEAR * NEAR;
      const mesh = this.dynamic[c.type][close ? 'hi' : 'lo'];
      if (mesh.count >= CAP) continue;
      const paint = close && this.models[c.type].ownColour ? UNPAINTED : c.tint;
      place(c);
      mesh.setMatrixAt(mesh.count, m4);
      mesh.setColorAt(mesh.count, tint.setRGB(paint[0], paint[1], paint[2]));
      mesh.count++;
      if (night > 0.02 && !c.dark && !this.closeSet.has(c) && lamps < CAP * 2) { // (parked cars stand dark)
        const t = CAR_TYPES[c.type];
        this.lights.setMatrixAt(lamps++, m4.multiply(s4.makeScale(t.w, Math.min(t.h / 1.45, 1.5), t.len)));
      }
    }
    for (const pair of Object.values(this.dynamic))
      for (const mesh of [pair.hi, pair.lo]) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor.needsUpdate = true;
      }
    this.lights.count = lamps;
    this.lights.visible = lamps > 0;
    this.lights.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- kerbside parking
// Fills both kerbs of ordinary streets with parked cars. graph: RoadGraph (see traffic.js).
// available: car types that have a real model (extra types are only used when theirs has loaded).
export function parkCars(graph, available = [], seed = 7) {
  const extra = Object.fromEntries(available.map((t) => [t, true]));
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const list = [], p = { x: 0, y: 0, z: 0, h: 0 };
  for (const e of graph.edges) {
    // no parking on the fast roads, in service lanes, or in streets too narrow to pass a parked car
    if (e.cls === 0 || e.cls === 3 || e.w < 7 || e.elevated || e.len < 34) continue;
    const fill = e.cls === 1 ? 0.36 : 0.36;
    for (const side of [1, -1]) {
      // on a two-way street the far kerb's cars face the other way
      const de = side === 1 || e.oneway ? e.fwd : e.rev;
      const lat = (side === 1 || !e.oneway ? 1 : -1) * (e.w / 2 - 1.12);
      for (let s = 13 + rnd() * 3; s < e.len - 13; s += 5.9 + rnd() * 0.9) {
        if (rnd() > fill) continue;
        graph.pose(de, s, lat, p);
        const r = rnd();
        const type = r < 0.44 ? 'sedan' : r < 0.76 ? 'suv' : r < 0.86 ? 'van' : r < 0.92 ? 'taxi' : extra.pickup ? 'pickup' : 'sedan';
        list.push({ x: p.x, y: 0, z: p.z, h: p.h + (rnd() - 0.5) * 0.04, type, tint: paintFor(type, rnd()), dark: true });
      }
    }
  }
  return list;
}
