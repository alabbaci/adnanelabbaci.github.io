// Sun shadows: one depth map of the buildings and trees around the player, seen from the sun.
//
// Everything that casts is static, so the map is only redrawn when the player has moved far enough
// that its square of coverage needs re-centring (or when they climb and need a wider area).
// Objects on layer 1 cast; every material reads the map through sunShadow() in shaders.js.

import * as THREE from 'three';
import { env, SUN_DIR } from './shaders.js';

const SIZE = 4096; // must match the texel size used in sunShadow()

export class SunShadow {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    const depth = new THREE.DepthTexture(SIZE, SIZE);
    // let the GPU do the depth comparison with bilinear filtering: soft edges for free
    depth.compareFunction = THREE.LessEqualCompare;
    depth.minFilter = depth.magFilter = THREE.LinearFilter;
    this.target = new THREE.WebGLRenderTarget(SIZE, SIZE, { depthTexture: depth, format: THREE.RedFormat, type: THREE.UnsignedByteType });
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2);
    this.camera.layers.set(1);
    this.material = new THREE.MeshBasicMaterial({ colorWrite: false });
    this.centre = new THREE.Vector3(1e9, 0, 1e9);
    this.radius = 0;
    this.toUv = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    env.uShadowMap.value = depth;
  }

  // focus: the point to keep covered. altitude: how high the viewer is. night: 0 day .. 1 night.
  update(focus, altitude, night) {
    env.uShadowInfo.value.w = 0.92 * (1 - night);
    const radius = altitude < 160 ? 700 : altitude < 520 ? 1300 : 2400;
    const drift = Math.max(Math.abs(focus.x - this.centre.x), Math.abs(focus.z - this.centre.z));
    if (radius === this.radius && drift < radius * 0.2) return;

    this.radius = radius;
    this.centre.set(Math.round(focus.x / 20) * 20, 0, Math.round(focus.z / 20) * 20);
    const cam = this.camera, back = radius * 1.5 + 500;
    cam.left = cam.bottom = -radius;
    cam.right = cam.top = radius;
    // near and far just bracket the city inside the square (towers up to ~500 m), to keep depth precise
    cam.near = radius * 0.5 + 100;
    cam.far = radius * 2.5 + 550;
    cam.position.copy(this.centre).addScaledVector(SUN_DIR, back);
    cam.lookAt(this.centre);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    env.uShadowMatrix.value.copy(this.toUv).multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
    env.uShadowInfo.value.set(this.centre.x, this.centre.z, radius, env.uShadowInfo.value.w);

    const r = this.renderer, before = r.getRenderTarget();
    this.scene.overrideMaterial = this.material;
    r.setRenderTarget(this.target);
    r.clear();
    r.render(this.scene, cam);
    r.setRenderTarget(before);
    this.scene.overrideMaterial = null;
  }
}
