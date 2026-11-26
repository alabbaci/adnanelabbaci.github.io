// Morocco 4X: boot, camera, input, frame loop, shareable state.
import { World } from "./world.js";
import { MapRenderer } from "./render.js";
import { Overlay, Minimap } from "./overlay.js";
import { clamp } from "./geo.js";
import { hydrateIcons } from "./icons.js";
import { initUI } from "./ui.js";

const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d", { alpha: false });
const loading = document.getElementById("loading");

const app = {
  world: null, renderer: null, overlay: null, ui: null,
  cam: { x: 0, y: 0, k: 1, minK: 0.3, maxK: 14 },
  vw: 0, vh: 0, dpr: 1,
  state: {
    lens: null,                 // lens id or null (terrain)
    showResources: true,
    hiddenCats: new Set(),
    layers: { borders: true, provinces: true, rivers: true, roads: true, rail: true, grid: false },
    sel: null,                  // {kind: city|region|province|resource, id, cell?}
    hoverCell: -1, hoverCity: null, hoverResource: null,
  },
  listeners: {},
  on(evt, fn) { (this.listeners[evt] ||= []).push(fn); },
  emit(evt, arg) { for (const fn of this.listeners[evt] || []) fn(arg); },
};
window.morocco4x = app;

let dirty = false, raf = 0, anim = null;
const keys = new Set();

app.requestDraw = () => { dirty = true; if (!raf) raf = requestAnimationFrame(frame); };

function resize() {
  const r = canvas.getBoundingClientRect();
  app.vw = Math.max(1, Math.round(r.width)); app.vh = Math.max(1, Math.round(r.height));
  app.dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(app.vw * app.dpr); canvas.height = Math.round(app.vh * app.dpr);
  if (app.world) {
    const g = app.world.grid;
    app.cam.minK = Math.min(app.vw / g.width, app.vh / g.height) * 0.98;
    clampCam();
  }
  app.requestDraw();
}

function clampCam() {
  const c = app.cam, g = app.world.grid;
  c.k = clamp(c.k, c.minK, c.maxK);
  const hw = app.vw / 2 / c.k, hh = app.vh / 2 / c.k;
  // keep the frame on screen: centre it when it is smaller than the view, else stop at its edges
  c.x = g.width <= 2 * hw ? g.width / 2 : clamp(c.x, hw, g.width - hw);
  c.y = g.height <= 2 * hh ? g.height / 2 : clamp(c.y, hh, g.height - hh);
}

const toWorld = (px, py) => [app.cam.x + (px - app.vw / 2) / app.cam.k, app.cam.y + (py - app.vh / 2) / app.cam.k];

function zoomAt(px, py, factor) {
  const c = app.cam, [wx, wy] = toWorld(px, py);
  const k = clamp(c.k * factor, c.minK, c.maxK);
  c.x = wx - (px - app.vw / 2) / k; c.y = wy - (py - app.vh / 2) / k; c.k = k;
  clampCam(); changed();
}

app.flyTo = (x, y, k, ms = 650) => {
  const c = app.cam, from = { x: c.x, y: c.y, k: c.k };
  k = clamp(k ?? c.k, c.minK, c.maxK);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) ms = 0;
  anim = { from, to: { x, y, k }, t0: performance.now(), ms };
  app.requestDraw();
};
// Fit a box (km) in the part of the view not covered by the side panel.
app.fitBox = (x0, y0, x1, y1, maxK = 6, ms) => {
  const panelW = app.vw > 760 && document.getElementById("panel").classList.contains("open") ? 370 : 0;
  const panelH = app.vw <= 760 && document.getElementById("panel").classList.contains("open") ? app.vh * 0.5 : 0;
  const w = Math.max(120, app.vw - panelW - 60), h = Math.max(120, app.vh - panelH - 90);
  const k = clamp(Math.min(w / Math.max(1, x1 - x0), h / Math.max(1, y1 - y0)), app.cam.minK, maxK);
  app.flyTo((x0 + x1) / 2 + panelW / 2 / k, (y0 + y1) / 2 + panelH / 2 / k, k, ms);
};
app.home = (ms) => {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const r of app.world.regions) if (r.geo) { x0 = Math.min(x0, r.geo.x0); y0 = Math.min(y0, r.geo.y0); x1 = Math.max(x1, r.geo.x1); y1 = Math.max(y1, r.geo.y1); }
  app.fitBox(x0 - 20, y0 - 20, x1 + 20, y1 + 20, 6, ms);
};
app.focus = (sel, ms) => {
  const w = app.world;
  if (sel.kind === "city") { const c = w.cityById.get(sel.id); app.fitBox(c.x - 70, c.y - 55, c.x + 70, c.y + 55, 5, ms); }
  else if (sel.kind === "resource") { const r = w.resourceById.get(sel.id); app.fitBox(r.x - 60, r.y - 45, r.x + 60, r.y + 45, 5, ms); }
  else { const u = (sel.kind === "region" ? w.regionById : w.provinceById).get(sel.id); if (u && u.geo) app.fitBox(u.geo.x0 - 12, u.geo.y0 - 12, u.geo.x1 + 12, u.geo.y1 + 12, 6, ms); }
};

app.select = (sel, opts = {}) => {
  app.state.sel = sel;
  app.emit("select", sel);
  if (sel && opts.fly) app.focus(sel);
  changed();
};
app.setLens = (id) => {
  const w = app.world, lens = id ? w.lensById.get(id) : null;
  app.state.lens = lens ? lens.id : null;
  app.renderer.setLens(lens || null);
  canvas.setAttribute("aria-label", "Hex map of Morocco, showing " + (lens ? lens.label.toLowerCase() : "terrain"));
  app.emit("lens", lens || null);
  changed();
};
app.cycleLens = (dir) => {
  const ids = [null, ...app.world.lenses.map((l) => l.id)];
  const i = ids.indexOf(app.state.lens);
  app.setLens(ids[(i + dir + ids.length) % ids.length]);
};
app.refilter = () => { app.renderer.recolor(); app.requestDraw(); };
app.setLayer = (name, on) => { app.state.layers[name] = on; app.renderer.setLayers(app.state.layers); app.emit("layers"); changed(); };
app.setResources = (on) => { app.state.showResources = on; app.emit("layers"); changed(); };
app.setCat = (cat, on) => { on ? app.state.hiddenCats.delete(cat) : app.state.hiddenCats.add(cat); app.emit("layers"); changed(); };

// ---- shareable state in the URL hash
let hashTimer = 0;
function changed() {
  app.requestDraw();
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => history.replaceState(null, "", app.link()), 250);
}
app.link = () => {
  const c = app.cam, s = app.state, p = [`v=${c.x.toFixed(0)},${c.y.toFixed(0)},${c.k.toFixed(3)}`];
  if (s.lens) p.push("lens=" + s.lens);
  if (s.sel) p.push(`sel=${s.sel.kind}:${s.sel.id}`);
  if (!s.showResources) p.push("res=0");
  const off = Object.keys(s.layers).filter((k) => s.layers[k] !== (k !== "grid"));
  if (off.length) p.push("ly=" + off.join(","));
  if (s.hiddenCats.size) p.push("hide=" + [...s.hiddenCats].join(","));
  return location.pathname + location.search + "#" + p.join("&");
};
function readHash() {
  const q = new URLSearchParams(location.hash.slice(1)), s = app.state, w = app.world;
  let hadView = false;
  const v = (q.get("v") || "").split(",").map(Number);
  if (v.length === 3 && v.every(Number.isFinite)) { app.cam.x = v[0]; app.cam.y = v[1]; app.cam.k = v[2]; hadView = true; }
  for (const k of (q.get("ly") || "").split(",")) if (k in s.layers) s.layers[k] = !(k !== "grid");
  for (const k of (q.get("hide") || "").split(",")) if (k) s.hiddenCats.add(k);
  if (q.get("res") === "0") s.showResources = false;
  const lens = q.get("lens");
  const sel = (q.get("sel") || "").split(":");
  const maps = { city: w.cityById, region: w.regionById, province: w.provinceById, resource: w.resourceById };
  return { hadView, lens: lens && w.lensById.has(lens) ? lens : null, sel: maps[sel[0]] && maps[sel[0]].has(sel[1]) ? { kind: sel[0], id: sel[1] } : null };
}

// ---- frame
function drawState() {
  const s = app.state, w = app.world, sel = s.sel, d = {
    showResources: s.showResources, hiddenCats: s.hiddenCats, catColor: app.catColor, showRegionNames: s.layers.borders,
    hoverCell: s.hoverCity || s.hoverResource ? -1 : s.hoverCell, hoverCity: s.hoverCity, selCell: -1,
    selCity: null, selRegion: null, selProvince: null, selResource: null, hoverUnit: null,
  };
  if (sel) {
    if (sel.kind === "city") { d.selCity = w.cityById.get(sel.id); d.selCell = d.selCity.cell; }
    else if (sel.kind === "region") { d.selRegion = w.regionById.get(sel.id); if (sel.cell != null) d.selCell = sel.cell; }
    else if (sel.kind === "province") { d.selProvince = w.provinceById.get(sel.id); d.selRegion = w.regionById.get(d.selProvince.region); }
    else if (sel.kind === "resource") { d.selResource = w.resourceById.get(sel.id); d.selCell = d.selResource.cell; }
  }
  if (s.hoverUnit) d.hoverUnit = s.hoverUnit;
  return d;
}

function paint(c2, cam, vw, vh, dpr) {
  const g = app.world.grid;
  c2.setTransform(1, 0, 0, 1, 0, 0);
  c2.fillStyle = "#0a101b";
  c2.fillRect(0, 0, vw * dpr, vh * dpr);
  // the board, clipped to its own frame (tiles run past the edge)
  const x0 = (0 - cam.x) * cam.k + vw / 2, y0 = (0 - cam.y) * cam.k + vh / 2;
  c2.save();
  c2.beginPath(); c2.rect(x0 * dpr, y0 * dpr, g.width * cam.k * dpr, g.height * cam.k * dpr); c2.clip();
  const pending = app.renderer.draw(c2, cam, vw, vh, dpr);
  c2.restore();
  c2.setTransform(dpr, 0, 0, dpr, 0, 0);
  c2.strokeStyle = "rgba(197,155,91,.55)"; c2.lineWidth = 1.5;
  c2.strokeRect(x0, y0, g.width * cam.k, g.height * cam.k);
  app.overlay.draw(c2, cam, vw, vh, dpr, drawState());
  return pending;
}

function frame(now) {
  raf = 0; dirty = false;
  const c = app.cam;
  if (anim) {
    const t = anim.ms ? clamp((now - anim.t0) / anim.ms, 0, 1) : 1, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    c.x = anim.from.x + (anim.to.x - anim.from.x) * e; c.y = anim.from.y + (anim.to.y - anim.from.y) * e;
    c.k = anim.from.k * Math.pow(anim.to.k / anim.from.k, e);
    clampCam();
    if (t >= 1) { anim = null; changed(); } else dirty = true;
  }
  if (keys.size) {
    const step = 14 / c.k;
    if (keys.has("left")) c.x -= step; if (keys.has("right")) c.x += step;
    if (keys.has("up")) c.y -= step; if (keys.has("down")) c.y += step;
    clampCam(); dirty = true;
  }
  const pending = paint(ctx, c, app.vw, app.vh, app.dpr);
  app.minimap.draw(app.renderer.base, c, app.vw, app.vh);
  if (pending || dirty) app.requestDraw();
}

// Render the current view into a new canvas (used by Share > Download image).
app.snapshot = (W, H) => {
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const c2 = cv.getContext("2d"), f = Math.max(W / app.vw, H / app.vh);
  const cam = { x: app.cam.x, y: app.cam.y, k: app.cam.k * f };
  for (let i = 0; i < 400 && paint(c2, cam, W, H, 1); i++);
  app.requestDraw();
  return cv;
};

// ---- input
function initInput() {
  const pts = new Map();
  let drag = null, pinch = null, moved = false;
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, pos(e));
    anim = null;
    if (pts.size === 1) { drag = { p: pos(e), cx: app.cam.x, cy: app.cam.y }; moved = false; }
    else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), k: app.cam.k }; drag = null; moved = true;
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = pos(e);
    if (pts.has(e.pointerId)) pts.set(e.pointerId, p);
    if (pinch && pts.size === 2) {
      const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (pinch.k * d) / pinch.d / app.cam.k);
      return;
    }
    if (drag) {
      const dx = p[0] - drag.p[0], dy = p[1] - drag.p[1];
      if (!moved && Math.hypot(dx, dy) > 4) { moved = true; canvas.classList.add("dragging"); app.ui.hideTooltip(); }
      if (moved) { app.cam.x = drag.cx - dx / app.cam.k; app.cam.y = drag.cy - dy / app.cam.k; clampCam(); changed(); }
      return;
    }
    if (e.pointerType !== "touch") hover(p, e);
  });
  const up = (e) => {
    const p = pts.get(e.pointerId);
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    canvas.classList.remove("dragging");
    if (drag && !moved && p) click(p);
    if (pts.size === 0) drag = null;
    else if (pts.size === 1) { const q = [...pts.values()][0]; drag = { p: q, cx: app.cam.x, cy: app.cam.y }; moved = true; }
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("pointerleave", () => { const s = app.state; s.hoverCell = -1; s.hoverCity = s.hoverResource = s.hoverUnit = null; app.ui.hideTooltip(); app.requestDraw(); });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const p = pos(e), dy = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
    anim = null;
    zoomAt(p[0], p[1], Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0016)));
  }, { passive: false });
  canvas.addEventListener("dblclick", (e) => { const p = pos(e), [wx, wy] = toWorld(p[0], p[1]); app.flyTo(wx, wy, app.cam.k * 2, 350); });

  function hover(p, e) {
    const s = app.state, w = app.world, h = app.overlay.pick(p[0], p[1]);
    const [wx, wy] = toWorld(p[0], p[1]);
    const cell = w.grid.cellAt(wx, wy);
    const city = h && h.kind === "city" ? h.o : null, res = h && h.kind === "resource" ? h.o : null;
    if (cell !== s.hoverCell || city !== s.hoverCity || res !== s.hoverResource) {
      s.hoverCell = cell; s.hoverCity = city; s.hoverResource = res;
      s.hoverUnit = !city && !res && cell >= 0 && w.province[cell] ? { kind: "region", u: w.regionAt(cell) } : null;
      canvas.classList.toggle("pointing", !!(city || res || (cell >= 0 && w.province[cell])));
      app.requestDraw();
    }
    app.ui.showTooltip(e.clientX, e.clientY, { cell, city, res });
  }
  function click(p) {
    const w = app.world, h = app.overlay.pick(p[0], p[1]);
    if (h) return app.select({ kind: h.kind, id: h.o.id });
    const [wx, wy] = toWorld(p[0], p[1]);
    const cell = w.grid.cellAt(wx, wy);
    const city = cell >= 0 ? w.cityAt.get(cell) : null;
    if (city) return app.select({ kind: "city", id: city.id });
    if (cell >= 0 && w.province[cell]) return app.select({ kind: "region", id: w.regionAt(cell).id, cell });
    app.select(null);
  }

  const KEYMAP = { ArrowLeft: "left", a: "left", ArrowRight: "right", d: "right", ArrowUp: "up", w: "up", ArrowDown: "down", s: "down" };
  window.addEventListener("keydown", (e) => {
    const t = e.target, typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
    if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !typing)) { e.preventDefault(); document.getElementById("search-input").focus(); return; }
    if (e.key === "Escape") { app.ui.escape(); return; }
    if (typing || e.ctrlKey || e.metaKey || e.altKey || app.ui.modalOpen()) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (KEYMAP[k]) { keys.add(KEYMAP[k]); anim = null; app.requestDraw(); e.preventDefault(); }
    else if (k === "+" || k === "=") zoomAt(app.vw / 2, app.vh / 2, 1.35);
    else if (k === "-" || k === "_") zoomAt(app.vw / 2, app.vh / 2, 1 / 1.35);
    else if (k === "0") app.home();
    else if (k === "l") app.cycleLens(e.shiftKey ? -1 : 1);
    else if (k === "r") app.setResources(!app.state.showResources);
    else if (k === "?") app.ui.openHelp();
  });
  window.addEventListener("keyup", (e) => { const k = e.key.length === 1 ? e.key.toLowerCase() : e.key; if (KEYMAP[k]) { keys.delete(KEYMAP[k]); changed(); } });
  window.addEventListener("blur", () => keys.clear());
}

async function boot() {
  hydrateIcons();
  try {
    const w = (app.world = await World.load());
    app.catColor = Object.fromEntries(w.resourceCats.map((c) => [c.id, c.color]));
    app.renderer = new MapRenderer(w);
    const P = w.grid.proj, R = P.R, phi0 = (P.lat0 * Math.PI) / 180;
    const project = (lon, lat) => {       // forward Lambert azimuthal equal-area, as in pipeline/common.py
      const lam = ((lon - P.lon0) * Math.PI) / 180, phi = (lat * Math.PI) / 180;
      const kk = Math.sqrt(2 / (1 + Math.sin(phi0) * Math.sin(phi) + Math.cos(phi0) * Math.cos(phi) * Math.cos(lam)));
      return [R * kk * Math.cos(phi) * Math.sin(lam) - P.xmin, P.ymax - R * kk * (Math.cos(phi0) * Math.sin(phi) - Math.sin(phi0) * Math.cos(phi) * Math.cos(lam))];
    };
    app.overlay = new Overlay(w, project);
    app.minimap = new Minimap(document.getElementById("minimap"), w, (x, y) => { anim = null; app.cam.x = x; app.cam.y = y; clampCam(); changed(); });
    app.ui = initUI(app);
    resize();
    const h = readHash();
    app.renderer.setLayers(app.state.layers);
    if (!h.hadView) app.home(0); else clampCam();
    app.setLens(h.lens);
    if (h.sel) app.select(h.sel);
    app.emit("layers");
    initInput();
    window.addEventListener("resize", resize);
    new ResizeObserver(resize).observe(canvas);
    loading.classList.add("done");
    app.requestDraw();
  } catch (err) {
    console.error(err);
    loading.classList.add("error");
    document.getElementById("loading-text").textContent = "The map data could not be loaded (" + err.message + "). Serve this folder over HTTP, e.g. python -m http.server.";
  }
}
boot();
