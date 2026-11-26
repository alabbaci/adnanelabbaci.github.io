// Botanical geometry near the viewer, view-dependent crown atlases for the rest of the city.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { flatMaterial } from './shaders.js';
import { TREE_SPECIES, treeGeometry, IMPOSTOR_HEIGHT, IMPOSTOR_RADIUS } from './tree-geometry.js';
import { treeMaterial, CORE_RANGE, DETAIL_RANGE, FAR_RANGE, lodScale } from './tree-material.js';

const SPECIES = TREE_SPECIES;
const CHUNK = 220, CELL = 32, REFRESH_MARGIN = 2;

// Which species each tree is, and a per-tree random number, both fixed by where the tree stands.
// (Shared with the Blender export so trees come out the same there.)
export function treeLayout(data) {
  const count = data.length / 3, species = new Uint8Array(count), rand = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const x = data[3 * i], z = data[3 * i + 1];
    let pick = (Math.abs(x * 3.171 + z * 0.917) * 7.31) % 1, s = 0;
    while (s < SPECIES.length - 1 && (pick -= SPECIES[s].share) >= 0) s++;
    species[i] = s;
    rand[i] = Math.abs(x * 12.9898 + z * 78.233) % 1;
  }
  return { species, rand };
}
export { TREE_SPECIES };

const plane = new THREE.PlaneGeometry(2, 2);
const rotation = new THREE.Quaternion(), vertical = new THREE.Vector3(0, 1, 0);
const matrix = new THREE.Matrix4(), location = new THREE.Vector3(), size = new THREE.Vector3();
const cellKey = (x, z) => x + ',' + z;

function sample(i, salt) {
  let n = Math.imul(i ^ salt, 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function instanced(source, count, dynamic = false) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setIndex(source.index);
  for (const [name, attribute] of Object.entries(source.attributes)) geo.setAttribute(name, attribute);
  for (const name of ['aPlace', 'aTone']) {
    const attribute = new THREE.InstancedBufferAttribute(new Float32Array(4 * count), 4);
    if (dynamic) attribute.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(name, attribute);
  }
  geo.instanceCount = dynamic ? 0 : count;
  return geo;
}

function crownProxy() {
  const crown = new THREE.IcosahedronGeometry(1);
  crown.scale(1, 0.32, 1);
  crown.translate(0, 0.66, 0);
  const trunk = new THREE.CylinderGeometry(0.012, 0.048, 0.53, 5, 1, true).toNonIndexed();
  trunk.translate(0, 0.265, 0);
  const colour = (geo, rgb) => {
    const a = new Uint8Array(geo.attributes.position.count * 3);
    for (let i = 0; i < a.length; i += 3) a.set(rgb, i);
    geo.setAttribute('aColor', new THREE.BufferAttribute(a, 3, true));
  };
  colour(crown, [88, 117, 58]);
  colour(trunk, [88, 73, 53]);
  const result = mergeGeometries([crown, trunk]);
  crown.dispose();
  trunk.dispose();
  return result;
}

function batches() {
  return Array.from({ length: SPECIES.length }, () => []);
}

export class Trees {
  constructor(scene, data) {
    this.scene = scene;
    this.count = Math.floor(data.length / 3);
    this.data = data;
    const layout = treeLayout(data);
    this.species = layout.species;
    this.rand = layout.rand;
    this.previous = new THREE.Vector3(Infinity, 0, 0);
    this.lastCore = batches();
    this.lastDetail = batches();
    this.visibleCore = batches();
    this.visibleDetail = batches();
    this.viewProjection = new THREE.Matrix4();
    this.lastProjection = new THREE.Matrix4().multiplyScalar(0);
    this.frustum = new THREE.Frustum();
    this.viewSphere = new THREE.Sphere();
    this.viewDirty = true;
  }

  // Both atlas images are small enough to fetch together. No raw GLBs or geometry decoder at startup.
  async loadModels(base = '/models/trees/') {
    const loader = new THREE.TextureLoader();
    const results = await Promise.allSettled(['tree-sprays.png', 'tree-impostors.png'].map((name) => loader.loadAsync(base + name)));
    if (results.some((r) => r.status !== 'fulfilled')) {
      for (const r of results) if (r.status === 'fulfilled') r.value.dispose();
      console.warn('Tree atlases could not be loaded; using crown proxies.');
      return [];
    }
    [this.sprays, this.impostors] = results.map((r) => r.value);
    for (const map of [this.sprays, this.impostors]) {
      map.flipY = false;
      map.colorSpace = THREE.NoColorSpace;
      map.anisotropy = map === this.sprays ? 4 : 1;
    }
    return SPECIES.map((s) => s.id);
  }

  _write(geo, slot, i, originX = 0, originZ = 0) {
    const { data: d, rand: r, species } = this;
    const a = i * 3;
    geo.attributes.aPlace.setXYZW(slot, d[a] - originX, d[a + 1] - originZ, this.scales[i], r[i] * Math.PI * 2);
    geo.attributes.aTone.setXYZW(slot, this.brightness[i], this.yellow[i], r[i], species[i]);
  }

  build() {
    this.root = new THREE.Group();
    this.root.name = 'Trees';
    this.scene.add(this.root);
    this.cells = new Map();
    this.chunks = [];
    this.scales = new Float32Array(this.count);
    this.heights = new Float32Array(this.count);
    this.rangeScale = new Float32Array(this.count);
    this.sortDistance = new Float32Array(this.count);
    this.brightness = new Float32Array(this.count);
    this.yellow = new Float32Array(this.count);
    this.maxCore = 0;
    this.previous.set(Infinity, 0, 0);
    const chunks = new Map();
    const d = this.data;

    for (let i = 0; i < this.count; i++) {
      const x = d[3 * i], z = d[3 * i + 1], spec = SPECIES[this.species[i]], r = this.rand[i];
      const scale = Math.max(0, d[3 * i + 2]) * (0.92 + r * 0.2);
      if (!(scale > 0)) continue;
      const height = spec.height * scale;
      this.scales[i] = scale;
      this.heights[i] = height;
      this.rangeScale[i] = lodScale(height);
      // Position-stable variation stays the same even if the street or planting list is reordered.
      const seed = Math.imul(Math.round(x * 103), 73856093) ^ Math.imul(Math.round(z * 103), 19349663);
      this.brightness[i] = 0.86 + sample(seed, 127) * 0.29;
      this.yellow[i] = (sample(seed, 5521) - 0.5) * 1.08;
      const chunkX = Math.floor(x / CHUNK), chunkZ = Math.floor(z / CHUNK);
      const key = cellKey(chunkX, chunkZ);
      let chunk = chunks.get(key);
      if (!chunk) {
        chunk = { list: [], x: (chunkX + 0.5) * CHUNK, z: (chunkZ + 0.5) * CHUNK, height: 0 };
        chunks.set(key, chunk);
      }
      chunk.list.push(i);
      chunk.height = Math.max(chunk.height, height);
      if (this.sprays) {
        const k = cellKey(Math.floor(x / CELL), Math.floor(z / CELL));
        let cell = this.cells.get(k);
        if (!cell) this.cells.set(k, (cell = []));
        cell.push(i);
        this.maxCore = Math.max(this.maxCore, CORE_RANGE[1] * this.rangeScale[i]);
      }
    }

    const proxy = crownProxy(), proxyMaterial = flatMaterial();
    const far = this.impostors ? treeMaterial('impostor', this.impostors) : null;
    for (const chunk of chunks.values()) {
      const { list, x, z, height } = chunk;
      const caster = new THREE.InstancedMesh(proxy, proxyMaterial, list.length);
      caster.position.set(x, 0, z);
      caster.layers.set(far ? 1 : 0);
      if (!far) caster.layers.enable(1);
      caster.name = far ? 'Tree shadows' : 'Tree fallback';
      for (let slot = 0; slot < list.length; slot++) {
        const i = list[slot], s = SPECIES[this.species[i]], h = this.heights[i];
        rotation.setFromAxisAngle(vertical, this.rand[i] * Math.PI * 2);
        location.set(d[3 * i] - x, 0, d[3 * i + 1] - z);
        size.set(h * (s.width + 0.013) * (far ? 0.85 : 1), h, h * (s.width + 0.013) * (far ? 0.85 : 1));
        caster.setMatrixAt(slot, matrix.compose(location, rotation, size));
      }
      caster.computeBoundingSphere();
      this.root.add(caster);
      if (!far) continue;

      // Taller crowns often hide several shorter crowns in the same overhead pixels.
      list.sort((a, b) => this.heights[b] - this.heights[a]);
      const geo = instanced(plane, list.length);
      const bounds = new THREE.Box3();
      for (let slot = 0; slot < list.length; slot++) {
        const i = list[slot], h = this.heights[i];
        this._write(geo, slot, i, x, z);
        // A billboard can rotate in both axes. The entire quad stays inside this bound.
        const reach = Math.SQRT2 * h * IMPOSTOR_RADIUS;
        location.set(d[3 * i] - x, h * IMPOSTOR_HEIGHT, d[3 * i + 1] - z);
        bounds.expandByPoint(size.copy(location).addScalar(-reach));
        bounds.expandByPoint(size.copy(location).addScalar(reach));
      }
      geo.boundingSphere = bounds.getBoundingSphere(new THREE.Sphere());
      const mesh = new THREE.Mesh(geo, far);
      mesh.name = 'Tree impostors';
      mesh.position.set(x, 0, z);
      // First populate depth with real geometry in the overlapping LOD range.
      mesh.renderOrder = 2;
      this.root.add(mesh);
      this.chunks.push({ mesh, x, z, reach: Math.hypot(CHUNK * 0.71, height * 0.6) + height });
    }

    if (this.sprays) {
      const coreMaterial = treeMaterial('core', this.sprays), detailMaterial = treeMaterial('detail', this.sprays);
      this.local = SPECIES.map((_, i) => {
        const { core, detail } = treeGeometry(i);
        const make = (source, material, name) => {
          const mesh = new THREE.Mesh(instanced(source, 0, true), material);
          mesh.name = name;
          mesh.frustumCulled = false;
          mesh.visible = false;
          this.root.add(mesh);
          return { source, mesh, capacity: 0, instances: [] };
        };
        return {
          core: make(core, coreMaterial, 'Tree core'),
          detail: make(detail, detailMaterial, 'Tree detail'),
        };
      });
      // The normal update API only has camera position. Cull the local candidates against the
      // actual render camera, before Three creates the draw list and uploads instance attributes.
      this.previousBeforeRender = this.scene.onBeforeRender;
      this.beforeRender = (renderer, scene, camera, target) => {
        this.previousBeforeRender?.call(scene, renderer, scene, camera, target);
        if (camera.layers.isEnabled(0)) {
          this.update(camera.position);
          this._cullLocal(camera);
        }
      };
      this.scene.onBeforeRender = this.beforeRender;
    }
  }

  _populate(batch, list) {
    const { mesh, instances } = batch;
    if (instances.length === list.length && instances.every((i, slot) => i === list[slot])) return;
    instances.length = list.length;
    for (let i = 0; i < list.length; i++) instances[i] = list[i];
    mesh.visible = list.length > 0;
    if (!mesh.visible) {
      mesh.geometry.instanceCount = 0;
      return;
    }
    if (list.length > batch.capacity) {
      batch.capacity = Math.max(32, Math.ceil(list.length * 1.25));
      mesh.geometry.dispose();
      mesh.geometry = instanced(batch.source, batch.capacity, true);
    }
    const geo = mesh.geometry;
    for (let i = 0; i < list.length; i++) this._write(geo, i, list[i]);
    geo.instanceCount = list.length;
    for (const name of ['aPlace', 'aTone']) {
      const attr = geo.attributes[name];
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, list.length * 4);
      attr.needsUpdate = true;
    }
  }

  update(cam) {
    if (!this.local || this.previous.distanceToSquared(cam) < REFRESH_MARGIN ** 2) return;
    this.previous.copy(cam);
    this.viewDirty = true;
    for (const { mesh, x, z, reach } of this.chunks)
      mesh.visible = Math.hypot(cam.x - x, cam.z - z) < FAR_RANGE[1] + reach + REFRESH_MARGIN;

    const core = this.lastCore, detail = this.lastDetail;
    for (const list of [...core, ...detail]) list.length = 0;
    const radius = this.maxCore + REFRESH_MARGIN;
    const x0 = Math.floor((cam.x - radius) / CELL), x1 = Math.floor((cam.x + radius) / CELL);
    const z0 = Math.floor((cam.z - radius) / CELL), z1 = Math.floor((cam.z + radius) / CELL);
    const d = this.data;
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const list = this.cells.get(cellKey(x, z));
      if (!list) continue;
      for (const i of list) {
        const dx = d[3 * i] - cam.x, dz = d[3 * i + 1] - cam.z, dy = this.heights[i] * IMPOSTOR_HEIGHT - cam.y;
        const dist = dx * dx + dy * dy + dz * dz, scale = this.rangeScale[i], kind = this.species[i];
        this.sortDistance[i] = dist;
        if (dist < (CORE_RANGE[1] * scale + REFRESH_MARGIN) ** 2) core[kind].push(i);
        if (dist < (DETAIL_RANGE[1] * scale + REFRESH_MARGIN) ** 2) detail[kind].push(i);
      }
    }
    // Drawing nearer cutouts first lets their coverage reject much of the forest behind.
    const frontToBack = (a, b) => this.sortDistance[a] - this.sortDistance[b];
    for (const list of core) list.sort(frontToBack);
    for (const list of detail) list.sort(frontToBack);
  }

  _cullLocal(camera) {
    const projection = this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (!this.viewDirty && projection.equals(this.lastProjection)) return;
    this.viewDirty = false;
    this.lastProjection.copy(projection);
    this.frustum.setFromProjectionMatrix(projection);
    const sphere = this.viewSphere;
    const d = this.data;
    const filter = (list, visible) => {
      visible.length = 0;
      for (const i of list) {
        const h = this.heights[i];
        sphere.center.set(d[i * 3], h * 0.53, d[i * 3 + 1]);
        sphere.radius = h * 0.80 + 0.4;
        if (this.frustum.intersectsSphere(sphere)) visible.push(i);
      }
      return visible;
    };
    for (let s = 0; s < SPECIES.length; s++) {
      this._populate(this.local[s].core, filter(this.lastCore[s], this.visibleCore[s]));
      this._populate(this.local[s].detail, filter(this.lastDetail[s], this.visibleDetail[s]));
    }
  }

  // Used by the headless comparison harness when it substitutes the dense planting.
  dispose() {
    if (!this.root) return;
    if (this.scene.onBeforeRender === this.beforeRender) this.scene.onBeforeRender = this.previousBeforeRender;
    const geometries = new Set(), materials = new Set();
    this.root.traverse((object) => {
      if (!object.isMesh) return;
      if (object.isInstancedMesh) object.dispose();
      geometries.add(object.geometry);
      materials.add(object.material);
    });
    this.root.removeFromParent();
    for (const geo of geometries) geo.dispose();
    for (const material of materials) material.dispose();
    this.sprays?.dispose();
    this.impostors?.dispose();
  }
}
