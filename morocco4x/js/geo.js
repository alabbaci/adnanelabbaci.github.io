// Hex grid geometry and map projection. Mirrors pipeline/common.py.
// World coordinates are kilometres: +x east, +y south, origin at the frame's north-west corner.

export const SQ3 = Math.sqrt(3);

export function decode(b64, Type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return Type === Uint8Array ? bytes : new Type(bytes.buffer);
}

// Direction order: E, SE, SW, W, NW, NE. Edge d runs between corner d and corner d+1.
const DIRS_EVEN = [[1, 0], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1]];
const DIRS_ODD = [[1, 0], [1, 1], [0, 1], [-1, 0], [0, -1], [1, -1]];

export class Grid {
  constructor(w) {
    this.cols = w.cols;
    this.rows = w.rows;
    this.n = w.cols * w.rows;
    this.hexKm = w.hexKm;
    this.size = w.hexKm / SQ3;
    this.rowKm = 1.5 * this.size;
    this.width = this.cols * this.hexKm + this.hexKm / 2;
    this.height = (this.rows - 1) * this.rowKm + 2 * this.size;
    this.proj = w.proj;
    // unit corner offsets (pointy-top): angle -30 + 60k degrees, y down
    this.corners = [];
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 180) * (-30 + 60 * k);
      this.corners.push([this.size * Math.cos(a), this.size * Math.sin(a)]);
    }
  }
  col(i) { return i % this.cols; }
  row(i) { return (i / this.cols) | 0; }
  cx(i) { const r = (i / this.cols) | 0; return this.hexKm * ((i % this.cols) + 0.5 * (r & 1)) + this.hexKm / 2; }
  cy(i) { return this.rowKm * ((i / this.cols) | 0) + this.size; }
  neighbor(i, d) {
    const c = i % this.cols, r = (i / this.cols) | 0;
    const o = (r & 1 ? DIRS_ODD : DIRS_EVEN)[d];
    const cc = c + o[0], rr = r + o[1];
    if (cc < 0 || rr < 0 || cc >= this.cols || rr >= this.rows) return -1;
    return rr * this.cols + cc;
  }
  cellAt(x, y) {
    const fx = (x - this.hexKm / 2) / this.size, fy = (y - this.size) / this.size;
    const q = (SQ3 / 3) * fx - fy / 3, r = (2 / 3) * fy;
    let rx = Math.round(q), rz = Math.round(r), ry = Math.round(-q - r);
    const dx = Math.abs(rx - q), dy = Math.abs(ry + q + r), dz = Math.abs(rz - r);
    if (dx > dy && dx > dz) rx = -ry - rz; else if (dy <= dz) rz = -rx - ry;
    const row = rz, col = rx + (rz - (rz & 1)) / 2;
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return -1;
    return row * this.cols + col;
  }
  hexPath(ctx, i) {
    const x = this.cx(i), y = this.cy(i), c = this.corners;
    ctx.moveTo(x + c[0][0], y + c[0][1]);
    for (let k = 1; k < 6; k++) ctx.lineTo(x + c[k][0], y + c[k][1]);
    ctx.closePath();
  }
  // km in the frame -> [lon, lat] degrees (inverse Lambert azimuthal equal-area, sphere)
  lonLat(x, y) {
    const p = this.proj, R = p.R, px = x + p.xmin, py = p.ymax - y;
    const phi0 = (p.lat0 * Math.PI) / 180;
    const rho = Math.hypot(px, py) || 1e-12;
    const c = 2 * Math.asin(Math.min(1, rho / (2 * R)));
    const lat = Math.asin(Math.cos(c) * Math.sin(phi0) + (py * Math.sin(c) * Math.cos(phi0)) / rho);
    const lon = p.lon0 + (180 / Math.PI) * Math.atan2(px * Math.sin(c), rho * Math.cos(phi0) * Math.cos(c) - py * Math.sin(phi0) * Math.sin(c));
    return [lon, (lat * 180) / Math.PI];
  }
}

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
// small deterministic hash -> [0,1)
export function rnd(i, salt = 0) {
  let h = (i * 374761393 + salt * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h ^= h >>> 16;
  return ((h >>> 0) % 100000) / 100000;
}
