// The night light show: fire a ball of light; where it lands a shock wave spreads across the city and
// every building it passes joins in. The look is all in the shaders (showAt() in shaders.js); this file
// only flies the balls and records where and when each one landed, and draws the show's set pieces
// (showfx.js): laser fans on the tall towers, and the drones that write in the sky.

import * as THREE from 'three';
import { env } from './shaders.js';
import { BEAM_STRIDE, MAX_BEAMS, beamsAt, dronesAt, planDrones } from './showfx.js';

const SPEED = 240, RANGE = 1800;
const BEAM_RADIUS = 1.8, DRONE_RADIUS = 2.6, DRONE_LIMIT = 4000;

// How large a drone is drawn (a factor on DRONE_RADIUS) from `distance` metres away: about the same size
// on screen near or far, as a point of light is. The Blender scene (tools/blender_scene.py) does the same.
export const DRONE_FAR = 1000;
export const droneSize = (distance) => Math.min(3, Math.max(0.22, distance / DRONE_FAR));

// A laser beam: a thin tube of light, brightest along its middle and at its foot, fading out along its length.
function beamMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec4 aTint;
      varying vec4 vTint;
      varying float vAlong;
      varying vec3 vN, vV;
      void main() {
        vTint = aTint;
        vAlong = uv.y;
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec4 vTint;
      varying float vAlong;
      varying vec3 vN, vV;
      void main() {
        float core = pow(abs(dot(normalize(vN), normalize(vV))), 1.5);
        float fade = pow(1.0 - vAlong, 1.2);
        gl_FragColor = vec4(vTint.rgb * (vTint.a * core * fade * 1.3), 1.0);
      }`,
  });
}

export class LightShow {
  constructor(scene, colliders) {
    this.colliders = colliders;
    this.orbs = [];
    this.next = 0; // which wave slot to reuse next
    const core = new THREE.SphereGeometry(1.4, 14, 10), halo = new THREE.SphereGeometry(5, 14, 10);
    const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const haloMat = new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false });
    for (let i = 0; i < 6; i++) {
      const mesh = new THREE.Mesh(core, coreMat);
      mesh.add(new THREE.Mesh(halo, haloMat));
      mesh.visible = false;
      scene.add(mesh);
      this.orbs.push({ mesh, dir: new THREE.Vector3(), live: false, travelled: 0 });
    }

    // laser fans: one tube per beam, placed afresh every frame
    const tube = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true).translate(0, 0.5, 0);
    this.beamTint = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BEAMS * 4), 4);
    this.beamTint.setUsage(THREE.DynamicDrawUsage);
    tube.setAttribute('aTint', this.beamTint);
    this.beams = new THREE.InstancedMesh(tube, beamMaterial(), MAX_BEAMS);
    this.beams.frustumCulled = false;
    this.beams.count = 0;
    this.beams.renderOrder = 5;
    scene.add(this.beams);
    this.beamData = new Float32Array(MAX_BEAMS * BEAM_STRIDE);

    // drones: a point of cold white light each
    this.droneMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(DRONE_RADIUS, 1), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 2.8, 3.2), toneMapped: false }), DRONE_LIMIT);
    this.droneMesh.frustumCulled = false;
    this.droneMesh.count = 0;
    scene.add(this.droneMesh);
    this.dronePos = new Float32Array(DRONE_LIMIT * 3);
    this.formation = null; // { plan, start } while drones are up
  }

  // Send the drones up: config as planDrones() (showfx.js); start: the game time they leave at (default now).
  startDrones(config, start = env.uTime.value) {
    const plan = planDrones(config);
    if (plan.count > DRONE_LIMIT) throw new Error(`a formation of ${plan.count} drones is more than ${DRONE_LIMIT}`);
    this.formation = { plan, start };
  }

  // No show left over: no waves, no beams, no drones.
  reset() {
    for (const wave of env.uWaves.value) wave.z = -1000;
    this.formation = null;
    this.beams.count = 0;
    this.droneMesh.count = 0;
  }

  // Launch from `from` towards `dir` (a unit vector). Returns false if every ball is already in flight.
  fire(from, dir) {
    const orb = this.orbs.find((o) => !o.live);
    if (!orb) return false;
    orb.live = true;
    orb.travelled = 0;
    orb.dir.copy(dir);
    orb.mesh.position.copy(from).addScaledVector(dir, 4);
    orb.mesh.visible = true;
    return true;
  }

  // Start a wave at (x, z) right now.
  burst(x, z) {
    env.uWaves.value[this.next].set(x, z, env.uTime.value, 1);
    this.onBurst?.(x, z);
    this.next = (this.next + 1) % env.uWaves.value.length;
  }

  update(dt, eye) {
    for (const orb of this.orbs) {
      if (!orb.live) continue;
      const p = orb.mesh.position;
      // short steps so a fast ball cannot skip through a thin building
      for (let left = SPEED * dt; left > 0 && orb.live; left -= 3) {
        const step = Math.min(3, left);
        p.addScaledVector(orb.dir, step);
        orb.travelled += step;
        if (p.y < 1 || orb.travelled > RANGE || this.colliders.hitPoint(p.x, p.z, p.y - 0.5, p.y + 0.5)) {
          orb.live = false;
          orb.mesh.visible = false;
          this.burst(p.x, p.z);
        }
      }
      orb.mesh.scale.setScalar(1 + 0.25 * Math.sin(env.uTime.value * 30));
    }
    this.drawSetPieces(env.uTime.value, eye);
  }

  // eye: where the camera is (a drone is a point of light: it is drawn about the same size near or far)
  drawSetPieces(now, eye) {
    const m = (this._m ||= new THREE.Matrix4()), q = (this._q ||= new THREE.Quaternion());
    const up = (this._up ||= new THREE.Vector3(0, 1, 0)), dir = (this._dir ||= new THREE.Vector3());
    const at = (this._at ||= new THREE.Vector3()), size = (this._size ||= new THREE.Vector3());
    const waves = env.uWaves.value.map((w) => [w.x, w.y, w.z]);
    // the formation comes down again (is simply switched off) a minute and a half after it went up
    if (this.formation && now - this.formation.start > 90) this.formation = null;
    const tau = this.formation ? now - this.formation.start : -1;
    const n = beamsAt(waves, now, this.beamData, tau >= 0 ? { plan: this.formation.plan, tau } : null), d = this.beamData;
    for (let i = 0; i < n; i++) {
      const o = i * BEAM_STRIDE;
      q.setFromUnitVectors(up, dir.set(d[o + 3], d[o + 4], d[o + 5]));
      this.beams.setMatrixAt(i, m.compose(at.set(d[o], d[o + 1], d[o + 2]), q, size.set(BEAM_RADIUS, d[o + 10], BEAM_RADIUS)));
      this.beamTint.setXYZW(i, d[o + 6], d[o + 7], d[o + 8], d[o + 9]);
    }
    this.beams.count = n;
    if (n) {
      this.beams.instanceMatrix.needsUpdate = true;
      this.beamTint.needsUpdate = true;
    }

    const count = this.formation ? dronesAt(this.formation.plan, tau, this.dronePos) : 0;
    q.identity();
    for (let i = 0; i < count; i++) {
      at.fromArray(this.dronePos, i * 3);
      this.droneMesh.setMatrixAt(i, m.compose(at, q, size.setScalar(droneSize(eye ? at.distanceTo(eye) : DRONE_FAR))));
    }
    this.droneMesh.count = count;
    if (count) this.droneMesh.instanceMatrix.needsUpdate = true;
  }
}
