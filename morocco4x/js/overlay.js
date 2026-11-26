// Things drawn every frame on top of the cached terrain: place names, city banners,
// resource badges, selection outlines, and the minimap.
import { compact } from "./format.js";
import { glyph } from "./icons.js";

const SERIF = '"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif';
const SANS = 'system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif';

// Fixed map lettering for seas and neighbours (positions in lon/lat, projected once).
const LETTERING = [
  { t: "ATLANTIC OCEAN", lon: -14.6, lat: 32.2, size: 17, sea: true, spacing: 6 },
  { t: "MEDITERRANEAN SEA", lon: -3.2, lat: 36.0, size: 12, sea: true, spacing: 4 },
  { t: "ALGERIA", lon: -2.6, lat: 29.6, size: 15, spacing: 6 },
  { t: "MAURITANIA", lon: -10.2, lat: 23.6, size: 15, spacing: 6 },
  { t: "SPAIN", lon: -4.6, lat: 36.75, size: 12, spacing: 5 },
  { t: "Canary Islands", lon: -15.6, lat: 29.35, size: 11, spacing: 1, italic: true },
];

export class Overlay {
  constructor(world, project) {
    this.w = world;
    this.g = world.grid;
    this.hit = [];                 // screen rectangles of clickable things, rebuilt every frame
    this.regionPaths = new Map();  // id -> Path2D outline in km
    this.lettering = LETTERING.map((l) => { const [x, y] = project(l.lon, l.lat); return { ...l, x, y }; });
    this.textW = new Map();
  }

  measure(ctx, font, text) {
    const key = font + "|" + text;
    let v = this.textW.get(key);
    if (v == null) { ctx.font = font; v = ctx.measureText(text).width; this.textW.set(key, v); }
    return v;
  }

  // Outline of a region or province as a Path2D in world km (edges facing a different unit).
  outline(kind, unit) {
    const key = kind + ":" + unit.id;
    let p = this.regionPaths.get(key);
    if (p) return p;
    p = new Path2D();
    const g = this.g, arr = kind === "region" ? this.w.region : this.w.province, idx = unit.idx, cr = g.corners, geo = unit.geo;
    if (geo) {
      const c0 = Math.max(0, Math.floor(geo.x0 / g.hexKm) - 1), c1 = Math.min(g.cols - 1, Math.ceil(geo.x1 / g.hexKm) + 1);
      const r0 = Math.max(0, Math.floor(geo.y0 / g.rowKm) - 1), r1 = Math.min(g.rows - 1, Math.ceil(geo.y1 / g.rowKm) + 1);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const i = r * g.cols + c;
        if (arr[i] !== idx) continue;
        const x = g.cx(i), y = g.cy(i);
        for (let d = 0; d < 6; d++) {
          const j = g.neighbor(i, d);
          if (j >= 0 && arr[j] === idx) continue;
          const a = cr[d], b = cr[(d + 1) % 6];
          p.moveTo(x + a[0], y + a[1]); p.lineTo(x + b[0], y + b[1]);
        }
      }
    }
    this.regionPaths.set(key, p);
    return p;
  }

  draw(ctx, cam, vw, vh, dpr, st) {
    const w = this.w, g = this.g, k = cam.k;
    const sx = (x) => (x - cam.x) * k + vw / 2, sy = (y) => (y - cam.y) * k + vh / 2;
    this.hit.length = 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // ---- selection and hover outlines (in world space)
    ctx.save();
    ctx.translate(vw / 2 - cam.x * k, vh / 2 - cam.y * k); ctx.scale(k, k);
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    const stroke = (path, color, wpx, glow) => {
      if (glow) { ctx.strokeStyle = glow; ctx.lineWidth = (wpx + 5) / k; ctx.stroke(path); }
      ctx.strokeStyle = color; ctx.lineWidth = wpx / k; ctx.stroke(path);
    };
    if (st.selRegion) stroke(this.outline("region", st.selRegion), "#ffe08a", 2.6, "rgba(255,200,80,.28)");
    if (st.selProvince) stroke(this.outline("province", st.selProvince), "#ffffff", 1.8, "rgba(255,255,255,.2)");
    if (st.hoverUnit && st.hoverUnit.u !== st.selRegion && st.hoverUnit.u !== st.selProvince) stroke(this.outline(st.hoverUnit.kind, st.hoverUnit.u), "rgba(255,255,255,.75)", 1.4);
    for (const [cell, color, wpx] of [[st.hoverCell, "rgba(255,255,255,.9)", 1.6], [st.selCell, "#ffe08a", 2.6]]) {
      if (cell == null || cell < 0) continue;
      const path = new Path2D(); g.hexPath(path, cell);
      stroke(path, color, wpx, "rgba(0,0,0,.45)");
    }
    ctx.restore();

    // ---- map lettering: seas, neighbours, region names
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    if (k < 2.2) {
      for (const l of this.lettering) {
        const f = Math.min(1.5, Math.max(0.5, k / 0.55));
        ctx.font = `${l.italic ? "italic " : ""}${Math.round(l.size * f)}px ${SERIF}`;
        ctx.fillStyle = l.sea ? "rgba(170,205,230,.5)" : "rgba(235,225,205,.42)";
        spaced(ctx, l.t, sx(l.x), sy(l.y), l.spacing * f);
      }
    }
    if (k < 1.3 && k >= 0.42 && st.showRegionNames) {
      const f = Math.min(1.35, Math.max(0.7, k / 0.6));
      for (const r of w.regions) {
        if (!r.geo) continue;
        const X = sx(r.label ? r.label[0] : r.geo.cx), Y = sy(r.label ? r.label[1] : r.geo.cy);
        if (X < -100 || Y < -40 || X > vw + 100 || Y > vh + 40) continue;
        ctx.font = `600 ${Math.round(12.5 * f)}px ${SERIF}`;
        const lines = wrapName(r.name.toUpperCase());
        lines.forEach((t, n) => {
          const yy = Y + (n - (lines.length - 1) / 2) * 15 * f;
          ctx.lineWidth = 2.5; ctx.strokeStyle = "rgba(20,14,6,.4)"; ctx.fillStyle = "rgba(255,246,222,.78)";
          spaced(ctx, t, X, yy, 2.2 * f, true);
        });
      }
    }

    // ---- resources
    if (st.showResources) {
      const big = k >= 2.6, mid = k >= 1.15;
      const rad = big ? Math.min(13, 8 + k * 0.9) : mid ? 5 : 2.6;
      for (const r of w.resources) {
        if (st.hiddenCats.has(r.cat)) continue;
        let X = sx(r.x), Y = sy(r.y);
        if (X < -20 || Y < -20 || X > vw + 20 || Y > vh + 20) continue;
        // several resources on one hex fan out sideways; a city on the hex pushes them below its banner
        const mates = w.resAt.get(r.cell), n = mates.indexOf(r), m = mates.length;
        if (big) { X += (n - (m - 1) / 2) * rad * 2.15; if (w.cityAt.has(r.cell)) Y += g.size * k * 0.55; }
        else if (mid) X += (n - (m - 1) / 2) * rad * 1.6;
        const cat = st.catColor[r.cat] || "#888";
        const sel = st.selResource === r;
        ctx.beginPath(); ctx.arc(X, Y, rad + (sel ? 2.5 : 0), 0, 7);
        ctx.fillStyle = cat; ctx.fill();
        ctx.lineWidth = sel ? 2.5 : big ? 1.6 : 1; ctx.strokeStyle = sel ? "#ffe08a" : big ? "rgba(255,246,220,.95)" : "rgba(15,10,5,.8)"; ctx.stroke();
        if (big) { ctx.lineWidth = 1; ctx.strokeStyle = "rgba(0,0,0,.55)"; ctx.beginPath(); ctx.arc(X, Y, rad + 1.3, 0, 7); ctx.stroke(); glyph(ctx, r.kind, r.cat, X, Y, rad * 1.25); }
        if (mid) this.hit.push({ x0: X - rad - 3, y0: Y - rad - 3, x1: X + rad + 3, y1: Y + rad + 3, kind: "resource", o: r });
      }
    }

    // ---- city banners (largest first; a banner is dropped when it would overlap a bigger one)
    const minPop = k < 0.42 ? 900000 : k < 0.55 ? 250000 : k < 0.8 ? 120000 : k < 1.2 ? 60000 : k < 1.9 ? 30000 : 0;
    const placed = [];
    const fs = k < 0.8 ? 11 : k < 2 ? 12 : 13;
    const font = `600 ${fs}px ${SERIF}`, fontPop = `700 ${fs - 1.5}px ${SANS}`;
    for (const c of w.cities) {
      const X = sx(c.x), Y = sy(c.y);
      if (X < -120 || Y < -40 || X > vw + 120 || Y > vh + 60) continue;
      const sel = st.selCity === c, hov = st.hoverCity === c;
      const dotR = Math.max(k < 0.9 ? 1.7 : 2.2, Math.min(7, 1.4 + Math.sqrt(c.pop2024 / 1e6) * 4.2 * Math.min(1.4, 0.6 + k * 0.3)));
      let show = sel || hov || c.pop2024 >= minPop || c.capital === 3 || (c.capital === 2 && k >= 0.42);
      const pop = compact(c.pop2024);
      const tw = this.measure(ctx, font, c.name), pw = this.measure(ctx, fontPop, pop);
      const star = c.capital >= 2 ? fs * 0.95 : 0;
      const bw = tw + pw + star + 26, bh = fs + 9;
      const bx = X - bw / 2, by = Y - dotR - bh - 5;
      if (show && !sel && !hov) {
        for (const p of placed) if (bx < p[2] + 3 && bx + bw > p[0] - 3 && by < p[3] + 2 && by + bh > p[1] - 2) { show = false; break; }
      }
      // city marker (at country-wide zoom, unlabelled small towns are left out)
      if (!show && k < 0.9 && c.pop2024 < (k < 0.42 ? 250000 : 60000)) continue;
      ctx.beginPath(); ctx.arc(X, Y, dotR + 1.6, 0, 7); ctx.fillStyle = "rgba(20,12,6,.85)"; ctx.fill();
      ctx.beginPath(); ctx.arc(X, Y, dotR, 0, 7); ctx.fillStyle = c.capital === 3 ? "#e9c15d" : c.capital === 2 ? "#f1e6c8" : "#e6dccb"; ctx.fill();
      if (c.capital >= 2) { ctx.beginPath(); ctx.arc(X, Y, Math.max(1, dotR * 0.42), 0, 7); ctx.fillStyle = c.capital === 3 ? "#b3262c" : "#7a5a2a"; ctx.fill(); }
      if (!show) { this.hit.push({ x0: X - 7, y0: Y - 7, x1: X + 7, y1: Y + 7, kind: "city", o: c }); continue; }
      placed.push([bx, by, bx + bw, by + bh]);
      // banner plate
      ctx.beginPath(); roundRect(ctx, bx, by, bw, bh, bh / 2);
      ctx.fillStyle = sel ? "rgba(74,52,16,.96)" : "rgba(17,23,36,.9)"; ctx.fill();
      ctx.lineWidth = sel || hov ? 1.8 : 1.1; ctx.strokeStyle = sel ? "#ffe08a" : hov ? "#f1d59f" : c.capital >= 2 ? "#c9a25e" : "rgba(197,155,91,.6)"; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(X - 4, by + bh); ctx.lineTo(X, by + bh + 4); ctx.lineTo(X + 4, by + bh); ctx.fillStyle = "rgba(17,23,36,.9)"; ctx.fill();
      let tx = bx + 10;
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      if (star) { drawStar(ctx, tx + star * 0.42, by + bh / 2, star * 0.48, c.capital === 3 ? "#e9c15d" : "#bfb49a"); tx += star + 1; }
      ctx.font = font; ctx.fillStyle = "#f3ead3"; ctx.fillText(c.name, tx, by + bh / 2 + 0.5);
      ctx.font = fontPop; ctx.fillStyle = "#d7b377"; ctx.fillText(pop, tx + tw + 7, by + bh / 2 + 0.5);
      this.hit.push({ x0: bx, y0: by, x1: bx + bw, y1: Y + dotR + 2, kind: "city", o: c });
    }
  }

  pick(x, y) {
    for (let i = this.hit.length - 1; i >= 0; i--) {
      const h = this.hit[i];
      if (h.kind === "city" && x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1) return h;
    }
    for (let i = this.hit.length - 1; i >= 0; i--) {
      const h = this.hit[i];
      if (x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1) return h;
    }
    return null;
  }
}

function spaced(ctx, text, x, y, spacing, outline) {
  // letter-spaced centred text (canvas letterSpacing is not available everywhere)
  let total = 0;
  const ws = [];
  for (const ch of text) { const w = ctx.measureText(ch).width; ws.push(w); total += w + spacing; }
  total -= spacing;
  let cx = x - total / 2;
  ctx.textAlign = "left";
  let n = 0;
  for (const ch of text) {
    if (outline) ctx.strokeText(ch, cx, y);
    ctx.fillText(ch, cx, y);
    cx += ws[n++] + spacing;
  }
  ctx.textAlign = "center";
}
function wrapName(name) {
  if (name.length <= 16) return [name];
  const parts = name.split("-");
  if (parts.length < 2) return [name];
  const mid = Math.ceil(parts.length / 2);
  return [parts.slice(0, mid).join("-") + "-", parts.slice(mid).join("-")];
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function drawStar(ctx, x, y, r, color) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.42 : r;
    ctx[i ? "lineTo" : "moveTo"](x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath(); ctx.fillStyle = color; ctx.fill();
}

export class Minimap {
  constructor(canvas, world, onJump) {
    this.cv = canvas; this.w = world; this.onJump = onJump;
    const g = world.grid, W = 150;
    this.cssW = W; this.cssH = Math.round((W * g.height) / g.width);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = W * dpr; canvas.height = this.cssH * dpr;
    canvas.style.width = W + "px"; canvas.style.height = this.cssH + "px";
    this.dpr = dpr;
    let down = false;
    const jump = (e) => {
      const r = canvas.getBoundingClientRect();
      onJump(((e.clientX - r.left) / r.width) * g.width, ((e.clientY - r.top) / r.height) * g.height);
    };
    canvas.addEventListener("pointerdown", (e) => { down = true; canvas.setPointerCapture(e.pointerId); jump(e); });
    canvas.addEventListener("pointermove", (e) => { if (down) jump(e); });
    canvas.addEventListener("pointerup", () => (down = false));
    canvas.addEventListener("pointercancel", () => (down = false));
  }
  draw(base, cam, vw, vh) {
    const ctx = this.cv.getContext("2d"), g = this.w.grid, W = this.cv.width, H = this.cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(base, 0, 0, W, H);
    const f = W / g.width;
    const x = (cam.x - vw / 2 / cam.k) * f, y = (cam.y - vh / 2 / cam.k) * f, w = (vw / cam.k) * f, h = (vh / cam.k) * f;
    ctx.fillStyle = "rgba(0,0,0,.28)";
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.rect(x, y, w, h); ctx.fill("evenodd");
    ctx.strokeStyle = "#ffe9b0"; ctx.lineWidth = 1.5 * this.dpr; ctx.strokeRect(x, y, w, h);
  }
}
