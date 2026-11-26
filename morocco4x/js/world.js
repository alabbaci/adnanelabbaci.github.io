// Loads the data files and answers questions about them: what is at a hex, lens values, terrain names.
import { Grid, decode, clamp } from "./geo.js";
import { fmt } from "./format.js";

const RAMPS = {
  magma: ["#241a4a", "#6d2a7c", "#c2416f", "#f38f5c", "#fde9a8"],
  gold: ["#2a281f", "#66562a", "#b08a2e", "#efc64b", "#fff2bd"],
  violet: ["#1e2440", "#473d8c", "#8a5ccc", "#cc8ce4", "#f6daf6"],
  teal: ["#12303a", "#1f6c76", "#3eab9c", "#98dcb2", "#f0f8d0"],
  green: ["#1c2a1a", "#3d682c", "#7cac40", "#c4d86e", "#f6f4c0"],
  red: ["#2a1a1c", "#782a2c", "#c5463a", "#ee8d5a", "#fde0b0"],
  blue: ["#141f3a", "#234f8f", "#3f86cf", "#8cc2ea", "#e2f3fb"],
  diverge: ["#3a6cd2", "#9bb8e6", "#e8e2d6", "#e89c7c", "#c7362e"],
  hypso: ["#567f52", "#b9b673", "#b88a57", "#8a634a", "#f3efe9"],
};
const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
for (const k in RAMPS) RAMPS[k] = RAMPS[k].map(hex2rgb);

export function rampColor(name, t) {
  const st = RAMPS[name] || RAMPS.magma;
  const p = clamp(t, 0, 1) * (st.length - 1), i = Math.min(st.length - 2, Math.floor(p)), f = p - i;
  return [st[i][0] + (st[i + 1][0] - st[i][0]) * f, st[i][1] + (st[i + 1][1] - st[i][1]) * f, st[i][2] + (st[i + 1][2] - st[i][2]) * f];
}

const BIOME_NAME = ["Ocean", "Coast", "Lake", "Farmland", "Steppe grassland", "Scrubland", "Desert"];
const RELIEF_NAME = ["", "hills", "mountains"];

export class World {
  static async load(onStep) {
    const get = async (name) => {
      const r = await fetch(`data/${name}.json`);
      if (!r.ok) throw new Error(`data/${name}.json: HTTP ${r.status}`);
      const j = await r.json();
      onStep && onStep(name);
      return j;
    };
    const [w, places, lines] = await Promise.all([get("world"), get("places"), get("lines")]);
    return new World(w, places, lines);
  }

  constructor(w, places, lines) {
    const g = (this.grid = new Grid(w));
    const A = w.arrays;
    for (const k of ["biome", "relief", "feat", "shade", "region", "province", "country", "crop", "tree", "built", "bare"]) this[k] = decode(A[k], Uint8Array);
    this.elev = decode(A.elev, Int16Array);
    this.countries = w.countries;
    this.hexAreaKm2 = w.hexAreaKm2;
    this.lines = lines;
    for (const key of ["rivers", "roads", "rail"]) for (const o of lines[key] || []) {
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (let i = 0; i < o.p.length; i += 2) { x0 = Math.min(x0, o.p[i]); x1 = Math.max(x1, o.p[i]); y0 = Math.min(y0, o.p[i + 1]); y1 = Math.max(y1, o.p[i + 1]); }
      o.b = [x0, y0, x1, y1];
    }
    Object.assign(this, { meta: places.meta, national: places.national, yields: places.yields, regions: places.regions, provinces: places.provinces,
      cities: places.cities, resources: places.resources, facts: places.facts || [], sectors: places.sectors || null, quickLenses: places.quickLenses || [],
      sources: places.sources || [], resourceCats: places.resourceCats || [] });
    this.regionById = new Map(this.regions.map((r) => [r.id, r]));
    this.provinceById = new Map(this.provinces.map((p) => [p.id, p]));
    this.cityById = new Map(this.cities.map((c) => [c.id, c]));
    this.resourceById = new Map(this.resources.map((r) => [r.id, r]));
    // world.json stores 1-based indexes into its own region/province id lists
    this.regionOfIdx = [null, ...w.regions.map((id) => this.regionById.get(id))];
    this.provinceOfIdx = [null, ...w.provinces.map((id) => this.provinceById.get(id))];
    this.regions.forEach((r) => (r.idx = w.regions.indexOf(r.id) + 1));
    this.provinces.forEach((p) => (p.idx = w.provinces.indexOf(p.id) + 1));

    // per-unit geography from the hexes themselves
    const init = () => ({ n: 0, sx: 0, sy: 0, x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9, biome: [0, 0, 0, 0, 0, 0, 0], relief: [0, 0, 0], forest: 0, oasis: 0, elev: 0, top: -1e9, topCell: -1 });
    const accR = this.regionOfIdx.map(init), accP = this.provinceOfIdx.map(init);
    for (let i = 0; i < g.n; i++) {
      const p = this.province[i];
      if (!p) continue;
      const x = g.cx(i), y = g.cy(i);
      for (const a of [accR[this.region[i]], accP[p]]) {
        a.n++; a.sx += x; a.sy += y; a.x0 = Math.min(a.x0, x); a.x1 = Math.max(a.x1, x); a.y0 = Math.min(a.y0, y); a.y1 = Math.max(a.y1, y);
        a.biome[this.biome[i]]++; a.relief[this.relief[i]]++; if (this.feat[i] & 1) a.forest++; if (this.feat[i] & 2) a.oasis++;
        a.elev += this.elev[i]; if (this.elev[i] > a.top) { a.top = this.elev[i]; a.topCell = i; }
      }
    }
    const fin = (u, a) => { if (u && a.n) u.geo = { ...a, cx: a.sx / a.n, cy: a.sy / a.n, meanElev: a.elev / a.n }; };
    this.regionOfIdx.forEach((u, k) => fin(u, accR[k]));
    this.provinceOfIdx.forEach((u, k) => fin(u, accP[k]));

    this.cityAt = new Map();
    for (const c of this.cities) { c.x = g.cx(c.cell); c.y = g.cy(c.cell); this.cityAt.set(c.cell, c); }
    this.cities.sort((a, b) => b.pop2024 - a.pop2024);
    this.cities.forEach((c, k) => (c.rank = k + 1));
    this.resAt = new Map();
    for (const r of this.resources) {
      r.x = g.cx(r.cell); r.y = g.cy(r.cell);
      if (!this.resAt.has(r.cell)) this.resAt.set(r.cell, []);
      this.resAt.get(r.cell).push(r);
    }
    // which named river runs through a hex (sampled every ~3 km along each line)
    this.riverAt = new Map();
    for (const rv of lines.rivers || []) {
      if (!rv.n) continue;
      const p = rv.p;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const n = Math.max(1, Math.ceil(Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]) / 3));
        for (let k = 0; k <= n; k++) {
          const c = g.cellAt(p[i] + ((p[i + 2] - p[i]) * k) / n, p[i + 1] + ((p[i + 3] - p[i + 1]) * k) / n);
          if (c >= 0 && !this.riverAt.has(c)) this.riverAt.set(c, rv.n);
        }
      }
    }
    this.lenses = [];
    for (const L of places.lenses || []) this.lenses.push(this.makeLens(L));
    this.addHexLenses();
    this.lensById = new Map(this.lenses.map((l) => [l.id, l]));
  }

  makeLens(L) {
    const units = L.level === "region" ? this.regionOfIdx : this.provinceOfIdx;
    const vals = new Float64Array(units.length).fill(NaN);
    units.forEach((u, k) => { if (u && L.values[u.id] != null) vals[k] = L.values[u.id]; });
    const arr = L.level === "region" ? this.region : this.province;
    const lens = { ...L, valueAt: (i) => (this.province[i] ? vals[arr[i]] : NaN), unitAt: (i) => (this.province[i] ? units[arr[i]] : null) };
    return this.finishLens(lens, Array.from(vals).filter((v) => !Number.isNaN(v)));
  }

  addHexLenses() {
    const P = this.province, n = this.grid.n;
    const mk = (id, label, fmtKind, ramp, arr, note, group = "Land") => {
      const sample = [];
      for (let i = 0; i < n; i += 3) if (P[i]) sample.push(arr[i]);
      this.lenses.push(this.finishLens({ id, label, group, level: "hex", fmt: fmtKind, ramp, scale: "linear", note, clip: true,
        source: "Computed per hex", valueAt: (i) => (P[i] ? arr[i] : NaN), unitAt: () => null }, sample));
    };
    mk("elevation", "Elevation", "m", "hypso", this.elev, "Mean elevation of the hex, from SRTM/GMTED terrain tiles (Mapzen terrarium).");
    mk("cropland", "Cropland", "pct0", "green", this.crop, "Share of the hex mapped as cropland by ESA WorldCover 2021.");
    mk("trees", "Tree cover", "pct0", "teal", this.tree, "Share of the hex mapped as tree cover by ESA WorldCover 2021.");
    mk("builtup", "Built-up", "pct0", "magma", this.built, "Share of the hex mapped as built-up by ESA WorldCover 2021.");
  }

  finishLens(lens, sample) {
    sample.sort((a, b) => a - b);
    const q = (p) => sample.length ? sample[Math.min(sample.length - 1, Math.floor(p * sample.length))] : 0;
    const tail = lens.level === "hex" ? [0.02, 0.985] : [0.05, 0.95];
    let lo = lens.clip ? q(tail[0]) : q(0), hi = lens.clip ? q(tail[1]) : q(1);
    if (lens.scale === "diverge") { const m = Math.max(Math.abs(lo), Math.abs(hi)); lo = -m; hi = m; }
    if (lens.scale === "log") { lo = Math.max(lo, 1e-9); }
    if (hi <= lo) hi = lo + 1;
    lens.lo = lo; lens.hi = hi; lens.filter = null;
    const tx = lens.scale === "log" ? (v) => Math.log(Math.max(v, lo) / lo) / Math.log(hi / lo) : (v) => (v - lo) / (hi - lo);
    lens.t = (v) => clamp(tx(v), 0, 1);
    lens.inv = lens.scale === "log" ? (t) => lo * Math.pow(hi / lo, t) : (t) => lo + (hi - lo) * t;
    lens.color = (i) => {
      const v = lens.valueAt(i);
      if (Number.isNaN(v)) return null;
      const t = lens.t(v);
      if (lens.filter && (t < lens.filter[0] || t > lens.filter[1])) return [58, 62, 72];
      return rampColor(lens.ramp, t);
    };
    lens.format = (v) => fmt(v, lens.fmt);
    return lens;
  }

  terrainName(i) {
    const b = this.biome[i];
    if (b <= 2) return BIOME_NAME[b];
    const f = this.feat[i], rl = this.relief[i];
    let name = BIOME_NAME[b];
    if (rl === 2) name = (b === 6 ? "Desert " : b === 3 ? "Farmed " : "") + "mountains";
    else if (rl === 1) name = (b === 6 ? "Desert" : b === 3 ? "Farmed" : b === 4 ? "Grassy" : "Scrub") + " hills";
    name = name.charAt(0).toUpperCase() + name.slice(1);
    const extra = [];
    if (f & 1) extra.push("forest");
    if (f & 2) extra.push("oasis");
    if (f & 4) extra.push("marsh");
    if (f & 16) extra.push("snow line");
    return extra.length ? `${name} · ${extra.join(", ")}` : name;
  }
  reliefName(i) { return RELIEF_NAME[this.relief[i]]; }
  regionAt(i) { return this.regionOfIdx[this.region[i]] || null; }
  provinceAt(i) { return this.provinceOfIdx[this.province[i]] || null; }
  citiesIn(kind, id) { return this.cities.filter((c) => c[kind] === id); }
  resourcesIn(kind, id) { return this.resources.filter((r) => r[kind] === id); }
  nearbyResources(x, y, km) {
    return this.resources.map((r) => [Math.hypot(r.x - x, r.y - y), r]).filter((a) => a[0] <= km).sort((a, b) => a[0] - b[0]);
  }
  // Rank of a unit among its peers for a value map {id: value}; 1 = highest.
  rankOf(values, id) {
    const v = values[id];
    if (v == null) return null;
    let rank = 1, n = 0;
    for (const k in values) { if (values[k] == null) continue; n++; if (values[k] > v) rank++; }
    return { rank, n };
  }
}
