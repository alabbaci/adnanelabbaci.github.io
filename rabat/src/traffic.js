// The drivable road network and the cars that drive on it by themselves.
//
// RoadGraph cuts the road polylines at every shared point into edges between junction nodes.
// Traffic keeps a pool of cars alive around the player: each follows its lane, keeps a gap to the car
// ahead, and takes turns at junctions (one approach gets a short green at a time).

import { CAR_TYPES, paintFor } from './cars.js';

const KEY = (x, z) => Math.round(x * 10) * 100003 + Math.round(z * 10);
const GRID = 150;
const PARK = 2.25; // kerbside strip kept free for parked cars

export class RoadGraph {
  constructor(roads) {
    const list = roads.filter((r) => r.k === 0 && r.c <= 2 && r.p.length >= 4);
    const use = new Map();
    for (const r of list)
      for (let i = 0; i < r.p.length; i += 2) {
        const k = KEY(r.p[i], r.p[i + 1]);
        use.set(k, (use.get(k) || 0) + (i === 0 || i === r.p.length - 2 ? 2 : 1));
      }
    this.nodes = [];
    this.edges = [];
    this.cells = new Map();
    const nodeAt = new Map();
    const node = (x, z) => {
      const k = KEY(x, z);
      let n = nodeAt.get(k);
      // out: directed edges a car may take; adj: every edge either way (for routes on foot or by air)
      if (!n) nodeAt.set(k, (n = { id: this.nodes.length, x, z, out: [], adj: [], deg: 0, phase: -1, until: 0 })), this.nodes.push(n);
      return n;
    };
    for (const r of list) {
      const n = r.p.length / 2;
      let start = 0;
      for (let i = 1; i < n; i++) {
        if (i < n - 1 && use.get(KEY(r.p[2 * i], r.p[2 * i + 1])) < 2) continue;
        this._edge(r, start, i, node);
        start = i;
      }
    }
  }

  _edge(r, i0, i1, node) {
    const count = i1 - i0 + 1;
    const pts = new Float32Array(count * 3), cum = new Float32Array(count);
    let elevated = false;
    for (let i = 0; i < count; i++) {
      const j = i0 + i;
      pts[3 * i] = r.p[2 * j];
      pts[3 * i + 1] = r.p[2 * j + 1];
      pts[3 * i + 2] = r.y ? r.y[j] : 0;
      if (pts[3 * i + 2] > 0.3) elevated = true;
      if (i) cum[i] = cum[i - 1] + Math.hypot(pts[3 * i] - pts[3 * i - 3], pts[3 * i + 1] - pts[3 * i - 2]);
    }
    const len = cum[count - 1];
    if (len < 1) return;
    const a = node(pts[0], pts[1]), b = node(pts[3 * count - 3], pts[3 * count - 2]);
    const e = { id: this.edges.length, pts, cum, len, w: r.w, cls: r.c, lanes: r.l || 1, oneway: !!r.o, elevated, name: r.n };
    e.fwd = { id: e.id * 2, edge: e, forward: true, from: a, to: b, cars: [] };
    a.out.push(e.fwd);
    if (!e.oneway) {
      e.rev = { id: e.id * 2 + 1, edge: e, forward: false, from: b, to: a, cars: [] };
      b.out.push(e.rev);
    }
    a.adj.push({ edge: e, forward: true, to: b });
    b.adj.push({ edge: e, forward: false, to: a });
    a.deg++;
    b.deg++;
    this.edges.push(e);
    const mid = Math.floor(count / 2) * 3;
    const k = Math.floor(pts[mid] / GRID) * 4096 + Math.floor(pts[mid + 1] / GRID);
    let cell = this.cells.get(k);
    if (!cell) this.cells.set(k, (cell = []));
    cell.push(e);
  }

  // Lanes available in one direction of travel, and their sideways offset (positive = to the right).
  laneCount(e) {
    return e.oneway ? e.lanes : Math.max(1, Math.floor(e.lanes / 2));
  }
  laneOffset(e, lane) {
    const park = e.cls === 0 ? 0 : PARK;
    const n = this.laneCount(e);
    if (e.oneway) {
      const lw = Math.min(3.4, (e.w - 2 * park) / n);
      return (lane - (n - 1) / 2) * lw;
    }
    const lw = Math.min(3.4, (e.w / 2 - park) / n);
    return (lane + 0.5) * lw;
  }

  // Position and heading s metres along a directed edge, lat metres to the right of its centre line.
  pose(de, s, lat, out) {
    const e = de.edge, cum = e.cum, p = e.pts;
    const d = Math.max(0, Math.min(e.len, de.forward ? s : e.len - s));
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const t = (d - cum[i - 1]) / Math.max(cum[i] - cum[i - 1], 1e-6);
    const a = 3 * (i - 1), b = 3 * i;
    let dx = p[b] - p[a], dz = p[b + 1] - p[a + 1];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    if (!de.forward) { dx = -dx; dz = -dz; }
    out.x = p[a] + (p[b] - p[a]) * t - dz * lat;
    out.z = p[a + 1] + (p[b + 1] - p[a + 1]) * t + dx * lat;
    out.y = p[a + 2] + (p[b + 2] - p[a + 2]) * t;
    out.h = Math.atan2(dx, -dz);
    return out;
  }
}

const SPEED = [20, 11.5, 8.5]; // m/s by road class
const MIX = [['sedan', 40], ['suv', 20], ['taxi', 18], ['van', 11], ['truck', 6], ['bus', 5]];
// rarer vehicles, which join the mix only when their model has been loaded
const EXTRA_MIX = [['pickup', 8], ['police', 2.5], ['schoolbus', 1.5], ['ambulance', 1], ['firetruck', 1]];
const wrap = (a) => a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
const tmp = { x: 0, y: 0, z: 0, h: 0 };

export class Traffic {
  constructor(graph, available = []) {
    this.graph = graph;
    this.cars = [];
    this.time = 0;
    this.filled = false;
    this.mix = MIX.concat(EXTRA_MIX.filter((m) => available.includes(m[0])));
    this.mixTotal = this.mix.reduce((s, m) => s + m[1], 0);
  }

  _pickType() {
    let t = Math.random() * this.mixTotal;
    for (const [type, w] of this.mix) if ((t -= w) < 0) return type;
    return 'sedan';
  }

  // focus: where the player is. obstacles: [{ x, z }] things traffic should stop behind (the player's car).
  update(dt, focus, obstacles = []) {
    this.time += dt;
    const radius = 420 + Math.min(focus.y, 500) * 0.8;
    const want = Math.min(420, Math.round(130 * (radius / 420) ** 2));

    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      const far = (c.x - focus.x) ** 2 + (c.z - focus.z) ** 2 > (radius + 160) ** 2;
      if (far || c.done) {
        this._leave(c);
        this.cars[i] = this.cars[this.cars.length - 1];
        this.cars.pop();
      }
    }
    // the first fill may appear anywhere; later arrivals only at the rim, out of sight
    for (let tries = this.filled ? 8 : 4000; tries > 0 && this.cars.length < want; tries--) this._spawn(focus, radius, !this.filled);
    this.filled = true;

    for (const c of this.cars) this._drive(c, dt, obstacles);
  }

  _leave(c) {
    const list = c.de.cars, i = list.indexOf(c);
    if (i >= 0) list.splice(i, 1);
  }

  _spawn(focus, radius, anywhere) {
    const g = this.graph;
    const ang = Math.random() * Math.PI * 2;
    const r = radius * (anywhere ? Math.sqrt(Math.random()) : 0.62 + 0.38 * Math.random());
    const cell = g.cells.get(Math.floor((focus.x + Math.cos(ang) * r) / GRID) * 4096 + Math.floor((focus.z + Math.sin(ang) * r) / GRID));
    if (!cell) return;
    const e = cell[Math.floor(Math.random() * cell.length)];
    if (e.len < 24) return;
    const de = e.rev && Math.random() < 0.5 ? e.rev : e.fwd;
    const lane = Math.floor(Math.random() * g.laneCount(e));
    const s = 9 + Math.random() * (e.len - 18);
    for (const o of de.cars) if (o.lane === lane && Math.abs(o.s - s) < 14) return;
    const type = this._pickType();
    const car = {
      type, tint: paintFor(type, Math.random()), half: CAR_TYPES[type].len / 2,
      de, s, lane, lat: g.laneOffset(e, lane), next: null,
      v: SPEED[e.cls] * 0.7, pace: 0.82 + Math.random() * 0.3, hit: 0, stuck: 0, done: false,
      x: 0, y: 0, z: 0, h: 0,
    };
    g.pose(de, s, car.lat, tmp);
    car.x = tmp.x; car.y = tmp.y; car.z = tmp.z; car.h = tmp.h;
    de.cars.push(car);
    this.cars.push(car);
  }

  _next(c) {
    const node = c.de.to;
    let options = node.out.filter((d) => d.edge !== c.de.edge);
    if (!options.length) options = node.out;
    if (!options.length) return null;
    this.graph.pose(c.de, c.de.edge.len, 0, tmp);
    const heading = tmp.h;
    let total = 0;
    const weights = options.map((d) => {
      this.graph.pose(d, 0, 0, tmp);
      const w = Math.abs(wrap(tmp.h - heading)) < 0.6 ? 6 : 1.4;
      total += w;
      return w;
    });
    let t = Math.random() * total;
    for (let i = 0; i < options.length; i++) if ((t -= weights[i]) < 0) return options[i];
    return options[0];
  }

  _drive(c, dt, obstacles) {
    const g = this.graph;
    if (c.hit > 0) {
      // just been hit by the player: sit still for a moment
      c.hit -= dt;
      c.v = 0;
      return;
    }
    const e = c.de.edge;
    const remain = e.len - c.s;

    // room to the car ahead in this lane
    let free = Infinity;
    for (const o of c.de.cars) if (o !== c && o.lane === c.lane && o.s > c.s) free = Math.min(free, o.s - c.s - o.half - c.half - 2.6);

    // junction ahead: choose where to go, wait for our turn, and don't enter a blocked exit
    if (remain < 12 + c.v * 2) {
      if (!c.next) c.next = this._next(c);
      const node = c.de.to;
      if (!c.next) {
        if (remain < 2) c.done = true; // road leaves the map
      } else {
        const stopLine = remain - 5 - c.half;
        if (node.deg >= 3 && remain > 4.5 + c.half) {
          const green = node.phase === c.de.id && this.time < node.until;
          if (!green) {
            if (this.time >= node.until + 1.1) {
              node.phase = c.de.id;
              node.until = this.time + 5 + Math.random() * 3;
            } else free = Math.min(free, stopLine);
          }
        }
        const lane = Math.min(c.lane, g.laneCount(c.next.edge) - 1);
        for (const o of c.next.cars) if (o.lane === lane && o.s < o.half + c.half + 4) free = Math.min(free, stopLine);
      }
    }

    // anything of the player's in the way
    const sin = Math.sin(c.h), cos = Math.cos(c.h);
    for (const o of obstacles) {
      if (Math.abs((o.y || 0) - c.y) > 3) continue; // above or below us
      const dx = o.x - c.x, dz = o.z - c.z;
      const ahead = dx * sin - dz * cos, side = dx * cos + dz * sin;
      if (ahead > 0 && ahead < 16 && Math.abs(side) < 2.1) free = Math.min(free, ahead - c.half - 4.5);
    }

    const top = SPEED[e.cls] * c.pace;
    const target = free === Infinity ? top : Math.max(0, Math.min(top, free * 0.9));
    c.v += Math.max(-10 * dt, Math.min(3.2 * dt, target - c.v));
    if (free <= 0.1) c.v = 0;
    c.stuck = c.v < 0.2 ? c.stuck + dt : 0;
    if (c.stuck > 40) c.done = true; // hopelessly jammed: quietly remove

    c.s += c.v * dt;
    if (c.s >= e.len && c.next) {
      this._leave(c);
      c.s -= e.len;
      c.de = c.next;
      c.next = null;
      c.lane = Math.min(c.lane, g.laneCount(c.de.edge) - 1);
      c.de.cars.push(c);
    }

    // ease towards the lane position, which also rounds off corners
    const lat = g.laneOffset(c.de.edge, c.lane);
    c.lat += (lat - c.lat) * Math.min(1, dt * 2);
    g.pose(c.de, c.s, c.lat, tmp);
    const k = 1 - Math.exp(-dt * 7);
    c.x += (tmp.x - c.x) * k;
    c.z += (tmp.z - c.z) * k;
    c.y += (tmp.y - c.y) * k;
    c.h += wrap(tmp.h - c.h) * (1 - Math.exp(-dt * 5));
  }
}
