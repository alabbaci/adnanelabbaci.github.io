// Terrain renderer: draws the hex world into cached 512px tiles at a few zoom levels.
import { rnd, clamp } from "./geo.js";

export const LODS = [0.5, 0.8, 1.25, 2, 3.2, 5, 8, 12.5]; // device px per km
const TILE = 512;
const MAX_TILES = 90;

const F_FOREST = 1, F_OASIS = 2, F_MARSH = 4, F_URBAN = 8, F_SNOW = 16;

const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const css = (c, a) => a == null ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mul = (c, f) => [Math.min(255, c[0] * f), Math.min(255, c[1] * f), Math.min(255, c[2] * f)];

export const BIOME_RGB = {
  farmland: [163, 176, 92], grassland: [181, 173, 106], scrub: [152, 151, 99], desert: [224, 198, 144],
  lake: [62, 132, 168], coast: [40, 100, 134], deep: [15, 38, 66], shallow: [28, 78, 116],
  forest: [70, 112, 60], rock: [128, 118, 100], rockDesert: [158, 122, 86],
};
// Land that is on the map for context but not part of the 12 regions: greyed and dimmed.
function outOfPlay(c) {
  const l = 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
  return mul(mix(c, [l * 0.95, l * 0.92, l * 0.86], 0.72), 0.62);
}

export function terrainColor(w, i) {
  const b = w.biome[i], e = w.elev[i];
  if (b === 0) return mix(BIOME_RGB.shallow, BIOME_RGB.deep, clamp(-e / 2800, 0, 1));
  if (b === 1) return mix(BIOME_RGB.coast, BIOME_RGB.shallow, clamp(-e / 400, 0, 1) * 0.6);
  if (b === 2) return BIOME_RGB.lake;
  let c = b === 3 ? BIOME_RGB.farmland : b === 4 ? BIOME_RGB.grassland : b === 5 ? BIOME_RGB.scrub : BIOME_RGB.desert;
  const rl = w.relief[i], f = w.feat[i];
  if (rl === 1) c = mix(c, b === 6 ? BIOME_RGB.rockDesert : BIOME_RGB.rock, 0.22);
  else if (rl === 2) c = mix(c, b === 6 ? BIOME_RGB.rockDesert : BIOME_RGB.rock, 0.6);
  if (f & F_FOREST) c = mix(c, BIOME_RGB.forest, 0.55);
  else if (b !== 6) c = mix(c, BIOME_RGB.forest, Math.min(0.3, w.tree[i] / 100));
  if (f & F_OASIS) c = mix(c, [150, 170, 96], 0.3);
  const sh = clamp(1 + (w.shade[i] / 255 - 0.707) * 1.3, 0.62, 1.32);
  c = mul(c, sh * (0.975 + 0.05 * rnd(i, 1)));
  return w.province[i] ? c : outOfPlay(c);
}

export class MapRenderer {
  constructor(world) {
    this.w = world;
    this.g = world.grid;
    this.cache = new Map();
    this.rgb = new Uint8Array(this.g.n * 3);
    this.layers = { borders: true, provinces: true, rivers: true, roads: true, rail: true, grid: false };
    this.lens = null;        // {color(i) -> [r,g,b] | null}
    this.base = null;        // whole-world low-res image, used while tiles are pending and by the minimap
    this.recolor();
  }

  setLens(lens) { this.lens = lens; this.recolor(); }
  setLayers(l) { Object.assign(this.layers, l); this.cache.clear(); }

  recolor() {
    const w = this.w, n = this.g.n, rgb = this.rgb, lens = this.lens;
    for (let i = 0; i < n; i++) {
      let c;
      if (lens) {
        const land = w.biome[i] > 2;
        if (!land) c = w.biome[i] === 2 ? [40, 62, 84] : mix([24, 36, 52], [16, 24, 36], clamp(-w.elev[i] / 2800, 0, 1));
        else {
          c = lens.color(i);
          const sh = clamp(1 + (w.shade[i] / 255 - 0.707) * 0.9, 0.7, 1.22);
          c = c ? mul(c, sh) : mul(w.province[i] ? [70, 76, 88] : [44, 50, 60], sh);
        }
      } else c = terrainColor(w, i);
      rgb[i * 3] = c[0]; rgb[i * 3 + 1] = c[1]; rgb[i * 3 + 2] = c[2];
    }
    this.cache.clear();
    this.base = this.renderWorld(0.5);
  }

  pickLod(kd) {
    for (let i = 0; i < LODS.length; i++) if (LODS[i] >= kd * 0.8) return i;
    return LODS.length - 1;
  }

  // Draw the visible map. Returns true while some tiles are still missing.
  draw(ctx, cam, vw, vh, dpr) {
    const kd = cam.k * dpr, L = this.pickLod(kd), s = LODS[L], tk = TILE / s;
    const left = cam.x - vw / 2 / cam.k, top = cam.y - vh / 2 / cam.k;
    const right = left + vw / cam.k, bottom = top + vh / cam.k;
    const tx0 = Math.max(0, Math.floor(left / tk)), tx1 = Math.min(Math.ceil(this.g.width / tk) - 1, Math.floor(right / tk));
    const ty0 = Math.max(0, Math.floor(top / tk)), ty1 = Math.min(Math.ceil(this.g.height / tk) - 1, Math.floor(bottom / tk));
    const need = [];
    let pending = false;
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const key = L + ":" + tx + ":" + ty;
      const t = this.cache.get(key);
      if (t) { this.cache.delete(key); this.cache.set(key, t); }
      need.push([key, tx, ty, t]);
      if (!t) pending = true;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "low";
    if (pending) {
      const b = this.base;
      ctx.drawImage(b, (0 - left) * kd, (0 - top) * kd, this.g.width * kd, this.g.height * kd);
    }
    const t0 = performance.now();
    pending = false;
    // nearest-to-centre first so the middle of the screen sharpens first
    const cxT = cam.x / tk - 0.5, cyT = cam.y / tk - 0.5;
    need.sort((a, b) => Math.hypot(a[1] - cxT, a[2] - cyT) - Math.hypot(b[1] - cxT, b[2] - cyT));
    for (const n of need) {
      let t = n[3];
      if (!t) {
        if (performance.now() - t0 > 14) { pending = true; continue; }
        t = this.renderTile(L, n[1], n[2]);
        this.cache.set(n[0], t);
        if (this.cache.size > MAX_TILES) this.cache.delete(this.cache.keys().next().value);
      }
      const x0 = Math.round((n[1] * tk - left) * kd), x1 = Math.round(((n[1] + 1) * tk - left) * kd);
      const y0 = Math.round((n[2] * tk - top) * kd), y1 = Math.round(((n[2] + 1) * tk - top) * kd);
      ctx.drawImage(t, x0, y0, x1 - x0, y1 - y0);
    }
    return pending;
  }

  // One canvas with the whole world at `s` px/km (used for the minimap and as a stand-in).
  renderWorld(s) {
    const cv = document.createElement("canvas");
    cv.width = Math.ceil(this.g.width * s); cv.height = Math.ceil(this.g.height * s);
    const ctx = cv.getContext("2d");
    ctx.setTransform(s, 0, 0, s, 0, 0);
    this.paint(ctx, s, 0, 0, this.g.width, this.g.height, true);
    return cv;
  }

  renderTile(L, tx, ty) {
    const s = LODS[L], tk = TILE / s;
    const cv = document.createElement("canvas");
    cv.width = cv.height = TILE;
    const ctx = cv.getContext("2d");
    ctx.setTransform(s, 0, 0, s, -tx * tk * s, -ty * tk * s);
    this.paint(ctx, s, tx * tk, ty * tk, (tx + 1) * tk, (ty + 1) * tk, false);
    return cv;
  }

  // Paint world rect [x0,y0]-[x1,y1] (km) into ctx, which is already scaled by s px/km.
  paint(ctx, s, x0, y0, x1, y1, plain) {
    const g = this.g, w = this.w, rgb = this.rgb, lens = !!this.lens, ly = this.layers;
    const hw = g.hexKm * s;                       // hex width in px
    const tier = hw < 9 ? 0 : hw < 24 ? 1 : 2;
    const pad = 1;
    const c0 = Math.max(0, Math.floor(x0 / g.hexKm) - 1 - pad), c1 = Math.min(g.cols - 1, Math.ceil(x1 / g.hexKm) + pad);
    const r0 = Math.max(0, Math.floor((y0 - g.size) / g.rowKm) - 1 - pad), r1 = Math.min(g.rows - 1, Math.ceil(y1 / g.rowKm) + pad);
    const px = 1 / s;                             // one pixel in km
    ctx.fillStyle = "#0f2134";
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);

    // ---- 1. hex fills (slightly oversized so neighbours overlap instead of leaving seams)
    const k = 1 + 0.9 / hw, cr = g.corners;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const i = r * g.cols + c, x = g.cx(i), y = g.cy(i);
      ctx.fillStyle = `rgb(${rgb[i * 3]},${rgb[i * 3 + 1]},${rgb[i * 3 + 2]})`;
      ctx.beginPath();
      ctx.moveTo(x + cr[0][0] * k, y + cr[0][1] * k);
      for (let q = 1; q < 6; q++) ctx.lineTo(x + cr[q][0] * k, y + cr[q][1] * k);
      ctx.fill();
    }

    // ---- 2. hex grid
    if (!plain && tier >= 1 && (ly.grid || tier === 2)) {
      ctx.beginPath();
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const i = r * g.cols + c, x = g.cx(i), y = g.cy(i);
        // three edges per hex are enough to draw every edge once
        ctx.moveTo(x + cr[5][0], y + cr[5][1]); ctx.lineTo(x + cr[0][0], y + cr[0][1]);
        ctx.lineTo(x + cr[1][0], y + cr[1][1]); ctx.lineTo(x + cr[2][0], y + cr[2][1]);
      }
      ctx.strokeStyle = ly.grid ? "rgba(0,0,0,.22)" : "rgba(0,0,0,.075)";
      ctx.lineWidth = px;
      ctx.stroke();
    }

    // ---- 3. rivers, roads, rail
    if (!plain) this.paintLines(ctx, s, x0, y0, x1, y1, lens);

    // ---- 4. terrain sprites, back to front
    if (!plain && !lens && tier >= 1) {
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const i = r * g.cols + c;
        if (w.biome[i] > 2 || tier === 2) this.sprite(ctx, i, tier, hw, px);
      }
    }

    // ---- 5. coast and borders
    const coast = new Path2D(), prov = new Path2D(), reg = new Path2D(), nat = new Path2D();
    const P = w.province, R = w.region, B = w.biome;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const i = r * g.cols + c;
      if (B[i] <= 2) continue;
      const x = g.cx(i), y = g.cy(i), pi = P[i];
      for (let d = 0; d < 6; d++) {
        const j = g.neighbor(i, d);
        if (j < 0) continue;
        let path = null;
        if (B[j] <= 2) path = coast;
        else if (pi && !P[j]) path = nat;
        else if (pi && j > i) path = R[j] !== R[i] ? reg : P[j] !== pi ? prov : null;
        if (!path) continue;
        const a = cr[d], b = cr[(d + 1) % 6];
        path.moveTo(x + a[0], y + a[1]); path.lineTo(x + b[0], y + b[1]);
      }
    }
    const bw = tier === 0 ? 0.6 : tier === 1 ? 0.85 : 1.15;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = lens ? "rgba(0,0,0,.6)" : "rgba(18,30,42,.55)"; ctx.lineWidth = px * (tier === 0 ? 0.7 : 1.1); ctx.stroke(coast);
    if (plain) { ctx.strokeStyle = "rgba(190,52,54,.95)"; ctx.lineWidth = px * 1.1; ctx.stroke(nat); return; }
    if (ly.provinces && tier >= 1) {
      ctx.setLineDash([px * 3.2, px * 3.2]);
      ctx.strokeStyle = lens ? "rgba(0,0,0,.42)" : "rgba(58,36,14,.5)"; ctx.lineWidth = px * 1; ctx.stroke(prov);
      ctx.setLineDash([]);
    }
    if (ly.borders) {
      ctx.strokeStyle = "rgba(28,16,6,.62)"; ctx.lineWidth = px * 3.4 * bw; ctx.stroke(reg);
      ctx.strokeStyle = "rgba(255,246,220,.92)"; ctx.lineWidth = px * 1.45 * bw; ctx.stroke(reg);
    }
    ctx.strokeStyle = "rgba(40,8,8,.7)"; ctx.lineWidth = px * 4.4 * bw; ctx.stroke(nat);
    ctx.strokeStyle = "#d64541"; ctx.lineWidth = px * 2.1 * bw; ctx.stroke(nat);
  }

  paintLines(ctx, s, x0, y0, x1, y1, lens) {
    const L = this.w.lines, ly = this.layers, px = 1 / s;
    if (!L) return;
    const hit = (o) => o.b[0] <= x1 && o.b[2] >= x0 && o.b[1] <= y1 && o.b[3] >= y0;
    const trace = (list, test) => {
      ctx.beginPath();
      for (const o of list) {
        if (!hit(o) || (test && !test(o))) continue;
        const p = o.p;
        ctx.moveTo(p[0], p[1]);
        for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
      }
    };
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (ly.rivers && s >= 0.8) {
      for (const rank of [2, 1, 0]) {
        const wd = (rank === 2 ? 2.6 : rank === 1 ? 1.9 : 1.3) * clamp(s / 2.2, 0.55, 2.2);
        // seasonal wadis: thinner, paler, dashed
        trace(L.rivers, (o) => o.w === rank && o.i);
        ctx.setLineDash([px * 5, px * 4]);
        ctx.strokeStyle = lens ? "rgba(140,190,225,.4)" : "rgba(84,150,190,.62)"; ctx.lineWidth = px * wd * 0.8; ctx.stroke();
        ctx.setLineDash([]);
        trace(L.rivers, (o) => o.w === rank && !o.i);
        ctx.strokeStyle = lens ? "rgba(120,170,205,.55)" : "rgba(24,58,84,.5)"; ctx.lineWidth = px * (wd + 1.2); ctx.stroke();
        ctx.strokeStyle = lens ? "rgba(140,190,225,.8)" : "#5fa7cf"; ctx.lineWidth = px * wd; ctx.stroke();
      }
    }
    if (ly.roads && s >= 0.8) {
      const f = clamp(s / 2.5, 0.6, 1.8);
      if (s >= 2) {
        trace(L.roads, (o) => o.c === 1);
        ctx.strokeStyle = lens ? "rgba(255,255,255,.28)" : "rgba(92,62,28,.62)"; ctx.lineWidth = px * 0.9 * f; ctx.stroke();
      }
      trace(L.roads, (o) => o.c === 0);
      ctx.strokeStyle = lens ? "rgba(0,0,0,.45)" : "rgba(64,38,12,.7)"; ctx.lineWidth = px * 2.6 * f; ctx.stroke();
      ctx.strokeStyle = lens ? "rgba(255,255,255,.6)" : "#e9c877"; ctx.lineWidth = px * 1.2 * f; ctx.stroke();
    }
    if (ly.rail && s >= 0.8) {
      const f = clamp(s / 2.5, 0.6, 1.8);
      trace(L.rail);
      ctx.strokeStyle = lens ? "rgba(0,0,0,.6)" : "rgba(34,26,26,.85)"; ctx.lineWidth = px * 1.5 * f; ctx.stroke();
      ctx.setLineDash([px * 3 * f, px * 3 * f]);
      ctx.strokeStyle = lens ? "rgba(255,255,255,.55)" : "rgba(236,226,206,.9)"; ctx.lineWidth = px * 0.75 * f; ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Procedural terrain art for one hex. Deterministic: the same hex always looks the same.
  sprite(ctx, i, tier, hw, px) {
    const g = this.g, w = this.w, b = w.biome[i], rl = w.relief[i], f = w.feat[i];
    const x = g.cx(i), y = g.cy(i), u = g.size, play = w.province[i] > 0 || b <= 2;
    const tone = (c) => css(play ? c : outOfPlay(c));
    if (b <= 2) {                                   // water: a few wave marks at close zoom
      if (hw < 40 || rnd(i, 3) > 0.3) return;
      ctx.strokeStyle = "rgba(190,225,240,.16)"; ctx.lineWidth = px * 1.2; ctx.lineCap = "round";
      ctx.beginPath();
      const ox = (rnd(i, 4) - 0.5) * u * 0.6, oy = (rnd(i, 5) - 0.5) * u * 0.6;
      ctx.moveTo(x + ox - u * 0.28, y + oy); ctx.quadraticCurveTo(x + ox - u * 0.14, y + oy - u * 0.1, x + ox, y + oy);
      ctx.quadraticCurveTo(x + ox + u * 0.14, y + oy + u * 0.1, x + ox + u * 0.28, y + oy);
      ctx.stroke();
      return;
    }
    const desert = b === 6;
    if (rl === 2) {
      const n = tier === 1 ? 2 : 3;
      const lit = desert ? [206, 170, 120] : [176, 168, 148], dark = desert ? [128, 96, 66] : [96, 90, 82];
      const peaks = [];
      for (let q = 0; q < n; q++) peaks.push([x + (rnd(i, 10 + q) - 0.5) * u * 1.15, y + u * (0.18 + 0.34 * q / Math.max(1, n - 1)) + (rnd(i, 20 + q) - 0.5) * u * 0.12,
        u * (0.8 + rnd(i, 30 + q) * 0.55), u * (0.78 + rnd(i, 40 + q) * 0.4)]);
      for (const [mx, by, h, wd] of peaks) {
        ctx.fillStyle = tone(lit);
        ctx.beginPath(); ctx.moveTo(mx - wd / 2, by); ctx.lineTo(mx, by - h); ctx.lineTo(mx + wd * 0.12, by); ctx.fill();
        ctx.fillStyle = tone(dark);
        ctx.beginPath(); ctx.moveTo(mx, by - h); ctx.lineTo(mx + wd / 2, by); ctx.lineTo(mx + wd * 0.12, by); ctx.fill();
        if (f & F_SNOW) {
          ctx.fillStyle = tone([246, 248, 250]);
          ctx.beginPath(); ctx.moveTo(mx, by - h); ctx.lineTo(mx - wd * 0.19, by - h * 0.62); ctx.lineTo(mx - wd * 0.05, by - h * 0.7);
          ctx.lineTo(mx + wd * 0.03, by - h * 0.56); ctx.lineTo(mx + wd * 0.1, by - h * 0.72); ctx.lineTo(mx + wd * 0.2, by - h * 0.6); ctx.fill();
        }
      }
      if (f & F_FOREST && tier === 2) this.trees(ctx, i, 3, true, tone, y + u * 0.5);
      return;
    }
    if (rl === 1) {
      const n = tier === 1 ? 2 : 3;
      const base = [rgbAt(this.rgb, i, 0.8), rgbAt(this.rgb, i, 1.13)];
      for (let q = 0; q < n; q++) {
        const mx = x + (rnd(i, 10 + q) - 0.5) * u * 1.1, by = y + u * (-0.05 + 0.3 * q) + (rnd(i, 20 + q) - 0.5) * u * 0.15;
        const wd = u * (0.62 + rnd(i, 30 + q) * 0.3), h = u * (0.26 + rnd(i, 40 + q) * 0.14);
        ctx.fillStyle = css(base[0]);
        ctx.beginPath(); ctx.ellipse(mx, by, wd / 2, h, 0, Math.PI, 0); ctx.fill();
        ctx.fillStyle = css(base[1]);
        ctx.beginPath(); ctx.ellipse(mx - wd * 0.09, by, wd * 0.38, h * 0.82, 0, Math.PI, 0); ctx.fill();
      }
    }
    if (f & F_FOREST) { this.trees(ctx, i, tier === 1 ? 3 : rl ? 4 : 6, w.elev[i] > 1250, tone, null); }
    else if (f & F_OASIS) this.oasis(ctx, i, tier, px, tone);
    if (f & F_URBAN) { this.town(ctx, i, tier, tone); return; }
    if (tier < 2 || rl) return;
    if (b === 3) {                                  // farmland: a patchwork of fields
      const cols = [[196, 200, 100], [142, 164, 76], [210, 192, 112], [170, 186, 88]];
      const a = (rnd(i, 50) - 0.5) * 0.9;
      ctx.save(); ctx.translate(x, y); ctx.rotate(a);
      const fw = u * 0.42, fh = u * 0.26;
      for (let q = 0; q < 4; q++) {
        if (rnd(i, 60 + q) < 0.2) continue;
        const fx = (q % 2 ? 0.04 : -0.46) * u, fy = (q < 2 ? -0.3 : 0.03) * u;
        ctx.fillStyle = tone(cols[(q + ((rnd(i, 70) * 4) | 0)) % 4]);
        ctx.fillRect(fx, fy, fw, fh);
        ctx.strokeStyle = "rgba(60,70,20,.28)"; ctx.lineWidth = px * 0.8; ctx.strokeRect(fx, fy, fw, fh);
      }
      ctx.restore();
    } else if (desert && !(f & F_OASIS)) {          // dunes
      if (rnd(i, 51) > 0.55) return;
      const ox = (rnd(i, 52) - 0.5) * u * 0.5, oy = (rnd(i, 53) - 0.5) * u * 0.5;
      ctx.lineCap = "round"; ctx.lineWidth = px * 1.3;
      for (let q = 0; q < 2; q++) {
        const yy = y + oy + q * u * 0.24, xx = x + ox + q * u * 0.16;
        ctx.strokeStyle = play ? "rgba(150,112,62,.4)" : "rgba(40,36,30,.3)";
        ctx.beginPath(); ctx.moveTo(xx - u * 0.36, yy); ctx.quadraticCurveTo(xx - u * 0.06, yy - u * 0.2, xx + u * 0.3, yy + u * 0.03); ctx.stroke();
        ctx.strokeStyle = play ? "rgba(255,240,205,.5)" : "rgba(200,190,170,.18)";
        ctx.beginPath(); ctx.moveTo(xx - u * 0.36, yy - px * 1.4); ctx.quadraticCurveTo(xx - u * 0.06, yy - u * 0.2 - px * 1.4, xx + u * 0.3, yy + u * 0.03 - px * 1.4); ctx.stroke();
      }
    } else if ((b === 4 || b === 5) && hw >= 38) {  // steppe tufts and shrubs
      ctx.strokeStyle = play ? "rgba(96,104,48,.55)" : "rgba(40,40,34,.4)"; ctx.lineWidth = px * 1.1; ctx.lineCap = "round";
      ctx.beginPath();
      for (let q = 0; q < 4; q++) {
        const tx = x + (rnd(i, 80 + q) - 0.5) * u * 1.1, ty = y + (rnd(i, 90 + q) - 0.5) * u * 0.9, t = u * 0.07;
        ctx.moveTo(tx - t, ty - t); ctx.lineTo(tx, ty); ctx.lineTo(tx + t, ty - t); ctx.moveTo(tx, ty); ctx.lineTo(tx, ty - t * 1.3);
      }
      ctx.stroke();
    }
    if (f & F_MARSH) {
      ctx.strokeStyle = "rgba(60,110,90,.7)"; ctx.lineWidth = px * 1.2;
      ctx.beginPath();
      for (let q = 0; q < 5; q++) { const tx = x + (rnd(i, 100 + q) - 0.5) * u, ty = y + (rnd(i, 110 + q) - 0.5) * u * 0.8; ctx.moveTo(tx, ty); ctx.lineTo(tx, ty - u * 0.16); }
      ctx.stroke();
    }
  }

  trees(ctx, i, n, conifer, tone, fixedY) {
    const g = this.g, x = g.cx(i), y = g.cy(i), u = g.size;
    const pts = [];
    for (let q = 0; q < n; q++) {
      const a = (q / n) * Math.PI * 2 + rnd(i, 120) * 6, rr = q === 0 && n > 3 ? 0 : u * (0.36 + rnd(i, 130 + q) * 0.22);
      pts.push([x + Math.cos(a) * rr * 1.05, fixedY != null ? fixedY - q * u * 0.05 + Math.sin(a) * u * 0.1 : y + Math.sin(a) * rr * 0.8 + u * 0.1]);
    }
    pts.sort((a, b) => a[1] - b[1]);
    for (const [tx, ty] of pts) {
      const t = u * 0.2;
      if (conifer) {
        ctx.fillStyle = tone([40, 84, 54]);
        ctx.beginPath(); ctx.moveTo(tx - t * 0.75, ty); ctx.lineTo(tx, ty - t * 2.1); ctx.lineTo(tx + t * 0.75, ty); ctx.fill();
        ctx.fillStyle = tone([66, 116, 70]);
        ctx.beginPath(); ctx.moveTo(tx - t * 0.75, ty); ctx.lineTo(tx, ty - t * 2.1); ctx.lineTo(tx - t * 0.05, ty); ctx.fill();
      } else {
        ctx.fillStyle = tone([52, 92, 48]);
        ctx.beginPath(); ctx.arc(tx, ty - t * 0.9, t * 0.95, 0, 7); ctx.fill();
        ctx.fillStyle = tone([92, 136, 70]);
        ctx.beginPath(); ctx.arc(tx - t * 0.25, ty - t * 1.15, t * 0.55, 0, 7); ctx.fill();
      }
    }
  }

  oasis(ctx, i, tier, px, tone) {
    const g = this.g, x = g.cx(i), y = g.cy(i), u = g.size;
    if (tier === 1) {
      ctx.fillStyle = tone([74, 132, 72]);
      ctx.beginPath(); ctx.arc(x, y, u * 0.26, 0, 7); ctx.fill();
      return;
    }
    ctx.fillStyle = tone([86, 150, 178]);
    ctx.beginPath(); ctx.ellipse(x + u * 0.12, y + u * 0.3, u * 0.3, u * 0.12, 0, 0, 7); ctx.fill();
    for (let q = 0; q < 3; q++) {
      const tx = x + (q - 1) * u * 0.34 + (rnd(i, 140 + q) - 0.5) * u * 0.12, ty = y + u * 0.2 - (q === 1 ? u * 0.12 : 0), h = u * (0.5 + rnd(i, 150 + q) * 0.2);
      ctx.strokeStyle = tone([112, 84, 52]); ctx.lineWidth = px * 1.6; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.quadraticCurveTo(tx + u * 0.05, ty - h * 0.5, tx + u * 0.02, ty - h); ctx.stroke();
      ctx.strokeStyle = tone([58, 124, 62]); ctx.lineWidth = px * 1.6;
      ctx.beginPath();
      const fx = tx + u * 0.02, fy = ty - h, len = u * 0.26;
      for (const deg of [195, 232, 270, 308, 345]) {      // fronds arch up and droop at the tips
        const a = (deg * Math.PI) / 180, cx2 = Math.cos(a), sy2 = Math.sin(a);
        ctx.moveTo(fx, fy);
        ctx.quadraticCurveTo(fx + cx2 * len * 0.55, fy + sy2 * len * 0.95, fx + cx2 * len, fy + sy2 * len * 0.45 + Math.abs(cx2) * u * 0.1);
      }
      ctx.stroke();
    }
  }

  town(ctx, i, tier, tone) {
    const g = this.g, x = g.cx(i), y = g.cy(i), u = g.size, n = tier === 1 ? 4 : 7;
    const walls = [[232, 214, 186], [214, 168, 132], [240, 232, 216], [200, 140, 110]];
    const bs = [];
    for (let q = 0; q < n; q++) bs.push([x + (rnd(i, 160 + q) - 0.5) * u * 1.0, y + (rnd(i, 170 + q) - 0.5) * u * 0.8, u * (0.16 + rnd(i, 180 + q) * 0.1), q]);
    bs.sort((a, b) => a[1] - b[1]);
    for (const [bx, by, sz, q] of bs) {
      const h = sz * (0.7 + rnd(i, 190 + q) * 0.5);
      ctx.fillStyle = "rgba(30,20,10,.3)"; ctx.fillRect(bx - sz / 2 + sz * 0.18, by - h * 0.6, sz, h);
      ctx.fillStyle = tone(walls[q % 4]); ctx.fillRect(bx - sz / 2, by - h, sz, h);
      ctx.fillStyle = tone(mul(walls[q % 4], 0.78)); ctx.fillRect(bx - sz / 2, by - h * 0.28, sz, h * 0.28);
    }
  }
}

function rgbAt(rgb, i, f) { return [Math.min(255, rgb[i * 3] * f), Math.min(255, rgb[i * 3 + 1] * f), Math.min(255, rgb[i * 3 + 2] * f)]; }
