// First-person player with two modes: free flight, and walking with gravity.
// this.pos is the eye position. Yaw 0 looks north (-z); positive yaw turns right (east).

import * as THREE from 'three';

const EYE = 1.7;
const FLY_SPEED = 55, FLY_BOOST = 250;
const WALK_SPEED = 4.2, RUN_SPEED = 8.5; // a jog by default, a sprint with Shift
const GRAVITY = 28, TERMINAL = 75, JUMP = 9;
const wrap = (a) => a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;

export class Player {
  constructor(camera, colliders, spawn, bounds) {
    this.camera = camera;
    this.colliders = colliders;
    this.bounds = bounds;
    this.pos = new THREE.Vector3(spawn.x, spawn.y, spawn.z);
    this.yaw = ((spawn.yaw || 0) * Math.PI) / 180;
    this.pitch = -0.16;
    this.vel = new THREE.Vector3();
    this.mode = 'fly';
    this.onGround = false;
    this.speed = 0;
    this.keys = new Set();
    this.active = false; // set once the player has clicked to start
    // On foot the camera normally sits behind the player's own figure (C switches to first person).
    this.thirdPerson = true;
    this.figure = { x: 0, y: 0, z: 0, h: this.yaw, speed: 0, phase: 0, kind: -1, scale: 1, tilt: 0 };
  }

  look(dx, dy) {
    if (this.mode === 'drive') {
      // in a car the mouse swings the chase camera around instead
      this.orbit += dx * 0.003;
      this.orbitPitch = Math.max(0.04, Math.min(1.25, this.orbitPitch + dy * 0.002));
      this.orbitIdle = 0;
      return;
    }
    this.yaw += dx * 0.0022;
    this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - dy * 0.0022));
  }

  // Get into a car (walk -> drive).
  enter(vehicle) {
    this.mode = 'drive';
    this.vehicle = vehicle;
    vehicle.dark = false;
    this.camH = vehicle.h;
    this.orbit = 0;
    this.orbitPitch = 0.25;
    this.orbitIdle = 9;
    this.vel.set(0, 0, 0);
  }

  // Step out beside the car (drive -> walk). Returns false if there is no room on either side.
  exit() {
    const v = this.vehicle;
    const cos = Math.cos(v.h), sin = Math.sin(v.h);
    for (const side of [-1, 1, 0]) {
      // driver's side first, then the passenger side, then behind the car
      const x = side ? v.x + cos * side * 2.1 : v.x - sin * (v.len / 2 + 1.2);
      const z = side ? v.z + sin * side * 2.1 : v.z + cos * (v.len / 2 + 1.2);
      if (this.colliders.hit(x, z, v.y + 0.7, v.y + 1.85, 0.35)) continue;
      v.vx = v.vz = 0;
      v.dark = true;
      this.vehicle = null;
      this.mode = 'walk';
      this.pos.set(x, v.y + EYE, z);
      this.yaw = v.h;
      this.pitch = -0.05;
      this.vel.set(0, 0, 0);
      this.onGround = false;
      return true;
    }
    return false;
  }

  _drive(dt) {
    const v = this.vehicle;
    const { f, r, boost } = this._axes();
    const handbrake = this.active && this.key('Space');
    v.update(dt, { f, r, handbrake, boost }, this.colliders, this.solids ? this.solids(v) : [], this.bounds, this.surfaces);
    this.speed = Math.abs(v.speed);

    // chase camera: follows the car's heading with a little lag; the mouse orbits it,
    // and it drifts back behind the car once you stop touching the mouse
    this.orbitIdle += dt;
    if (this.orbitIdle > 1.2 && this.speed > 2) this.orbit *= Math.exp(-dt * 2.5);
    this.camH += wrap(v.h - this.camH) * (1 - Math.exp(-dt * 4.5));
    const hh = this.camH + this.orbit;
    const dist = 7.2 + Math.min(this.speed, 60) * 0.045 + Math.max(0, v.len - 5) * 0.9;
    const tx = v.x, ty = v.y + 1.35, tz = v.z;
    const dx = Math.sin(hh), dz = -Math.cos(hh);
    const flat = Math.cos(this.orbitPitch) * dist;
    const ix = tx - dx * flat, iy = ty + Math.sin(this.orbitPitch) * dist, iz = tz - dz * flat;
    // pull the camera in if a building is between it and the car
    let t = 1;
    for (let i = 1; i <= 12; i++) {
      const k = i / 12;
      const py = ty + (iy - ty) * k;
      if (this.colliders.hitPoint(tx + (ix - tx) * k, tz + (iz - tz) * k, py - 0.3, py + 0.3)) {
        t = Math.max((i - 1) / 12, 0.2);
        break;
      }
    }
    this.pos.set(tx + (ix - tx) * t, ty + (iy - ty) * t, tz + (iz - tz) * t);
    this.camera.position.copy(this.pos);
    this.camera.lookAt(tx + dx * 1.5, ty, tz + dz * 1.5);
  }

  toggleMode() {
    if (this.mode === 'drive') return;
    this.mode = this.mode === 'fly' ? 'walk' : 'fly';
    if (this.mode === 'walk') {
      this.vel.set(0, Math.min(this.vel.y, 0), 0);
      this.onGround = false;
    } else {
      this.vel.set(0, 6, 0); // a little hop into the air
    }
  }

  key(code) {
    return this.keys.has(code);
  }

  update(dt) {
    if (this.mode === 'drive') {
      this._drive(dt);
      return;
    }
    const before = this.pos.clone();
    if (this.mode === 'fly') this._fly(dt);
    else this._walk(dt);

    // stay near the city
    const b = this.bounds, m = 1800;
    this.pos.x = Math.max(b.x0 - m, Math.min(b.x1 + m, this.pos.x));
    this.pos.z = Math.max(b.z0 - m, Math.min(b.z1 + m, this.pos.z));

    this.speed = dt > 0 ? before.distanceTo(this.pos) / dt : 0;

    // the figure faces the way it is moving, and its walk cycle advances with the distance covered
    const fig = this.figure, pace = Math.hypot(this.vel.x, this.vel.z);
    if (this.mode === 'walk' && pace > 0.4) fig.h += wrap(Math.atan2(this.vel.x, -this.vel.z) - fig.h) * Math.min(1, dt * 10);
    fig.x = this.pos.x;
    fig.y = this.pos.y - EYE;
    fig.z = this.pos.z;
    fig.speed = this.onGround ? pace : 0;
    // time spent off the ground, for the jump animation
    fig.air = this.mode === 'walk' && !this.onGround ? (fig.air || 0) + dt : 0;
    fig.phase += pace * dt * ((2 * Math.PI) / 1.4); // same convention as the passers-by: 2*pi per 1.4 m

    this.camera.rotation.set(this.pitch, -this.yaw, 0, 'YXZ');
    if (this.mode !== 'walk' || !this.thirdPerson) {
      this.camera.position.copy(this.pos);
      return;
    }
    // third person: back along the view direction from just above the head, pulled in if a wall is in the way
    const cp = Math.cos(this.pitch), dx = Math.sin(this.yaw) * cp, dy = Math.sin(this.pitch), dz = -Math.cos(this.yaw) * cp;
    const hx = this.pos.x, hy = this.pos.y + 0.2, hz = this.pos.z, reach = 4.6;
    let t = 1;
    for (let i = 1; i <= 10; i++) {
      const k = i / 10, py = hy - dy * reach * k + 0.45 * k;
      if (py < fig.y + 0.25 || this.colliders.hitPoint(hx - dx * reach * k, hz - dz * reach * k, py - 0.25, py + 0.25)) {
        t = Math.max((i - 1) / 10, 0.1);
        break;
      }
    }
    this.camera.position.set(hx - dx * reach * t, hy - dy * reach * t + 0.45 * t, hz - dz * reach * t);
  }

  // The player's figure, when it should be drawn (on foot in third person), else null.
  get visibleFigure() {
    return this.mode === 'walk' && this.thirdPerson ? this.figure : null;
  }

  _axes() {
    const a = this.active;
    return {
      f: a ? (this.key('KeyW') || this.key('ArrowUp') ? 1 : 0) - (this.key('KeyS') || this.key('ArrowDown') ? 1 : 0) : 0,
      r: a ? (this.key('KeyD') || this.key('ArrowRight') ? 1 : 0) - (this.key('KeyA') || this.key('ArrowLeft') ? 1 : 0) : 0,
      u: a ? (this.key('Space') || this.key('KeyE') ? 1 : 0) - (this.key('KeyQ') || this.key('KeyC') ? 1 : 0) : 0,
      boost: a && (this.key('ShiftLeft') || this.key('ShiftRight')),
    };
  }

  _fly(dt) {
    const { f, r, u, boost } = this._axes();
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch), sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const want = new THREE.Vector3(sy * cp * f + cy * r, sp * f + u, -cy * cp * f + sy * r);
    if (want.lengthSq() > 1) want.normalize();
    want.multiplyScalar(boost ? FLY_BOOST : FLY_SPEED);
    this.vel.lerp(want, 1 - Math.exp(-dt * 5));
    if (this.vel.lengthSq() < 0.0004) this.vel.set(0, 0, 0);

    // the street is solid, and so is every building
    const blocked = (x, y, z) => y < 1.2 || this.colliders.hit(x, z, y - 0.9, y + 0.4, 0.4);
    this._sweep(this.vel.x * dt, this.vel.y * dt, this.vel.z * dt, blocked);
    this.pos.y = Math.min(this.pos.y, 2500);
  }

  _walk(dt) {
    const { f, r, boost } = this._axes();
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const want = new THREE.Vector3(sy * f + cy * r, 0, -cy * f + sy * r);
    if (want.lengthSq() > 1) want.normalize();
    want.multiplyScalar(boost ? RUN_SPEED : WALK_SPEED);
    const k = 1 - Math.exp(-dt * (this.onGround ? 12 : 2.5));
    this.vel.x += (want.x - this.vel.x) * k;
    this.vel.z += (want.z - this.vel.z) * k;

    // horizontal move: blocked by anything taller than a step
    const feet0 = this.pos.y - EYE;
    const blocked = (x, y, z) => this.colliders.hit(x, z, y - EYE + 0.7, y + 0.15, 0.35);
    this._sweep(this.vel.x * dt, 0, this.vel.z * dt, blocked);

    // vertical move: gravity, then land on whatever is underneath (street or roof)
    if (this.onGround && this.active && this.key('Space')) {
      this.vel.y = JUMP;
      this.onGround = false;
    }
    this.vel.y = Math.max(this.vel.y - GRAVITY * dt, -TERMINAL);
    let feet = feet0 + this.vel.y * dt;
    // roofs and raised road decks both count as ground
    const deck = this.surfaces ? this.surfaces.heightAt(this.pos.x, this.pos.z, feet0, 0.6) : 0;
    const floor = Math.max(this.colliders.floor(this.pos.x, this.pos.z, feet0, 0.6), deck);
    if (feet <= floor) {
      feet = floor;
      this.vel.y = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }
    this.pos.y = feet + EYE;
  }

  // Move in small steps, sliding along whichever axis is still free.
  _sweep(dx, dy, dz, blocked) {
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-6) return;
    const steps = Math.min(Math.ceil(dist / 1.5), 60);
    const sx = dx / steps, sy = dy / steps, sz = dz / steps;
    const p = this.pos;
    for (let i = 0; i < steps; i++) {
      // If we are somehow already inside something (e.g. the collision shape changed with the mode),
      // let the move through so the player can never get stuck.
      if (blocked(p.x, p.y, p.z) || !blocked(p.x + sx, p.y + sy, p.z + sz)) {
        p.x += sx; p.y += sy; p.z += sz;
        continue;
      }
      let moved = false;
      if (sx) {
        if (!blocked(p.x + sx, p.y, p.z)) { p.x += sx; moved = true; } else this.vel.x *= 0.5;
      }
      if (sz) {
        if (!blocked(p.x, p.y, p.z + sz)) { p.z += sz; moved = true; } else this.vel.z *= 0.5;
      }
      if (sy) {
        if (!blocked(p.x, p.y + sy, p.z)) { p.y += sy; moved = true; } else this.vel.y *= 0.5;
      }
      if (!moved) break;
    }
  }
}
