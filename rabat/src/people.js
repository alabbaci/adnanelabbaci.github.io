// Drawing people: passers-by and the player's own figure.
//
// Everyone is one instance of an instanced mesh. Until real character models are loaded, each person
// is a small blocky stand-in whose limbs swing in the vertex shader. draw() takes the simulation's
// people as they are (see pedestrians.js for the fields).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { figureMaterial, vatMaterial } from './shaders.js';

const CAP = 420;
export const PLAYER_KIND = -1;
// clothing colours for the stand-ins, one per variety
const TOPS = [
  [0.2, 0.26, 0.42], [0.82, 0.75, 0.62], [0.72, 0.16, 0.14], [0.93, 0.5, 0.13], [0.45, 0.33, 0.25], [0.18, 0.5, 0.82],
  [0.3, 0.42, 0.3], [0.85, 0.85, 0.84], [0.25, 0.25, 0.28], [0.6, 0.38, 0.6],
];
const PLAYER_TOP = [0.36, 0.4, 0.24];

// A 1.75 m figure facing -z with its feet on y = 0, built from boxes.
function standInGeometry() {
  const pos = [], nor = [], col = [], part = [], idx = [];
  const box = (x0, x1, y0, y1, z0, z1, rgb, id, pivot, tinted) => {
    const faces = [
      [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1]],
      [[x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [0, 0, 1]],
      [[x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [-1, 0, 0]],
      [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [1, 0, 0]],
      [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0]],
      [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0], [0, -1, 0]],
    ];
    for (const [a, b, c, d, n] of faces) {
      const v = pos.length / 3;
      pos.push(...a, ...b, ...c, ...d);
      for (let i = 0; i < 4; i++) {
        nor.push(...n);
        col.push(...rgb);
        part.push(id, pivot, tinted ? 1 : 0);
      }
      // wind each face so that it looks along its normal
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
      const dot = (uy * wz - uz * wy) * n[0] + (uz * wx - ux * wz) * n[1] + (ux * wy - uy * wx) * n[2];
      if (dot > 0) idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
      else idx.push(v, v + 2, v + 1, v, v + 3, v + 2);
    }
  };
  const SKIN = [224, 180, 152], HAIR = [58, 44, 36], TROUSERS = [52, 56, 72], SHOE = [34, 32, 32], TOP = [240, 240, 240];
  box(-0.19, -0.03, 0.08, 0.9, -0.09, 0.09, TROUSERS, 1, 0.9, false); // left leg
  box(-0.2, -0.02, 0, 0.08, -0.16, 0.1, SHOE, 1, 0.9, false);
  box(0.03, 0.19, 0.08, 0.9, -0.09, 0.09, TROUSERS, 2, 0.9, false); // right leg
  box(0.02, 0.2, 0, 0.08, -0.16, 0.1, SHOE, 2, 0.9, false);
  box(-0.22, 0.22, 0.88, 1.46, -0.12, 0.12, TOP, 0, 0, true); // torso
  box(-0.33, -0.23, 0.86, 1.44, -0.07, 0.07, TOP, 3, 1.42, true); // left arm
  box(-0.32, -0.24, 0.78, 0.86, -0.05, 0.05, SKIN, 3, 1.42, false);
  box(0.23, 0.33, 0.86, 1.44, -0.07, 0.07, TOP, 4, 1.42, true); // right arm
  box(0.24, 0.32, 0.78, 0.86, -0.05, 0.05, SKIN, 4, 1.42, false);
  box(-0.06, 0.06, 1.46, 1.52, -0.05, 0.05, SKIN, 0, 0, false); // neck
  box(-0.105, 0.105, 1.5, 1.7, -0.115, 0.1, SKIN, 0, 0, false); // head
  box(-0.115, 0.115, 1.66, 1.76, -0.105, 0.125, HAIR, 0, 0, false);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(new Uint8Array(col), 3, true));
  geo.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(part), 3));
  geo.setIndex(idx);
  return geo;
}

// ---------------------------------------------------------------- real models
// A rigged, animated glTF character is turned into "vertex animation textures": every frame of every
// clip is posed once at load time and each vertex position (and normal) is written into a texture.
// After that no skeleton is needed: the vertex shader just looks its position up, so hundreds of
// people can share one instanced mesh, each at their own point in the walk cycle.
const VAT_WIDTH = 2048, VAT_FPS = 24, BODY_HEIGHT = 1.75;
const DETAIL = 75; // metres within which passers-by are drawn as real models

function bakeCharacter(scene, clips) {
  const meshes = [];
  scene.traverse((o) => o.isSkinnedMesh && meshes.push(o));
  if (!meshes.length) throw new Error("no skinned mesh in the model");
  scene.updateMatrixWorld(true);
  let verts = 0, map = null;
  const offsets = meshes.map((m) => {
    const at = verts;
    verts += m.geometry.attributes.position.count;
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    if (!map && mat && mat.map) map = mat.map;
    return at;
  });
  const uv = new Float32Array(verts * 2), index = [];
  meshes.forEach((m, k) => {
    const g = m.geometry, n = g.attributes.position.count, o = offsets[k];
    if (g.attributes.uv) for (let i = 0; i < n; i++) uv.set([g.attributes.uv.getX(i), g.attributes.uv.getY(i)], (o + i) * 2);
    if (g.index) for (let i = 0; i < g.index.count; i++) index.push(g.index.getX(i) + o);
    else for (let i = 0; i < n; i++) index.push(i + o);
  });

  const bones = meshes[0].skeleton.bones;
  const hips = bones.find((b) => /hip|pelvis/i.test(b.name)) || bones[0];
  const counts = clips.map((c) => Math.max(8, Math.min(40, Math.round(c.clip.duration * VAT_FPS))));
  const frames = counts.reduce((a, b) => a + b, 0);
  const height = Math.ceil((frames * verts) / VAT_WIDTH);
  const pos = new Float32Array(VAT_WIDTH * height * 4), nor = new Uint8Array(VAT_WIDTH * height * 4);
  const mixer = new THREE.AnimationMixer(scene), v = new THREE.Vector3();
  const info = {};
  let row = 0, fit = null;
  const acc = new Float32Array(verts * 3);
  clips.forEach(({ name, clip }, ci) => {
    const action = mixer.clipAction(clip);
    action.reset().play();
    info[name] = { start: row, frames: counts[ci], duration: clip.duration };
    for (let f = 0; f < counts[ci]; f++) {
      mixer.setTime((clip.duration * f) / counts[ci]);
      scene.updateMatrixWorld(true);
      for (const m of meshes) m.skeleton.update();
      // keep the body over its own hips, so clips that travel forward play on the spot
      hips.getWorldPosition(v);
      const hx = v.x, hz = v.z, base = (row + f) * verts;
      if (!fit) {
        let y0 = Infinity, y1 = -Infinity;
        for (const m of meshes)
          for (let i = 0; i < m.geometry.attributes.position.count; i++) {
            m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld);
            if (v.y < y0) y0 = v.y;
            if (v.y > y1) y1 = v.y;
          }
        fit = { y0, s: BODY_HEIGHT / Math.max(y1 - y0, 1e-3) };
      }
      meshes.forEach((m, k) => {
        const n = m.geometry.attributes.position.count;
        for (let i = 0; i < n; i++) {
          m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld);
          const t = (base + offsets[k] + i) * 4;
          // glTF characters face +z; the game wants -z, hence the two minus signs
          pos[t] = -(v.x - hx) * fit.s;
          pos[t + 1] = (v.y - fit.y0) * fit.s;
          pos[t + 2] = -(v.z - hz) * fit.s;
        }
      });
      // smooth normals for this pose, from the posed triangles
      acc.fill(0);
      for (let i = 0; i < index.length; i += 3) {
        const a = (base + index[i]) * 4, b = (base + index[i + 1]) * 4, c = (base + index[i + 2]) * 4;
        const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
        const wx = pos[c] - pos[a], wy = pos[c + 1] - pos[a + 1], wz = pos[c + 2] - pos[a + 2];
        const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        for (const j of [index[i], index[i + 1], index[i + 2]]) {
          acc[3 * j] += nx;
          acc[3 * j + 1] += ny;
          acc[3 * j + 2] += nz;
        }
      }
      for (let i = 0; i < verts; i++) {
        const l = Math.hypot(acc[3 * i], acc[3 * i + 1], acc[3 * i + 2]) || 1, t = (base + i) * 4;
        nor[t] = (acc[3 * i] / l) * 127.5 + 127.5;
        nor[t + 1] = (acc[3 * i + 1] / l) * 127.5 + 127.5;
        nor[t + 2] = (acc[3 * i + 2] / l) * 127.5 + 127.5;
      }
    }
    action.stop();
    // How much ground does one loop of this clip cover? Follow a foot: each time it swings back and
    // forth once is one stride cycle, and in a cycle the body advances about twice the foot's reach.
    {
      const first = row * verts, F = counts[ci];
      let foot = 0, low = Infinity;
      for (let i = 0; i < verts; i++) if (pos[(first + i) * 4 + 1] < low) { low = pos[(first + i) * 4 + 1]; foot = i; }
      let z0 = Infinity, z1 = -Infinity, turns = 0, dir = 0;
      for (let f = 0; f < F; f++) {
        const z = pos[((row + f) * verts + foot) * 4 + 2], zn = pos[((row + ((f + 1) % F)) * verts + foot) * 4 + 2];
        z0 = Math.min(z0, z);
        z1 = Math.max(z1, z);
        const s = Math.abs(zn - z) < 0.004 ? 0 : Math.sign(zn - z);
        if (s && dir && s !== dir) turns++;
        if (s) dir = s;
      }
      // running has a flight phase, so it covers more ground than the feet reach
      info[name].metres = Math.max(1, (turns / 2) * 2 * (z1 - z0) * (name === "run" ? 1.5 : 1));
    }
    row += counts[ci];
  });

  const geo = new THREE.BufferGeometry();
  // the shader ignores this attribute, but three needs one to know how many vertices there are
  const rest = new Float32Array(verts * 3);
  for (let i = 0; i < verts; i++) rest.set([pos[i * 4], pos[i * 4 + 1], pos[i * 4 + 2]], i * 3);
  geo.setAttribute("position", new THREE.BufferAttribute(rest, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(index);
  const posTex = new THREE.DataTexture(pos, VAT_WIDTH, height, THREE.RGBAFormat, THREE.FloatType);
  const norTex = new THREE.DataTexture(nor, VAT_WIDTH, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  posTex.needsUpdate = norTex.needsUpdate = true;
  if (map) {
    map.colorSpace = THREE.NoColorSpace;
    map.needsUpdate = true;
  }
  return { geo, posTex, norTex, verts, clips: info, map, triangles: index.length / 3 };
}

const m4 = new THREE.Matrix4(), tip = new THREE.Matrix4(), size = new THREE.Matrix4(), tint = new THREE.Color();

export class People {
  constructor(scene) {
    this.kinds = TOPS.length;
    const geo = standInGeometry();
    this.anim = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3);
    this.anim.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAnim', this.anim);
    this.standIn = new THREE.InstancedMesh(geo, figureMaterial(), CAP);
    this.standIn.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.standIn.setColorAt(0, tint.setRGB(1, 1, 1));
    this.standIn.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.standIn.count = 0;
    this.standIn.frustumCulled = false;
    scene.add(this.standIn);
    this.scene = scene;
    this.models = new Map(); // kind -> { mesh, anim, clips }
    this.time = 0;
  }

  // Real characters, if tools/build-models.mjs has produced any (public/models/people/manifest.json):
  //   { "<name>": { "base": "<file with the mesh>", "clips": { "walk": "<file>", "idle": "<file>", ... } } }
  // "player" becomes the player; the others become the varieties of passer-by, in manifest order.
  async loadModels(base = "/models/people/") {
    let manifest;
    try {
      const res = await fetch(base + "manifest.json");
      if (!res.ok) return [];
      manifest = await res.json();
    } catch {
      return [];
    }
    const loader = new GLTFLoader(), loaded = [];
    let next = 0;
    for (const [name, cfg] of Object.entries(manifest)) {
      try {
        const gltf = await loader.loadAsync(base + cfg.base);
        const clips = [];
        for (const [clipName, file] of Object.entries(cfg.clips)) {
          // every export of one character shares its skeleton, so a clip from another file plays on this one
          const src = file === cfg.base ? gltf : await loader.loadAsync(base + file);
          const clip = src.animations.find((a) => a.name.toLowerCase().includes(clipName)) || src.animations[0];
          if (clip) clips.push({ name: clipName, clip });
        }
        if (!clips.length) throw new Error("no animation in the model");
        const baked = bakeCharacter(gltf.scene, clips);
        if (!baked.map) throw new Error("no colour texture in the model");
        const anim = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3);
        anim.setUsage(THREE.DynamicDrawUsage);
        baked.geo.setAttribute("aAnim", anim);
        const mesh = new THREE.InstancedMesh(baked.geo, vatMaterial(baked.map, baked.posTex, baked.norTex, baked.verts, VAT_WIDTH), CAP);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.setColorAt(0, tint.setRGB(1, 1, 1));
        mesh.count = 0;
        mesh.frustumCulled = false;
        this.scene.add(mesh);
        this.models.set(name === "player" ? PLAYER_KIND : next++, { mesh, anim, clips: baked.clips, name });
        loaded.push(name);
      } catch (err) {
        console.warn(`character "${name}" not used:`, err.message);
      }
    }
    if (next > 0) this.kinds = next;
    return loaded;
  }

  // list: people to draw this frame. Each: { x, y, z, h, speed, phase, kind, scale, tilt }
  // cam: the camera position. Real models are used close up; further away the stand-in is plenty.
  draw(list, dt = 0, cam = null) {
    this.time += dt;
    for (const model of this.models.values()) model.mesh.count = 0;
    const mesh = this.standIn, anim = this.anim.array;
    let n = 0;
    for (const p of list) {
      const model = this.models.get(p.kind);
      if (model && (p.kind === PLAYER_KIND || !cam || (p.x - cam.x) ** 2 + (p.z - cam.z) ** 2 < DETAIL * DETAIL)) {
        this._drawModel(model, p);
        continue;
      }
      if (n >= CAP) break;
      m4.makeRotationY(-p.h);
      // a knocked-down person tips over backwards and ends up lying on the ground
      if (p.tilt > 0) m4.multiply(tip.makeRotationX(p.tilt * Math.PI * 0.5));
      const s = p.scale || 1;
      m4.multiply(size.makeScale(s, s, s)).setPosition(p.x, p.y + (p.tilt > 0 ? p.tilt * 0.13 : 0), p.z);
      mesh.setMatrixAt(n, m4);
      const top = p.kind === PLAYER_KIND ? PLAYER_TOP : TOPS[((p.kind % TOPS.length) + TOPS.length) % TOPS.length];
      mesh.setColorAt(n, tint.setRGB(top[0], top[1], top[2]));
      anim[3 * n] = p.phase;
      // limbs swing wider the faster someone moves, and not at all when standing or lying
      anim[3 * n + 1] = p.tilt > 0 ? 0 : Math.min(1.25, p.speed / 1.6);
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    this.anim.needsUpdate = true;
    for (const model of this.models.values()) {
      model.mesh.instanceMatrix.needsUpdate = true;
      model.anim.needsUpdate = true;
    }
  }

  _drawModel(model, p) {
    const mesh = model.mesh, n = mesh.count;
    if (n >= CAP) return;
    m4.makeRotationY(-p.h);
    if (p.tilt > 0) m4.multiply(tip.makeRotationX(p.tilt * Math.PI * 0.5));
    const s = p.scale || 1;
    m4.multiply(size.makeScale(s, s, s)).setPosition(p.x, p.y + (p.tilt > 0 ? p.tilt * 0.13 : 0), p.z);
    mesh.setMatrixAt(n, m4);
    // which clip, and how far through it: standing still idles on the clock, moving follows the distance walked
    const c = model.clips;
    // (phase is 2*pi per 1.4 m walked, so this is metres; each clip knows how many metres one loop covers)
    const walked = (p.phase / (2 * Math.PI)) * 1.4;
    let clip = c.walk || c.idle || c.run, at = walked / clip.metres;
    if (p.air > 0 && c.jump) {
      // off the ground: run the airborne part of the jump clip once, then hold its falling pose
      clip = c.jump;
      at = 0.27 + Math.min(p.air / 0.64, 1) * 0.3;
    } else if (p.speed < 0.25 || p.tilt > 0) {
      clip = c.idle || clip;
      at = c.idle ? this.time / c.idle.duration + p.x * 0.37 : 0;
    } else if (p.speed > 2.4 && c.run) {
      clip = c.run;
      at = walked / clip.metres;
    }
    const a = model.anim.array;
    a[3 * n] = clip.start;
    a[3 * n + 1] = clip.frames;
    a[3 * n + 2] = at - Math.floor(at);
    mesh.count = n + 1;
  }
}
