// The car the player drives: an arcade model that keeps a real velocity vector, so the car can slide.
// Heading h follows the same convention as the player's yaw: 0 = north (-z), positive = clockwise.

import { CAR_TYPES } from './cars.js';

const WHEELBASE = 2.7;
const TOP = 40, TOP_BOOST = 62, REVERSE = 11;

export class Vehicle {
  constructor(type, tint, x, z, h) {
    const t = CAR_TYPES[type];
    this.type = type;
    this.tint = tint;
    this.len = t.len;
    this.radius = t.w / 2 + 0.15;
    this.x = x;
    this.y = 0;
    this.z = z;
    this.h = h;
    this.vx = 0;
    this.vz = 0;
    this.vy = 0;
    this.pitch = 0; // nose up when climbing a ramp
    this.steer = 0;
    this.speed = 0; // signed, along the nose
    this.impact = 0; // speed of the latest crash, for the camera to react to
    this.dark = true; // lights off until someone is driving
  }

  // input: { f: -1..1 throttle/brake, r: -1..1 steering, handbrake, boost }
  // solids: [{ x, y, z, r, car? }] other cars nearby. surfaces: raised road decks (see surfaces.js)
  update(dt, input, colliders, solids, bounds, surfaces) {
    const sin = Math.sin(this.h), cos = Math.cos(this.h);
    let vf = this.vx * sin - this.vz * cos; // along the nose
    let vr = this.vx * cos + this.vz * sin; // sideways

    const top = input.boost ? TOP_BOOST : TOP;
    if (input.f > 0) vf += (vf < 0 ? 24 : (input.boost ? 15 : 10) * Math.max(0, 1 - vf / top)) * dt;
    else if (input.f < 0) vf -= (vf > 0.5 ? 26 : 7 * Math.max(0, 1 + vf / REVERSE)) * dt;
    else vf -= Math.sign(vf) * Math.min(Math.abs(vf), 1.6 * dt);
    vf -= vf * 0.12 * dt;
    if (input.handbrake) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 13 * dt);
    // tyres kill sideways motion quickly, unless the handbrake has the rear end loose
    vr *= Math.exp(-(input.handbrake ? 2 : 9) * dt);

    // the faster you go, the less the wheels turn
    const maxSteer = 0.6 / (1 + Math.abs(vf) / 13);
    this.steer += (input.r * maxSteer - this.steer) * (1 - Math.exp(-dt * 9));
    this.h += ((vf * Math.tan(this.steer)) / WHEELBASE) * (input.handbrake ? 1.3 : 1) * dt;

    this.vx = sin * vf + cos * vr;
    this.vz = -cos * vf + sin * vr;
    this.speed = vf;
    this.impact = 0;

    // buildings: slide along walls, lose speed on impact
    const nx = this.x + this.vx * dt, nz = this.z + this.vz * dt;
    if (this._blocked(colliders, this.x, this.z) || !this._blocked(colliders, nx, nz)) {
      this.x = nx;
      this.z = nz;
    } else {
      this.impact = Math.hypot(this.vx, this.vz);
      if (!this._blocked(colliders, nx, this.z)) {
        this.x = nx;
        this.vx *= 0.75;
        this.vz *= -0.2;
      } else if (!this._blocked(colliders, this.x, nz)) {
        this.z = nz;
        this.vz *= 0.75;
        this.vx *= -0.2;
      } else {
        this.vx *= -0.3;
        this.vz *= -0.3;
      }
    }

    // other cars: push ourselves out and shed speed; a moving car that gets hit stops for a moment
    const s2 = Math.sin(this.h), c2 = Math.cos(this.h);
    for (const o of solids) {
      if (Math.abs((o.y || 0) - this.y) > 2.2) continue; // on a different level (under or over a bridge)
      for (const off of [this.len * 0.27, -this.len * 0.27]) {
        const px = this.x + s2 * off, pz = this.z - c2 * off;
        const dx = px - o.x, dz = pz - o.z;
        const d = Math.hypot(dx, dz), min = this.radius + o.r;
        if (d >= min || d < 1e-4) continue;
        const ux = dx / d, uz = dz / d;
        this.x += ux * (min - d);
        this.z += uz * (min - d);
        const into = this.vx * ux + this.vz * uz;
        if (into < 0) {
          this.impact = Math.max(this.impact, -into);
          this.vx -= ux * into * 1.2;
          this.vz -= uz * into * 1.2;
          this.vx *= 0.85;
          this.vz *= 0.85;
          if (o.car && -into > 1.5) o.car.hit = 2.5;
          // a stationary car gets knocked along; whoever owns the list turns this into motion
          if (!o.car && -into > 1.2) o.shove = { vx: ux * into * 0.75, vz: uz * into * 0.75 };
        }
      }
    }

    this.x = Math.max(bounds.x0 - 200, Math.min(bounds.x1 + 200, this.x));
    this.z = Math.max(bounds.z0 - 200, Math.min(bounds.z1 + 200, this.z));

    // height: ride whatever deck is underneath (a ramp lifts the car a little each frame), or fall to it
    const deckAt = (x, z) => Math.max(0, surfaces ? surfaces.heightAt(x, z, this.y, 1.3) : 0);
    const floor = deckAt(this.x, this.z);
    if (this.y > floor + 0.03) {
      this.vy -= 28 * dt;
      this.y += this.vy * dt;
      if (this.y <= floor) {
        if (this.vy < -7) this.impact = Math.max(this.impact, -this.vy);
        this.y = floor;
        this.vy = 0;
      }
    } else {
      this.y = floor;
      this.vy = 0;
    }
    const s3 = Math.sin(this.h), c3 = Math.cos(this.h), reach = this.len * 0.3;
    const nose = deckAt(this.x + s3 * reach, this.z - c3 * reach), tail = deckAt(this.x - s3 * reach, this.z + c3 * reach);
    const tilt = this.y > floor + 0.3 ? 0 : Math.atan2(nose - tail, reach * 2);
    this.pitch += (tilt - this.pitch) * Math.min(1, dt * 8);
  }

  // The car as three circles along its length, tested against building footprints.
  _blocked(colliders, x, z) {
    const sin = Math.sin(this.h), cos = Math.cos(this.h);
    for (const off of [-this.len * 0.3, 0, this.len * 0.3]) {
      if (colliders.hit(x + sin * off, z - cos * off, this.y + 0.3, this.y + 1.5, this.radius)) return true;
    }
    return false;
  }
}
