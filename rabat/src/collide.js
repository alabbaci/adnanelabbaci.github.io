// Building footprints in a uniform grid, for "am I inside a building?" and "what am I standing on?".
// Buildings are treated as prisms from their base height (b.m, usually 0) to their top (b.h).

const CELL = 40;

function inRing(x, z, p) {
  let inside = false;
  const n = p.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = p[i], zi = p[i + 1], xj = p[j], zj = p[j + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export class Colliders {
  constructor(buildings) {
    this.items = [];
    this.grid = new Map();
    for (const b of buildings) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < b.p.length; i += 2) {
        const x = b.p[i], z = b.p[i + 1];
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
      }
      const idx = this.items.length;
      this.items.push({ p: b.p, o: b.o, y0: b.m || 0, y1: b.h, x0, x1, z0, z1 });
      for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++)
        for (let j = Math.floor(z0 / CELL); j <= Math.floor(z1 / CELL); j++) {
          const k = i * 65536 + j;
          let cell = this.grid.get(k);
          if (!cell) this.grid.set(k, (cell = []));
          cell.push(idx);
        }
    }
  }

  _cell(x, z) {
    return this.grid.get(Math.floor(x / CELL) * 65536 + Math.floor(z / CELL));
  }

  _inside(it, x, z) {
    if (x < it.x0 || x > it.x1 || z < it.z0 || z > it.z1) return false;
    if (!inRing(x, z, it.p)) return false;
    if (it.o) for (const h of it.o) if (inRing(x, z, h)) return false;
    return true;
  }

  // Is the vertical span [y0, y1] at (x, z) inside a building?
  hitPoint(x, z, y0, y1) {
    const cell = this._cell(x, z);
    if (!cell) return false;
    for (const idx of cell) {
      const it = this.items[idx];
      if (y1 <= it.y0 || y0 >= it.y1) continue;
      if (this._inside(it, x, z)) return true;
    }
    return false;
  }

  // Same test for a small cylinder of radius r.
  hit(x, z, y0, y1, r) {
    return (
      this.hitPoint(x, z, y0, y1) ||
      this.hitPoint(x + r, z, y0, y1) ||
      this.hitPoint(x - r, z, y0, y1) ||
      this.hitPoint(x, z + r, y0, y1) ||
      this.hitPoint(x, z - r, y0, y1)
    );
  }

  // Highest surface under (x, z) that feet at height y can stand on (roofs count; the street is 0).
  floor(x, z, y, step = 0.6) {
    let best = 0;
    const cell = this._cell(x, z);
    if (!cell) return best;
    for (const idx of cell) {
      const it = this.items[idx];
      if (it.y1 <= best || it.y1 > y + step) continue;
      if (this._inside(it, x, z)) best = it.y1;
    }
    return best;
  }
}
