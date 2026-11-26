// Foot traffic follows the mapped pavements and crossings in both directions.
const KEY = (x, z) => Math.round(x * 10) * 100003 + Math.round(z * 10);
const GRID = 64;
const TAU = 2 * Math.PI;
const STRIDE = 1.4;
const CAR_RANGE = 14;
const wrap = (h) => h - Math.round(h / TAU) * TAU;
const cellKey = (x, z) => x * 4096 + z;

class WalkGraph {
  constructor(roads) {
    this.nodes = [];
    this.edges = [];
    this.cells = new Map();
    this.minX = this.minZ = Infinity;
    this.maxX = this.maxZ = -Infinity;

    const paths = roads.filter((r) => (r.k === 1 || r.k === 2) && r.p.length >= 4);
    const use = new Map();
    for (const { p } of paths) {
      for (let i = 0; i < p.length; i += 2) {
        const key = KEY(p[i], p[i + 1]);
        use.set(key, (use.get(key) || 0) + (i === 0 || i === p.length - 2 ? 2 : 1));
      }
    }

    const nodeAt = new Map();
    const node = (x, y, z) => {
      const key = KEY(x, z);
      let levels = nodeAt.get(key);
      if (!levels) nodeAt.set(key, (levels = []));
      // A projected point can be shared by a bridge and a path underneath it.
      let n = levels.find((other) => Math.abs(other.y - y) <= 0.5);
      if (!n) {
        n = { y, out: [] };
        levels.push(n);
        this.nodes.push(n);
      }
      return n;
    };

    for (const r of paths) {
      const last = r.p.length / 2 - 1;
      let start = 0;
      for (let i = 1; i <= last; i++) {
        if (i < last && use.get(KEY(r.p[2 * i], r.p[2 * i + 1])) < 2) continue;
        this._addEdge(r, start, i, node);
        start = i;
      }
    }
  }

  _addEdge(r, start, end, node) {
    const { p, y } = r;
    const segments = [];
    let len = 0;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = start; i < end; i++) {
      const x = p[i * 2], z = p[i * 2 + 1];
      const x1 = p[i * 2 + 2], z1 = p[i * 2 + 3];
      const length = Math.hypot(x1 - x, z1 - z);
      if (!Number.isFinite(length)) return;
      if (length < 1e-6) continue;
      const y0 = Number.isFinite(y?.[i]) ? y[i] : 0;
      const y1 = Number.isFinite(y?.[i + 1]) ? y[i + 1] : 0;
      const dx = (x1 - x) / length, dz = (z1 - z) / length;
      const h = Math.atan2(dx, -dz);
      segments.push({ x, y: y0, z, x1, y1, z1, dx, dz, h, reverseH: wrap(h + Math.PI), length, start: len });
      len += length;
      minX = Math.min(minX, x, x1);
      maxX = Math.max(maxX, x, x1);
      minZ = Math.min(minZ, z, z1);
      maxZ = Math.max(maxZ, z, z1);
    }
    if (!len) return;

    const first = segments[0], last = segments[segments.length - 1];
    const a = node(first.x, first.y, first.z), b = node(last.x1, last.y1, last.z1);
    const w = Number.isFinite(r.w) && r.w > 0 ? r.w : 2.4;
    const edge = { segments, len, w, kind: r.k, minX, minZ, maxX, maxZ, checked: -1, blocked: false };
    edge.fwd = { edge, forward: true, to: b, startH: first.h, endH: last.h };
    edge.rev = { edge, forward: false, to: a, startH: last.reverseH, endH: first.reverseH };
    a.out.push(edge.fwd);
    b.out.push(edge.rev);
    this.edges.push(edge);

    // Index the whole path, including long segments whose midpoint may be far from the player.
    for (const segment of segments) {
      segment.edge = edge;
      const x0 = Math.floor(Math.min(segment.x, segment.x1) / GRID);
      const x1 = Math.floor(Math.max(segment.x, segment.x1) / GRID);
      const z0 = Math.floor(Math.min(segment.z, segment.z1) / GRID);
      const z1 = Math.floor(Math.max(segment.z, segment.z1) / GRID);
      this.minX = Math.min(this.minX, x0);
      this.maxX = Math.max(this.maxX, x1);
      this.minZ = Math.min(this.minZ, z0);
      this.maxZ = Math.max(this.maxZ, z1);
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const key = cellKey(x, z);
          let cell = this.cells.get(key);
          if (!cell) this.cells.set(key, (cell = []));
          cell.push(segment);
        }
      }
    }
  }

  pose(route, s, lane, out) {
    const { edge, forward } = route;
    const { segments, len } = edge;
    const d = forward ? s : len - s;
    let low = 0, high = segments.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >>> 1;
      if (segments[mid].start <= d) low = mid;
      else high = mid - 1;
    }
    const seg = segments[low];
    const along = Math.max(0, Math.min(seg.length, d - seg.start));
    const t = along / seg.length;
    // Meet at the centre of a junction. At internal bends, blend the two right vectors.
    let dx = seg.dx, dz = seg.dz;
    const before = segments[low - 1], after = segments[low + 1];
    const reach = Math.min(1, seg.length * 0.5);
    if (before) {
      const blend = Math.max(0, 1 - along / reach) * 0.5;
      dx += (before.dx - seg.dx) * blend;
      dz += (before.dz - seg.dz) * blend;
    }
    if (after) {
      const blend = Math.max(0, 1 - (seg.length - along) / reach) * 0.5;
      dx += (after.dx - seg.dx) * blend;
      dz += (after.dz - seg.dz) * blend;
    }
    const lat = Math.min(edge.w * lane, 0.85, s * 0.55, (len - s) * 0.55) * (forward ? 1 : -1);
    out.x = seg.x + seg.dx * along - dz * lat;
    out.z = seg.z + seg.dz * along + dx * lat;
    out.y = seg.y + (seg.y1 - seg.y) * t;
    out.h = forward ? seg.h : seg.reverseH;
  }
}

export class Pedestrians {
  constructor(roads, { count = 220, radius = 170, kinds = 1 } = {}) {
    this.people = [];
    this._graph = new WalkGraph(roads);
    this._count = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 220;
    this._radius = Number.isFinite(radius) ? Math.max(0, radius) : 170;
    this._motion = new WeakMap();
    this._pose = { x: 0, y: 0, z: 0, h: 0 };
    this._spawnCells = [];
    this._filled = false;
    this._frame = 0;
    this.setKinds(kinds);
  }

  setKinds(n) {
    this._kinds = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1;
  }

  update(dt, focus, cars) {
    const { people } = this;
    if (focus.y > 140) {
      for (const person of people) this._motion.delete(person);
      people.length = 0;
      return;
    }

    const elapsed = Number.isFinite(dt) && dt > 0 ? dt : 0;
    // Limit travel after a frame hitch. Waiting and knockdown timers use elapsed time.
    const step = Math.min(elapsed, 0.25);
    const ease = 1 - Math.exp(-14 * step), turn = 1 - Math.exp(-9 * step);
    const radius2 = this._radius ** 2;
    this._frame++;
    for (let i = people.length - 1; i >= 0; i--) {
      const person = people[i], m = this._motion.get(person);
      if (this._distance2(person, focus) <= radius2) {
        if (elapsed > 0) {
          if (person.state === 'down') this._slide(person, m, elapsed);
          else this._walk(person, m, step, elapsed, ease, turn, cars);
        }
        if (m.life > 0 && this._distance2(person, focus) <= radius2) continue;
      }
      this._motion.delete(person);
      people[i] = people[people.length - 1];
      people.pop();
    }

    if (people.length < this._count && radius2 > 0) this._refill(focus, radius2, cars);
  }

  knock(person, vx, vz) {
    const m = this._motion.get(person);
    if (!m || person.state === 'down') return;
    const x = Number.isFinite(vx) ? vx * 0.35 : 0;
    const z = Number.isFinite(vz) ? vz * 0.35 : 0;
    const speed = Math.hypot(x, z);
    m.slideX = speed > 0 ? x / speed : 0;
    m.slideZ = speed > 0 ? z / speed : 0;
    person.speed = Math.min(speed, 8);
    m.life = Math.max(1 / 3, person.speed / 6) + 2.5 + Math.random() * 1.5;
    person.state = 'down';
    person.crossing = false;
  }

  _slide(person, m, dt) {
    m.life -= dt;
    if (m.life <= 0) return;
    const moving = Math.min(dt, person.speed / 6);
    const distance = (person.speed - 3 * moving) * moving;
    person.x += m.slideX * distance;
    person.z += m.slideZ * distance;
    person.speed = Math.max(0, person.speed - 6 * moving);
    person.tilt = Math.min(1, person.tilt + dt * 3);
  }

  _distance2(p, focus) {
    return (p.x - focus.x) ** 2 + (p.z - focus.z) ** 2;
  }

  _refill(focus, radius2, cars) {
    const { _graph: graph, _radius: radius, _spawnCells: cells } = this;
    const x0 = Math.max(graph.minX, Math.floor((focus.x - radius) / GRID));
    const x1 = Math.min(graph.maxX, Math.floor((focus.x + radius) / GRID));
    const z0 = Math.max(graph.minZ, Math.floor((focus.z - radius) / GRID));
    const z1 = Math.min(graph.maxZ, Math.floor((focus.z + radius) / GRID));
    const inner2 = this._filled ? (radius * 0.65) ** 2 : 0;
    cells.length = 0;
    for (let x = x0; x <= x1; x++) {
      const farX = Math.max(Math.abs(x * GRID - focus.x), Math.abs((x + 1) * GRID - focus.x)) + 0.85;
      for (let z = z0; z <= z1; z++) {
        const farZ = Math.max(Math.abs(z * GRID - focus.z), Math.abs((z + 1) * GRID - focus.z)) + 0.85;
        if (farX * farX + farZ * farZ < inner2) continue;
        const cell = graph.cells.get(cellKey(x, z));
        if (cell) cells.push(cell);
      }
    }
    if (!cells.length) return;

    const tries = this._filled ? 24 : Math.max(400, this._count * 10);
    for (let i = 0; i < tries && this.people.length < this._count; i++) {
      const cell = cells[Math.floor(Math.random() * cells.length)];
      const segment = cell[Math.floor(Math.random() * cell.length)];
      this._spawn(segment, focus, inner2, radius2, cars);
    }
    if (this.people.length) this._filled = true;
  }

  _spawn(segment, focus, inner2, radius2, cars) {
    // Sample only the portion near the player, even on very long straight paths.
    const dx = focus.x - segment.x, dz = focus.z - segment.z;
    const side = dx * segment.dz - dz * segment.dx;
    const span2 = radius2 - side * side;
    if (span2 <= 0) return;
    const centre = dx * segment.dx + dz * segment.dz;
    const span = Math.sqrt(span2);
    const lo = Math.max(0, centre - span), hi = Math.min(segment.length, centre + span);
    if (hi <= lo) return;

    const edge = segment.edge, route = Math.random() < 0.5 ? edge.fwd : edge.rev;
    const distance = segment.start + lo + (hi - lo) * Math.random();
    const s = route.forward ? distance : edge.len - distance;
    const lane = 0.15 + Math.random() * 0.15;
    const pose = this._pose;
    this._graph.pose(route, s, lane, pose);
    const d2 = this._distance2(pose, focus);
    if (d2 < inner2 || d2 > radius2 || (edge.kind === 2 && this._carsNear(edge, cars))) return;

    const pace = (Math.random() < 1 / 12 ? 2.8 : 1.1) + Math.random() * 0.6;
    const person = {
      x: pose.x, y: pose.y, z: pose.z, h: pose.h, speed: pace, phase: Math.random() * TAU,
      kind: Math.floor(Math.random() * this._kinds), scale: 0.92 + Math.random() * 0.16,
      state: 'walk', crossing: edge.kind === 2, tilt: 0,
    };
    this._motion.set(person, {
      route, s, lane, pace, next: null, wait: 0, patience: 1.5 + Math.random() * 2.5,
      life: 1, slideX: 0, slideZ: 0,
    });
    this.people.push(person);
  }

  _next(route) {
    const exits = route.to.out;
    const back = route.forward ? route.edge.rev : route.edge.fwd;
    if (exits.length === 1) return back;
    let total = 0;
    let next = back;
    for (const exit of exits) {
      if (exit === back) continue;
      const weight = 1 + 0.75 * Math.max(0, Math.cos(exit.startH - route.endH));
      total += weight;
      if (Math.random() * total < weight) next = exit;
    }
    return next;
  }

  _walk(person, m, dt, elapsed, ease, turn, cars) {
    if (person.state === 'wait') {
      m.wait -= elapsed;
      if (m.wait > 0 && this._carsNear(m.next.edge, cars)) return;
      m.route = m.next;
      m.next = null;
      m.s = 0;
      person.state = 'walk';
    }

    let distance = m.pace * dt;
    while (distance >= m.route.edge.len - m.s) {
      distance -= m.route.edge.len - m.s;
      const next = this._next(m.route);
      if (m.route.edge.kind !== 2 && next.edge.kind === 2 && this._carsNear(next.edge, cars)) {
        m.s = m.route.edge.len;
        m.next = next;
        m.wait = m.patience;
        person.state = 'wait';
        break;
      }
      m.route = next;
      m.s = 0;
    }
    if (person.state === 'walk') m.s += distance;

    const pose = this._pose;
    this._graph.pose(m.route, m.s, m.lane, pose);
    const dx = (pose.x - person.x) * ease, dy = (pose.y - person.y) * ease, dz = (pose.z - person.z) * ease;
    person.x += dx;
    person.y += dy;
    person.z += dz;
    person.h = wrap(person.h + wrap(pose.h - person.h) * turn);
    person.phase = (person.phase + Math.sqrt(dx * dx + dy * dy + dz * dz) * TAU / STRIDE) % TAU;
    person.crossing = m.route.edge.kind === 2;
    person.speed = person.state === 'walk' ? m.pace : 0;
  }

  _carsNear(edge, cars) {
    if (edge.checked === this._frame) return edge.blocked;
    edge.checked = this._frame;
    edge.blocked = false;
    for (const car of cars) {
      if (car.v <= 2 || car.x < edge.minX - CAR_RANGE || car.x > edge.maxX + CAR_RANGE ||
          car.z < edge.minZ - CAR_RANGE || car.z > edge.maxZ + CAR_RANGE) continue;
      for (const seg of edge.segments) {
        const dx = car.x - seg.x, dz = car.z - seg.z;
        const along = Math.max(0, Math.min(seg.length, dx * seg.dx + dz * seg.dz));
        const y = seg.y + (seg.y1 - seg.y) * (along / seg.length);
        if (Math.abs(car.y - y) > 3) continue;
        if ((dx - along * seg.dx) ** 2 + (dz - along * seg.dz) ** 2 <= CAR_RANGE ** 2) {
          edge.blocked = true;
          return true;
        }
      }
    }
    return false;
  }
}
