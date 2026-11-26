// Raised road decks (bridges, viaducts, ramps) as something you can stand and drive on.
// Each raised road is a row of sloping segments with a width; heightAt() answers "what deck is under me?".

const CELL = 60;

export class Surfaces {
  constructor(roads) {
    this.segs = [];
    this.grid = new Map();
    for (const r of roads) {
      if (!r.y || !r.y.some((v) => v > 0.3)) continue;
      const hw = r.w / 2 + 0.3;
      for (let i = 0; i + 3 < r.p.length; i += 2) {
        const s = { x0: r.p[i], z0: r.p[i + 1], y0: r.y[i / 2], x1: r.p[i + 2], z1: r.p[i + 3], y1: r.y[i / 2 + 1], hw };
        const index = this.segs.push(s) - 1;
        const i0 = Math.floor((Math.min(s.x0, s.x1) - hw) / CELL), i1 = Math.floor((Math.max(s.x0, s.x1) + hw) / CELL);
        const j0 = Math.floor((Math.min(s.z0, s.z1) - hw) / CELL), j1 = Math.floor((Math.max(s.z0, s.z1) + hw) / CELL);
        for (let a = i0; a <= i1; a++)
          for (let b = j0; b <= j1; b++) {
            const k = a * 65536 + b;
            let cell = this.grid.get(k);
            if (!cell) this.grid.set(k, (cell = []));
            cell.push(index);
          }
      }
    }
  }

  // The highest deck at (x, z) that something at height y could be resting on: decks more than `step`
  // above y are overhead, not underfoot. Returns -Infinity where there is no deck.
  heightAt(x, z, y, step = 1) {
    const cell = this.grid.get(Math.floor(x / CELL) * 65536 + Math.floor(z / CELL));
    let best = -Infinity;
    if (!cell) return best;
    for (const index of cell) {
      const s = this.segs[index];
      const dx = s.x1 - s.x0, dz = s.z1 - s.z0, l2 = dx * dx + dz * dz;
      let t = l2 > 0 ? ((x - s.x0) * dx + (z - s.z0) * dz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ox = x - (s.x0 + dx * t), oz = z - (s.z0 + dz * t);
      if (ox * ox + oz * oz > s.hw * s.hw) continue;
      const h = s.y0 + (s.y1 - s.y0) * t;
      if (h <= y + step && h > best) best = h;
    }
    return best;
  }
}
