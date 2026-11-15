// One week in Toubkal National Park.
// A Three.js scene of the park that plays a period hour by hour: walking conditions at 12 places,
// model weather at 14 points, modelled river flow at 4, and the sun from its true position.
// Static layers come from data/ (built by pipeline/01_build_scene.py); weather and river flow are
// read live from Open-Meteo, with data/snapshot.json as the fallback when that request fails.
// Layout and idea after Tomaž Berčič's "One week in Triglav National Park".

import * as THREE from 'three';
import { OrbitControls } from '../vendor/three/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from '../vendor/three/CSS2DRenderer.js';

// ---------- constants ----------
const TZ_H = 1;                 // Morocco standard time, UTC+1
const DAY = 864e5, HOUR = 36e5;
const EX = 1.5;                 // vertical exaggeration
const Z0 = 600;                 // metres; the base of the block
const RATE = 2.4;               // hours of park time per second at 1x
const MAX_DAYS = 31, PAST_DAYS = 88, AHEAD_DAYS = 7;
const GOOD = 70, FAIR = 40;     // walking index thresholds
const FLOOD_HISTORY_DAYS = 90;
const HOURLY = 'temperature_2m,precipitation,snowfall,snow_depth,cloud_cover,wind_speed_10m,wind_direction_10m,' +
  'freezing_level_height,wind_speed_700hPa,wind_direction_700hPa,wind_speed_600hPa,wind_direction_600hPa';
const COL = { good: '#6EE7B7', fair: '#FFB648', poor: '#FF6B6B', night: '#51606E', water: '#5AB0FF', cold: '#9FD0FF', warm: '#FFD08A' };

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, k) => a + (b - a) * k;
const smooth = (v, a, b) => { const k = clamp((v - a) / (b - a)); return k * k * (3 - 2 * k); };
const rad = Math.PI / 180;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const store = {
  get(k, d) { try { const v = localStorage.getItem('tbk.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('tbk.' + k, JSON.stringify(v)); } catch (e) { /* private window */ } },
  del(k) { try { localStorage.removeItem('tbk.' + k); } catch (e) { /* private window */ } },
};
const setText = (el, s) => { if (el && el._t !== s) { el._t = s; el.textContent = s; } };
const setHTML = (el, s) => { if (el && el._t !== s) { el._t = s; el.innerHTML = s; } };
const num = (v, d = 0) => (v < 0 ? '−' : '') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const deg = v => v == null ? '–' : num(Math.abs(v) < 0.05 ? 0 : v, 1) + ' °C';
const iso = ms => new Date(ms).toISOString().slice(0, 10);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Local dates are handled as the UTC midnight of the same calendar date, so Intl can format them with timeZone UTC.
const fmtD = (ms, loc, opt) => new Intl.DateTimeFormat(loc, { timeZone: 'UTC', ...opt }).format(ms);
const today = Math.floor((Date.now() + TZ_H * HOUR) / DAY) * DAY;

// ---------- period: the last 7 full days, or #from=YYYY-MM-DD&to=YYYY-MM-DD ----------
function readPeriod() {
  const q = new URLSearchParams(location.hash.slice(1));
  const parse = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? Date.parse(s + 'T00:00:00Z') : NaN;
  let from = parse(q.get('from')), to = parse(q.get('to'));
  const lo = today - PAST_DAYS * DAY, hi = today + AHEAD_DAYS * DAY;
  if (!(from <= to) || from < lo || to > hi) { to = today - DAY; from = to - 6 * DAY; }
  if ((to - from) / DAY + 1 > MAX_DAYS) from = to - (MAX_DAYS - 1) * DAY;
  return { from, to };
}
let { from: FROM, to: TO } = readPeriod();
let DAYS, HOURS;

// ---------- sun position (NOAA low-precision formulas) ----------
function sunPos(ms, lat, lon) {
  const d = ms / DAY - 10957.5;
  const g = (357.529 + 0.98560028 * d) * rad, q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad, e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ha = ((18.697374558 + 24.06570982441908 * d) * 15 + lon) * rad - ra, la = lat * rad;
  const el = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(ha));
  return [el / rad, ((az / rad) + 360) % 360];
}

// ---------- load the static scene ----------
const msg = s => { $('#loadmsg').textContent = s; };
let started = false;
const fail = e => { if (started) return; console.error(e); $('.spin').hidden = true; msg('The park could not be drawn here. This page needs WebGL and a recent browser. · Affichage impossible : WebGL et un navigateur récent sont nécessaires.'); };
addEventListener('error', e => fail(e.error || e.message)); addEventListener('unhandledrejection', e => fail(e.reason));
async function loadDem(url, gw, gh) {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const cv = document.createElement('canvas'); cv.width = gw; cv.height = gh;
  const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0);
  const px = g.getImageData(0, 0, gw, gh).data, out = new Float32Array(gw * gh);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4] * 256 + px[i * 4 + 1];
  return out;
}
const S = await (await fetch('data/scene.json')).json();
const [GW, GH] = S.grid, [WKM, HKM] = S.km;
const dem = await loadDem('data/dem.png', GW, GH);
const hAt = (x, y) => {       // metres, bilinear on the mesh grid
  const c = clamp((x / WKM + .5) * GW - .5, 0, GW - 1.001), r = clamp((.5 - y / HKM) * GH - .5, 0, GH - 1.001);
  const c0 = Math.floor(c), r0 = Math.floor(r), fc = c - c0, fr = r - r0, i = r0 * GW + c0;
  return lerp(lerp(dem[i], dem[i + 1], fc), lerp(dem[i + GW], dem[i + GW + 1], fc), fr);
};
const yOf = z => (z - Z0) / 1000 * EX;
const V = (x, y, lift = 0) => new THREE.Vector3(x, yOf(hAt(x, y)) + lift, -y);
const PTS = S.points, SCORED = PTS.filter(p => p.score), GAUGES = S.gauges;
const [LON0, LAT0] = S.center;

// ---------- weather and river data ----------
async function getJSON(url, ms = 15000) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { signal: ac.signal }); if (!r.ok) throw new Error(r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
async function loadLive() {
  const w = `https://api.open-meteo.com/v1/forecast?latitude=${PTS.map(p => p.lat)}&longitude=${PTS.map(p => p.lon)}` +
    `&elevation=${PTS.map(p => p.elev)}&hourly=${HOURLY}&wind_speed_unit=ms&timezone=GMT&start_date=${iso(FROM - DAY)}&end_date=${iso(TO)}`;
  const f = `https://flood-api.open-meteo.com/v1/flood?latitude=${GAUGES.map(g => g.cell[0])}&longitude=${GAUGES.map(g => g.cell[1])}` +
    `&daily=river_discharge&start_date=${iso(FROM - FLOOD_HISTORY_DAYS * DAY)}&end_date=${iso(TO + DAY)}`;
  const [weather, flood] = await Promise.all([getJSON(w), getJSON(f).catch(() => null)]);
  if (!Array.isArray(weather) || weather.length !== PTS.length) throw new Error('weather response');
  return { weather, flood: Array.isArray(flood) && flood.length === GAUGES.length ? flood : null, live: true };
}
let DATA, sourceNote = '';
msg('Reading the weather model · Lecture du modèle météo');
try { DATA = await loadLive(); }
catch (e) {
  const snap = await (await fetch('data/snapshot.json')).json();
  FROM = Date.parse(snap.from + 'T00:00:00Z'); TO = Date.parse(snap.to + 'T00:00:00Z');
  DATA = { weather: snap.weather, flood: snap.flood, live: false, fetched: snap.fetched };
  sourceNote = `Live data could not be reached, so this is the saved week of ${fmtD(FROM, 'en-GB', { day: 'numeric', month: 'short' })} to ${fmtD(TO, 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}. · Données en direct indisponibles : semaine enregistrée.`;
}
DAYS = Math.round((TO - FROM) / DAY) + 1; HOURS = DAYS * 24;
const msAt = h => FROM + (h - TZ_H) * HOUR;          // UTC instant of local hour h of the period
const isForecast = TO >= today;

// hourly series per point, in local hours of the period
function series(w, key) {
  const t0 = Date.parse(w.hourly.time[0] + ':00Z'), src = w.hourly[key] || [], out = new Array(HOURS);
  for (let i = 0; i < HOURS; i++) { const v = src[Math.round((msAt(i) - t0) / HOUR)]; out[i] = v == null ? null : v; }
  return out;
}
const sunH = new Float32Array(HOURS);                 // sun elevation at mid-hour, centre of the map
for (let i = 0; i < HOURS; i++) sunH[i] = sunPos(msAt(i + .5), LAT0, LON0)[0];
const isDay = i => sunH[i] > 0;

function windChill(T, v) {                            // °C, m/s
  const k = v * 3.6;
  return T <= 10 && k >= 4.8 ? 13.12 + 0.6215 * T - 11.37 * k ** 0.16 + 0.3965 * T * k ** 0.16 : T;
}
function walkIndex(T, w, rr, cc) {
  if (T == null || w == null) return null;
  const feels = windChill(T, w);
  const fW = 1 - clamp((w - 5) / 15);
  const fT = feels < -5 ? 1 - clamp((-5 - feels) / 20) : feels > 28 ? 1 - clamp((feels - 28) / 12) : 1;
  const fP = 1 - Math.min(1, Math.sqrt((rr || 0) / 4));
  const fC = 1 - 0.25 * (cc || 0) / 100;
  return 100 * fW * fT * fP * fC;
}
PTS.forEach((p, k) => {
  const w = DATA.weather[k];
  p.T = series(w, 'temperature_2m'); p.rr = series(w, 'precipitation'); p.cc = series(w, 'cloud_cover');
  p.sd = series(w, 'snow_depth'); p.frz = series(w, 'freezing_level_height');
  const s10 = series(w, 'wind_speed_10m'), d10 = series(w, 'wind_direction_10m');
  const sL = p.wind === '10m' ? s10 : series(w, 'wind_speed_' + p.wind), dL = p.wind === '10m' ? d10 : series(w, 'wind_direction_' + p.wind);
  p.ws = s10.map((v, i) => sL[i] ?? v); p.wd = d10.map((v, i) => sL[i] == null ? v : dL[i]);
  p.S = p.T.map((T, i) => walkIndex(T, p.ws[i], p.rr[i], p.cc[i]));
  p.good = p.S.map((s, i) => isDay(i) && s != null && s >= GOOD ? 1 : 0);
  p.cum = new Float32Array(HOURS + 1); p.good.forEach((g, i) => { p.cum[i + 1] = p.cum[i] + g; });
  p.dayMean = []; p.dayGood = [];
  for (let d = 0; d < DAYS; d++) {
    let s = 0, n = 0, g = 0;
    for (let i = d * 24; i < d * 24 + 24; i++) { if (isDay(i) && p.S[i] != null) { s += p.S[i]; n++; } g += p.good[i]; }
    p.dayMean.push(n ? s / n : 0); p.dayGood.push(g);
  }
  p.total = p.cum[HOURS];
});
const TOTAL = SCORED.reduce((s, p) => s + p.total, 0);
const dayGood = [...Array(DAYS)].map((_, d) => SCORED.reduce((s, p) => s + p.dayGood[d], 0));
const meanRain = [...Array(HOURS)].map((_, i) => PTS.reduce((s, p) => s + (p.rr[i] || 0), 0) / PTS.length);
const snowShare = [...Array(HOURS)].map((_, i) => { let a = 0, b = 0; PTS.forEach(p => { const r = p.rr[i] || 0; b += r; if (p.T[i] != null && p.T[i] <= 1) a += r; }); return b ? a / b : 0; });
const meanScore = [...Array(HOURS)].map((_, i) => { let s = 0, n = 0; SCORED.forEach(p => { if (p.S[i] != null) { s += p.S[i]; n++; } }); return n ? s / n : null; });
const meanFrz = [...Array(HOURS)].map((_, i) => { let s = 0, n = 0; PTS.forEach(p => { if (p.frz[i] != null) { s += p.frz[i]; n++; } }); return n ? s / n : null; });
const hv = (a, h) => {          // value of an hourly series at fractional hour h (values sit at the top of the hour)
  const i = Math.floor(h), k = h - i, v0 = a[clamp(i, 0, HOURS - 1)], v1 = a[clamp(i + 1, 0, HOURS - 1)];
  return v0 == null ? v1 : v1 == null ? v0 : lerp(v0, v1, k);
};
const statusOf = (s, day) => !day ? 'nite' : s == null ? 'nite' : s >= GOOD ? 'good' : s >= FAIR ? 'fair' : 'poor';
const WORD = { good: 'good · bon', fair: 'fair · moyen', poor: 'poor · mauvais', nite: 'night · nuit' };
const colOf = st => COL[st === 'nite' ? 'night' : st];

// rivers: daily model values, joined by a straight line between the middles of the days
GAUGES.forEach((g, k) => {
  const d = DATA.flood?.[k]?.daily;
  g.q = new Array(HOURS).fill(null); g.med = null;
  if (!d) return;
  const t = d.time.map(s => Date.parse(s + 'T12:00:00Z')), v = d.river_discharge;
  for (let i = 0; i < HOURS; i++) {
    const m = msAt(i); let j = t.findIndex(x => x > m);
    if (j === -1) j = t.length; const a = Math.max(0, j - 1), b = Math.min(t.length - 1, j);
    if (v[a] == null && v[b] == null) continue;
    g.q[i] = a === b || v[a] == null || v[b] == null ? (v[a] ?? v[b]) : lerp(v[a], v[b], clamp((m - t[a]) / (t[b] - t[a])));
  }
  const hist = v.filter((x, i) => x != null && t[i] <= Math.max(TO, today) + DAY).sort((a, b) => a - b);
  g.med = hist.length ? hist[Math.floor(hist.length / 2)] : null;
});
const hasFlow = GAUGES.some(g => g.q.some(v => v != null));

// sunrise and sunset of each day, to the minute
const sunTimes = [...Array(DAYS)].map((_, d) => {
  let rise = null, set = null, prev = sunPos(msAt(d * 24), LAT0, LON0)[0];
  for (let m = 2; m <= 1440; m += 2) {
    const e = sunPos(msAt(d * 24 + m / 60), LAT0, LON0)[0];
    if (prev <= 0 && e > 0) rise = m; if (prev > 0 && e <= 0) set = m; prev = e;
  }
  return { rise, set };
});
const hm = m => m == null ? '–' : Math.floor(m / 60) + ':' + String(Math.round(m % 60)).padStart(2, '0');

// ---------- three ----------
msg('Building the terrain · Construction du relief');
const host = $('#stage');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
host.appendChild(renderer.domElement);
const labelRenderer = new CSS2DRenderer({ element: $('#labels') });
const scene = new THREE.Scene();
const nightC = new THREE.Color('#050A13'), dayC = new THREE.Color('#10263A');
scene.background = nightC.clone(); scene.fog = new THREE.Fog(nightC.clone(), 80, 210);
const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 600);
const HOME = { target: new THREE.Vector3(3, 2.2, 2.5), pos: new THREE.Vector3(-9, 37, 56) };
camera.position.copy(HOME.pos);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(HOME.target); controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.46;
controls.minDistance = 8; controls.maxDistance = 150; controls.zoomToCursor = true;
controls.autoRotate = !reduce && store.get('orbit', true); controls.autoRotateSpeed = 0.32;
$('#tgOrbit').setAttribute('aria-pressed', String(controls.autoRotate));
renderer.domElement.addEventListener('pointerdown', () => { controls.autoRotate = false; $('#tgOrbit').setAttribute('aria-pressed', 'false'); fly = null; });

const layers = {};            // name -> THREE.Group (or a list of objects) switched from the legend
const layer = name => { if (!layers[name]) { layers[name] = new THREE.Group(); scene.add(layers[name]); } return layers[name]; };

// terrain: one vertex per elevation cell, lit by the sun; the model's snow is laid on by elevation
const tex = await new THREE.TextureLoader().loadAsync('data/albedo.jpg');
tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
const PW = WKM * (GW - 1) / GW, PH = HKM * (GH - 1) / GH;
const geo = new THREE.PlaneGeometry(PW, PH, GW - 1, GH - 1); geo.rotateX(-Math.PI / 2);
{
  const pos = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, yOf(dem[i]));
    uv.setXY(i, (uv.getX(i) * (GW - 1) + .5) / GW, (uv.getY(i) * (GH - 1) + .5) / GH);
  }
  geo.computeVertexNormals();
}
const uSnow = { value: 99 }, uSnowAmt = { value: 0 };
const terrainMat = new THREE.MeshStandardMaterial({ map: tex, roughness: .95, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
terrainMat.onBeforeCompile = sh => {
  sh.uniforms.uSnow = uSnow; sh.uniforms.uSnowAmt = uSnowAmt;
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vElev;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvElev = position.y;');
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vElev; uniform float uSnow; uniform float uSnowAmt;')
    .replace('#include <map_fragment>', `#include <map_fragment>
      float sn = smoothstep(uSnow - .2, uSnow + .4, vElev + .14 * sin(vMapUv.x * 310.) * sin(vMapUv.y * 270.));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.80, .86, .95) * (.5 + 1.6 * dot(diffuseColor.rgb, vec3(.333))), sn * uSnowAmt);`);
};
const terrain = new THREE.Mesh(geo, terrainMat);
terrain.castShadow = true; terrain.receiveShadow = true; scene.add(terrain);

// the block the terrain stands on, and a floor grid
const BASE = -0.35;
{
  const verts = [], cols = [], idx = [], top = new THREE.Color('#1B3045'), bot = new THREE.Color('#060B14'), pos = geo.attributes.position;
  const edge = list => {
    const s = verts.length / 3;
    list.forEach(i => { verts.push(pos.getX(i), pos.getY(i), pos.getZ(i), pos.getX(i), BASE, pos.getZ(i)); cols.push(top.r, top.g, top.b, bot.r, bot.g, bot.b); });
    for (let i = 0; i < list.length - 1; i++) { const a = s + i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  };
  const row = r => [...Array(GW)].map((_, c) => r * GW + c), col = c => [...Array(GH)].map((_, r) => r * GW + c);
  edge(row(GH - 1)); edge(col(GW - 1).reverse()); edge(row(0).reverse()); edge(col(0));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3)); g.setIndex(idx);
  scene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));
  const grid = new THREE.GridHelper(260, 104, 0x1E4A66, 0x10283A); grid.position.y = BASE - .5;
  grid.material.transparent = true; grid.material.opacity = .32; scene.add(grid);
}

// lights
const sunL = new THREE.DirectionalLight(0xFFF1DC, 2.4); sunL.castShadow = true;
const shadowSize = renderer.capabilities.maxTextureSize >= 4096 && innerWidth > 900 ? 4096 : 2048;
sunL.shadow.mapSize.set(shadowSize, shadowSize);
Object.assign(sunL.shadow.camera, { left: -38, right: 38, top: 38, bottom: -38, near: 1, far: 220 });
sunL.shadow.bias = -0.0005; sunL.shadow.normalBias = 0.04;
scene.add(sunL, sunL.target);
const moonL = new THREE.DirectionalLight(0x8FB4FF, .35); moonL.position.set(-30, 40, -20); scene.add(moonL);
const hemi = new THREE.HemisphereLight(0xA8CCFF, 0x22303C, .55); scene.add(hemi);

// ---------- lines draped on the ground ----------
function lineSet(polys, color, opacity, lift, opt = {}) {
  const v = [];
  for (const p of polys) for (let i = 0; i < p.length - 1; i++) {
    const a = V(p[i][0], p[i][1], lift), b = V(p[i + 1][0], p[i + 1][1], lift); v.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  const m = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false, ...opt }));
  m.renderOrder = 2; return m;
}
const inPark = (() => {       // even-odd test against the park ring, for dimming what lies outside
  const ring = S.boundary[0];
  return (x, y) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
})();
layer('roads').add(lineSet(S.roads.filter(r => r.k === 'minor').map(r => r.p), 0x8796A6, .28, .035));
layer('roads').add(lineSet(S.roads.filter(r => r.k === 'main').map(r => r.p), 0xD4DCE4, .8, .04));
layer('trails').add(lineSet(S.trails, 0xFFD08A, .3, .035));
layer('routes').add(lineSet(S.routes.map(r => r.p), 0xFFD08A, .95, .05));
layer('rivers').add(lineSet(S.rivers.filter(r => r.k === 'stream').map(r => r.p), 0x3F8FE0, .38, .03));
layer('rivers').add(lineSet(S.rivers.filter(r => r.k === 'river').map(r => r.p), 0x5AB0FF, .95, .04));
layer('lifts').add(lineSet(S.lifts.map(l => l.p), 0xC9A7FF, .95, .12));
for (const lk of S.lakes) {
  const pts = lk.p.filter(p => Math.abs(p[0]) < WKM / 2 && Math.abs(p[1]) < HKM / 2);
  if (pts.length < 4) continue;
  const sh = new THREE.Shape(pts.map(p => new THREE.Vector2(p[0], p[1])));
  const g = new THREE.ShapeGeometry(sh); g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x2C7BD6, emissive: 0x123A6E, roughness: .25, metalness: .1 }));
  m.position.y = yOf(Math.min(...pts.map(p => hAt(p[0], p[1])))) + .035; layer('rivers').add(m);
}

// glowing park fence
const fenceMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  uniforms: { c: { value: new THREE.Color('#67E0FF') }, t: { value: 0 } },
  vertexShader: 'attribute float up; attribute float al; varying float vUp; varying float vAl; void main(){ vUp = up; vAl = al; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
  fragmentShader: 'uniform vec3 c; uniform float t; varying float vUp; varying float vAl; void main(){ float band = pow(.5 + .5 * sin(vAl * .32 - t * 2.), 24.); float a = (1. - vUp) * (1. - vUp) * (.4 + 1.1 * band); gl_FragColor = vec4(c + band * .4, a); }',
});
for (const ring of S.boundary) {
  const v = [], up = [], al = [], id = []; let L = 0;
  ring.forEach((p, i) => {
    const a = V(p[0], p[1], .02); if (i) L += Math.hypot(p[0] - ring[i - 1][0], p[1] - ring[i - 1][1]);
    v.push(a.x, a.y, a.z, a.x, a.y + .5, a.z); up.push(0, 1); al.push(L, L);
    if (i < ring.length - 1) { const k = i * 2; id.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); g.setAttribute('up', new THREE.Float32BufferAttribute(up, 1)); g.setAttribute('al', new THREE.Float32BufferAttribute(al, 1)); g.setIndex(id);
  layer('boundary').add(new THREE.Mesh(g, fenceMat));
  layer('boundary').add(lineSet([ring], 0x9BEBFF, .9, .03));
}

// ---------- dots that travel along lines: river flow, cars, hikers ----------
const dotMat = (color, size, min = 1.5) => new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { c: { value: new THREE.Color(color) }, s: { value: size }, px: { value: 1 }, mn: { value: min } },
  vertexShader: 'attribute float a; varying float vA; uniform float s; uniform float px; uniform float mn; void main(){ vA = a; vec4 mv = modelViewMatrix * vec4(position, 1.); gl_PointSize = clamp(s * px / -mv.z, mn * px, 9. * px); gl_Position = projectionMatrix * mv; }',
  fragmentShader: 'uniform vec3 c; varying float vA; void main(){ float r = length(gl_PointCoord - .5); float k = smoothstep(.5, .1, r); gl_FragColor = vec4(c, k * vA); }',
});
class Movers {
  constructor(polys, perKm, color, size, lift, bounce, min) {
    this.paths = polys.map(p => { const pts = p.map(q => V(q[0], q[1], lift)), cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1])); return { pts, cum, len: cum[cum.length - 1] }; }).filter(p => p.len > .3);
    this.parts = [];
    this.paths.forEach((p, k) => { const n = Math.max(1, Math.round(p.len * perKm)); for (let i = 0; i < n; i++) this.parts.push({ k, s: Math.random() * p.len, dir: bounce && Math.random() < .5 ? -1 : 1, rank: (i + Math.random()) / n, a: 0, v: .7 + .6 * Math.random(), seg: 0 }); });
    this.bounce = bounce;
    const n = this.parts.length;
    this.pos = new Float32Array(n * 3); this.al = new Float32Array(n);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3)); g.setAttribute('a', new THREE.BufferAttribute(this.al, 1));
    this.obj = new THREE.Points(g, dotMat(color, size, min)); this.obj.frustumCulled = false; this.obj.renderOrder = 3;
  }
  step(dt, speed, density, real) {  // density(pathIndex) in 0..1: the share of this path's dots that show; real: wall-clock dt for fading
    const tmp = Movers.tmp;
    this.parts.forEach((q, i) => {
      const p = this.paths[q.k];
      q.s += q.dir * q.v * speed * dt;
      if (q.s > p.len) { if (this.bounce) { q.s = p.len; q.dir = -1; } else { q.s = 0; q.seg = 0; } }
      if (q.s < 0) { q.s = 0; q.dir = 1; }
      while (q.seg < p.cum.length - 2 && p.cum[q.seg + 1] < q.s) q.seg++;
      while (q.seg > 0 && p.cum[q.seg] > q.s) q.seg--;
      const a = p.pts[q.seg], b = p.pts[q.seg + 1], k = clamp((q.s - p.cum[q.seg]) / (p.cum[q.seg + 1] - p.cum[q.seg] || 1));
      tmp.lerpVectors(a, b, k); this.pos[i * 3] = tmp.x; this.pos[i * 3 + 1] = tmp.y; this.pos[i * 3 + 2] = tmp.z;
      const want = q.rank < density(q.k) ? 1 : 0; q.a += (want - q.a) * Math.min(1, real * 3); this.al[i] = q.a;
    });
    this.obj.geometry.attributes.position.needsUpdate = true; this.obj.geometry.attributes.a.needsUpdate = true;
  }
}
Movers.tmp = new THREE.Vector3();
const flowDots = new Movers(S.rivers.filter(r => r.k === 'river').map(r => r.p), 1.1, '#9AD1FF', 56, .07, false, 2);
const carDots = new Movers(S.roads.filter(r => r.k === 'main').map(r => r.p), .5, '#FFF3C4', 80, .08, true, 2.4);
const hikerDots = new Movers(S.routes.map(r => r.p), 3.2, '#FFE6BD', 80, .09, true, 2.6);
layer('rivers').add(flowDots.obj); layer('roads').add(carDots.obj); layer('routes').add(hikerDots.obj);
const routePts = S.routes.map(r => r.via.map(id => PTS.find(p => p.id === id)));

// ---------- particles: sparks, rain, snow, cloud ----------
class Pool {
  constructor(n, color, size, blend, soft) {
    this.n = n; this.i = 0;
    this.pos = new Float32Array(n * 3).fill(-999); this.vel = new Float32Array(n * 3); this.life = new Float32Array(n); this.max = new Float32Array(n).fill(1); this.floor = new Float32Array(n); this.al = new Float32Array(n);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3)); g.setAttribute('a', new THREE.BufferAttribute(this.al, 1));
    const m = dotMat(color, size); m.blending = blend;
    if (soft) m.fragmentShader = 'uniform vec3 c; varying float vA; void main(){ float r = length(gl_PointCoord - .5); float k = smoothstep(.5, 0., r); gl_FragColor = vec4(c, k * k * vA); }';
    if (soft) m.vertexShader = m.vertexShader.replace('9. * px', '160. * px');
    this.obj = new THREE.Points(g, m); this.obj.frustumCulled = false; this.obj.renderOrder = 5; this.peak = soft ? .22 : 1;
  }
  emit(x, y, z, vx, vy, vz, life, floor) {
    const i = this.i; this.i = (i + 1) % this.n;
    this.pos.set([x, y, z], i * 3); this.vel.set([vx, vy, vz], i * 3); this.life[i] = life; this.max[i] = life; this.floor[i] = floor;
  }
  step(dt) {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) { this.al[i] = 0; continue; }
      this.life[i] -= dt; const k = i * 3;
      this.pos[k] += this.vel[k] * dt; this.pos[k + 1] += this.vel[k + 1] * dt; this.pos[k + 2] += this.vel[k + 2] * dt;
      const u = this.life[i] / this.max[i];
      this.al[i] = this.peak * Math.min(1, u * 4, (1 - u) * 6);
      if (this.life[i] <= 0 || this.pos[k + 1] < this.floor[i]) { this.life[i] = 0; this.al[i] = 0; this.pos[k + 1] = -999; }
    }
    this.obj.geometry.attributes.position.needsUpdate = true; this.obj.geometry.attributes.a.needsUpdate = true;
  }
}
const sparks = new Pool(900, '#FFE6BD', 40, THREE.AdditiveBlending), rain = new Pool(2600, '#7DBDFF', 26, THREE.AdditiveBlending),
  snowP = new Pool(2600, '#FFFFFF', 34, THREE.AdditiveBlending), clouds = new Pool(420, '#B9C6D6', 2600, THREE.NormalBlending, true);
layer('beacons').add(sparks.obj); layer('precip').add(rain.obj, snowP.obj, clouds.obj);

// ---------- labels ----------
const allLabels = [];
function label(html, cls, pos, prio, onClick) {
  const d = document.createElement('div'); d.className = 'lbl ' + cls; d.innerHTML = html;
  const o = new CSS2DObject(d); o.position.copy(pos); layer('labels').add(o);
  const L = { o, el: d, prio }; allLabels.push(L);
  if (onClick) d.addEventListener('click', onClick);
  return L;
}
function leader(from, to, color, opacity) {
  const g = new THREE.BufferGeometry().setFromPoints([from, to]);
  const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false })); l.renderOrder = 4; return l;
}
const ARROW = '<svg class="arrow" viewBox="-6 -6 12 12" aria-hidden="true"><path d="M-5 0H4M1-3.2 4.2 0 1 3.2" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// which way a label hangs off its point (CSS2D centre: 0 = starts at the point, 1 = ends at it), so the
// cluster around Toubkal does not pile up in the opening view
const ANCHOR = { toubkal: [0, 1], refuge: [1, .5], ouanoukrim: [1, 0], ouanoums: [1, .5], chamharouch: [0, .5], imlil: [1, 1], ifni: [0, 1], tacheddirt: [1, .5], tizitacheddirt: [0, .5] };

// walking conditions: a beam, pulse rings and a callout at each scored place
const beamGeo = new THREE.CylinderGeometry(.14, .14, 1, 24, 1, true); beamGeo.translate(0, .5, 0);
const ringGeo = new THREE.RingGeometry(.82, 1, 40).rotateX(-Math.PI / 2);
const beacons = SCORED.map(p => {
  const base = V(p.x, p.y), grp = new THREE.Group(); grp.position.copy(base); layer('beacons').add(grp);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, uniforms: { c: { value: new THREE.Color(COL.good) }, o: { value: 1 } },
    vertexShader: 'varying float v; varying vec3 vN; varying vec3 vV; void main(){ v = uv.y; vN = normalMatrix * normal; vec4 mv = modelViewMatrix * vec4(position, 1.); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }',
    fragmentShader: 'uniform vec3 c; uniform float o; varying float v; varying vec3 vN; varying vec3 vV; void main(){ float f = abs(dot(normalize(vN), normalize(vV))); gl_FragColor = vec4(c, o * (.1 + .9 * pow(1. - v, 1.6)) * (.12 + .88 * f * f)); }',
  });
  const beam = new THREE.Mesh(beamGeo, mat); beam.renderOrder = 3; grp.add(beam);
  const rings = [0, .5].map(ph => { const r = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: COL.good, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })); r.position.y = .03; r.userData.ph = ph; r.renderOrder = 3; grp.add(r); return r; });
  const elev = `<small>${num(p.elev)} m</small>`;
  const bars = p.callout ? barsSVG(p) : '';
  const html = p.callout
    ? `<div class="box"><div class="t">${esc(p.name)} ${elev}</div><div class="v"><b class="sc">–</b><small class="st"></small></div><div class="w"><span class="tt"></span>${ARROW}<span class="ws"></span></div>${bars}</div>`
    : `${esc(p.name)} <b class="sc">–</b> <span class="tt"></span>`;
  const L = label(html, p.callout ? 'call' : 'pill', base, p.callout ? 100 : 80, () => flyTo(p));
  if (ANCHOR[p.id]) L.o.center.set(...ANCHOR[p.id]);
  const q = s => L.el.querySelector(s);
  return { p, base, grp, beam, mat, rings, L, sc: q('.sc'), st: q('.st'), tt: q('.tt'), ws: q('.ws'), ar: q('.arrow'), rects: [...L.el.querySelectorAll('rect')], extra: ANCHOR[p.id] ? .15 : p.callout ? 1.3 : .6, acc: 0 };
});
function barsSVG(p) {
  const w = Math.max(3, Math.min(8, 62 / DAYS - 2)), gap = DAYS > 14 ? 1 : 2, W = DAYS * (w + gap) - gap;
  const r = p.dayMean.map((m, d) => { const h = Math.max(1.5, 20 * m / 100); return `<rect x="${(d * (w + gap)).toFixed(1)}" y="${(22 - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="1.2"/>`; }).join('');
  return `<svg class="bars" width="${W}" height="22" aria-hidden="true">${r}</svg>`;
}

// weather-only points: a pill with temperature and wind
const wxOnly = PTS.filter(p => !p.score).map(p => {
  const base = V(p.x, p.y), top = base.clone(); top.y += 1.3;
  layer('weather').add(leader(base, top, 0x9FB0BF, .45));
  const L = label(`${esc(p.name)} <b class="tt"></b>${ARROW}<span class="ws"></span>`, 'pill', top, 75, () => flyTo(p));
  return { p, base, L, tt: L.el.querySelector('.tt'), ws: L.el.querySelector('.ws'), ar: L.el.querySelector('.arrow') };
});

// river model points: a staff gauge whose blue disc rises with the flow
const staffTex = (() => { const c = document.createElement('canvas'); c.width = 8; c.height = 64; const g = c.getContext('2d'); for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? '#F4F7FA' : '#FF5D5D'; g.fillRect(0, i * 8, 8, 8); } const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
const gauges = GAUGES.map(g => {
  const base = V(g.x, g.y), grp = new THREE.Group(); grp.position.copy(base); layer('gauges').add(grp);
  const staff = new THREE.Mesh(new THREE.BoxGeometry(.1, .9, .1), new THREE.MeshBasicMaterial({ map: staffTex })); staff.position.y = .45; grp.add(staff);
  const lvl = new THREE.Mesh(new THREE.CylinderGeometry(.3, .3, .05, 24), new THREE.MeshBasicMaterial({ color: 0x5AB0FF, transparent: true, opacity: .9 })); grp.add(lvl);
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x5AB0FF, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })); ring.position.y = .03; grp.add(ring);
  const top = base.clone(); top.y += 1.5; layer('gauges').add(leader(base.clone().setY(base.y + .9), top, 0x5AB0FF, .5));
  const L = label(`${esc(g.river)} <b class="q">–</b>`, 'pill', top, 70, () => flyTo(g));
  L.group = 'gauges';
  return { g, lvl, ring, L, q: L.el.querySelector('.q') };
});

// peaks and villages
for (const k of S.peaks.slice(0, 7)) { const p = V(k.x, k.y, .45); label(`${esc(k.name)} <span>${num(k.elev)} m</span>`, 'peak2', p, 40); }
for (const k of S.villages) { const p = V(k.x, k.y, .3); label(esc(k.name), 'vil', p, 20); }
{ const lf = S.lifts.find(l => l.k === 'chair_lift') || S.lifts[0]; if (lf) { const m = lf.p[lf.p.length >> 1]; const L = label('ski lifts · remontées', 'vil', V(m[0], m[1], .5), 15); L.group = 'lifts'; } }

// ---------- sky ----------
const sky = layer('sky');
{
  const n = 1500, p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const u = Math.random() * 6.283, v = Math.acos(Math.random() * .94); p.set([Math.sin(v) * Math.cos(u) * 230, Math.cos(v) * 230 + 4, Math.sin(v) * Math.sin(u) * 230], i * 3); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  sky.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xDDE8FF, size: 1.5, sizeAttenuation: false, transparent: true, opacity: .8, depthWrite: false, fog: false })));
}
const sunDisc = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3)),
  new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { o: { value: 1 }, px: { value: 1 } },
    vertexShader: 'uniform float px; void main(){ gl_PointSize = 90. * px; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
    fragmentShader: 'uniform float o; void main(){ float r = length(gl_PointCoord - .5); float a = smoothstep(.5, .0, r); a = a * a * .9 + smoothstep(.12, .08, r); gl_FragColor = vec4(1., .86, .6, a * o); }',
  }));
sunDisc.frustumCulled = false; sky.add(sunDisc);

// ---------- fly to a place ----------
let fly = null;
function flyTo(o) {
  const b = V(o.x, o.y, .6), dir = camera.position.clone().sub(controls.target).setY(0).normalize();
  fly = { t0: performance.now(), a: controls.target.clone(), b, ca: camera.position.clone(), cb: b.clone().addScaledVector(dir, 17).add(new THREE.Vector3(0, 10, 0)) };
  controls.autoRotate = false; $('#tgOrbit').setAttribute('aria-pressed', 'false');
  allLabels.forEach(L => L.el.classList.toggle('hot', L.el === (beacons.find(x => x.p === o)?.L.el || gauges.find(x => x.g === o)?.L.el || wxOnly.find(x => x.p === o)?.L.el)));
}

// ---------- panels ----------
const EN_DAY = ms => fmtD(ms, 'en-GB', { weekday: 'short' }), FR_DAY = ms => fmtD(ms, 'fr-FR', { weekday: 'short' }).replace('.', '');
const longEN = ms => fmtD(ms, 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).replace(',', '');
const rangeEN = () => {
  const y = { year: 'numeric' }, a = fmtD(FROM, 'en-GB', { weekday: 'long', day: 'numeric', ...(fmtD(FROM, 'en-GB', { month: 'long', year: 'numeric' }) !== fmtD(TO, 'en-GB', { month: 'long', year: 'numeric' }) ? { month: 'long' } : {}) }).replace(',', '');
  return `${a} to ${fmtD(TO, 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', ...y }).replace(',', '')}`;
};
const rangeFR = () => `Du ${fmtD(FROM, 'fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })} au ${fmtD(TO, 'fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`;
const nGauge = GAUGES.length, what = isForecast ? 'forecast' : 'weather';
$('#lede').textContent = `${rangeEN()}, hour by hour: walking conditions at ${SCORED.length} places, ${what} at ${PTS.length} model points${hasFlow ? ` and river flow at ${nGauge}` : ''}. The sun shines from its true position.`;
$('#ledeFr').textContent = `${rangeFR()}, heure par heure : conditions de marche en ${SCORED.length} lieux, ${isForecast ? 'prévision' : 'météo'} en ${PTS.length} points du modèle${hasFlow ? ` et débit de ${nGauge} oueds` : ''}. Le soleil éclaire depuis sa vraie position.`;
if (sourceNote) { $('#notice').textContent = sourceNote; $('#notice').hidden = false; }
document.title = DAYS === 7 ? 'One week in Toubkal National Park' : `${DAYS} days in Toubkal National Park`;
if (DAYS !== 7) { $('#title h1').textContent = `${DAYS} days in Toubkal National Park`; $('#title .sub span').textContent = `${DAYS} jours au parc national de Toubkal`; }
$('#nRel').textContent = S.overture_release;
$('#nData').textContent = DATA.live ? `Data for ${iso(FROM)} to ${iso(TO)}, read from Open-Meteo at ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. Past days are the model archive; days from today on are forecast.`
  : `Showing the saved snapshot for ${iso(FROM)} to ${iso(TO)} (fetched ${DATA.fetched.replace('T', ' ').replace('Z', ' UTC')}).`;
$('#cumSub').innerHTML = `Daylight hours with a walking index of ${GOOD} or more, summed over ${SCORED.length} places<span class="fr">Heures de jour avec un indice de marche d'au moins ${GOOD}, sur ${SCORED.length} lieux</span>`;
$('#cumOf').textContent = `of ${num(TOTAL)} · sur ${num(TOTAL)}`;

const dayBars = $('#dayBars'); dayBars.classList.toggle('dense', DAYS > 10);
const maxDayGood = Math.max(1, ...dayGood);
const dayEls = dayGood.map((v, d) => {
  const el = document.createElement('div'); el.className = 'd'; const ms = FROM + d * DAY;
  el.innerHTML = `<i style="height:${(4 + 50 * v / maxDayGood).toFixed(1)}px"><u></u></i><span>${EN_DAY(ms)}</span><em>${FR_DAY(ms)}</em>`;
  el.title = `${longEN(ms)}: ${v} good hours`; dayBars.appendChild(el);
  return { el, u: el.querySelector('u') };
});

const race = $('#race'); race.style.height = SCORED.length * 25 + 'px';
const raceEls = SCORED.map(p => {
  const li = document.createElement('li');
  li.innerHTML = `<span class="n"></span><i class="bar"></i><span class="nm">${esc(p.name)}</span><span class="v">0</span>`;
  li.addEventListener('click', () => flyTo(p)); race.appendChild(li);
  return { p, li, n: li.querySelector('.n'), v: li.querySelector('.v'), bar: li.querySelector('.bar') };
});
const maxTotal = Math.max(1, ...SCORED.map(p => p.total));

const pHi = PTS.find(p => p.id === 'toubkal'), pLo = PTS.find(p => p.id === 'imlil'), gMain = GAUGES[0];
const flowsEl = $('#flows');
const flowEls = GAUGES.slice(1).map(g => {
  const li = document.createElement('li'); li.innerHTML = `<span>${esc(g.river)}, ${esc(g.place)}</span><b>–</b>`;
  li.addEventListener('click', () => flyTo(g)); flowsEl.appendChild(li); return { g, b: li.querySelector('b') };
});
if (!hasFlow) { const w = $('[data-win="flow"]'); w.querySelector('.body').innerHTML = '<p class="hint">River model not reachable right now.<span class="fr">Modèle de débit indisponible.</span></p>'; }

// charts: drawn once per period, a cursor line moves over them
function canvas2d(cv) {
  const r = cv.getBoundingClientRect(), d = Math.min(devicePixelRatio, 2);
  if (!r.width) return null;
  cv.width = Math.round(r.width * d); cv.height = Math.round(r.height * d);
  const g = cv.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0); return { g, w: r.width, h: r.height };
}
function drawLine(g, a, w, h, lo, hi, color, fill) {
  g.beginPath(); let started = false;
  a.forEach((v, i) => { if (v == null) return; const x = i / (HOURS - 1) * w, y = h - 2 - (v - lo) / (hi - lo || 1) * (h - 5); started ? g.lineTo(x, y) : g.moveTo(x, y); started = true; });
  g.strokeStyle = color; g.lineWidth = 1.5; g.lineJoin = 'round'; g.stroke();
  if (fill) { g.lineTo(w, h); g.lineTo(0, h); g.closePath(); g.fillStyle = fill; g.fill(); }
}
function nightBands(g, w, h) {
  g.fillStyle = 'rgba(159,176,191,.07)';
  for (let i = 0; i < HOURS; i++) if (isDay(i)) g.fillRect(i / HOURS * w, 0, w / HOURS + .5, h);
}
function makeCharts() {
  let c = canvas2d($('#chTemp'));
  if (c) {
    const all = [...pHi.T, ...pLo.T].filter(v => v != null), lo = Math.min(...all, 0), hi = Math.max(...all, 0);
    nightBands(c.g, c.w, c.h);
    const y0 = c.h - 2 - (0 - lo) / (hi - lo || 1) * (c.h - 5);
    c.g.setLineDash([3, 3]); c.g.strokeStyle = 'rgba(159,176,191,.45)'; c.g.beginPath(); c.g.moveTo(0, y0); c.g.lineTo(c.w, y0); c.g.stroke(); c.g.setLineDash([]);
    drawLine(c.g, pLo.T, c.w, c.h, lo, hi, COL.warm); drawLine(c.g, pHi.T, c.w, c.h, lo, hi, COL.cold);
  }
  c = canvas2d($('#chRain'));
  if (c) {
    const mx = Math.max(.5, ...meanRain), bw = Math.max(1, c.w / HOURS - .4);
    meanRain.forEach((v, i) => { if (v <= 0) return; const hgt = Math.max(1, v / mx * (c.h - 3)), x = i / HOURS * c.w, sn = hgt * snowShare[i];
      c.g.fillStyle = COL.water; c.g.fillRect(x, c.h - hgt, bw, hgt - sn); c.g.fillStyle = '#EAF2F8'; c.g.fillRect(x, c.h - sn, bw, sn); });
  }
  c = hasFlow && canvas2d($('#chFlow'));
  if (c) {
    const q = gMain.q.filter(v => v != null), hi = Math.max(...q, (gMain.med || 0) * 1.5, .1);
    drawLine(c.g, gMain.q, c.w, c.h, 0, hi, COL.water, 'rgba(90,176,255,.16)');
    if (gMain.med != null) { const y = c.h - 2 - gMain.med / hi * (c.h - 5); c.g.setLineDash([3, 3]); c.g.strokeStyle = 'rgba(159,176,191,.5)'; c.g.beginPath(); c.g.moveTo(0, y); c.g.lineTo(c.w, y); c.g.stroke(); c.g.setLineDash([]); }
  }
}
// timeline: day blocks with the mean walking index by day and the rain on top
function makeTimeline() {
  const c = canvas2d($('#tl')); if (!c) return;
  const { g, w, h } = c, mx = Math.max(.5, ...meanRain);
  for (let d = 0; d < DAYS; d++) {
    const x = d / DAYS * w, ms = FROM + d * DAY;
    g.fillStyle = 'rgba(159,176,191,.28)'; g.fillRect(x, 0, 1, h);
    if (w / DAYS > 52) { g.fillStyle = '#C6D2DD'; g.font = '11px Inter, system-ui, sans-serif'; g.fillText(`${EN_DAY(ms)} ${fmtD(ms, 'en-GB', { day: 'numeric', month: 'short' })}`, x + 5, 11); }
    else if (w / DAYS > 20 || d % 7 === 0) { g.fillStyle = '#9FB0BF'; g.font = '10px Inter, system-ui, sans-serif'; g.fillText(fmtD(ms, 'en-GB', { day: 'numeric' }), x + 3, 11); }
  }
  for (let i = 0; i < HOURS; i++) {
    const x = i / HOURS * w, bw = w / HOURS + .3;
    if (isDay(i) && meanScore[i] != null) { const s = meanScore[i], hgt = 3 + 13 * s / 100; g.fillStyle = s >= GOOD ? 'rgba(110,231,183,.75)' : s >= FAIR ? 'rgba(255,182,72,.75)' : 'rgba(255,107,107,.8)'; g.fillRect(x, h - hgt, bw, hgt); }
    if (meanRain[i] > 0) { g.fillStyle = 'rgba(90,176,255,.9)'; g.fillRect(x, 19, bw, Math.max(1, 9 * meanRain[i] / mx)); }
  }
}
const cursors = $$('.chart .cur'), tlHead = $('#tlHead');

// what stands out in the period, shown under the clock as the timeline passes it
const beats = [];
{
  const arg = (a, f) => a.reduce((b, v, i) => v != null && (b < 0 || f(v, a[b])) ? i : b, -1);
  let i = arg(pHi.ws, (a, b) => a > b);
  if (i >= 0 && pHi.ws[i] >= 15) beats.push({ h: i, t: `Wind on Toubkal peaks at ${num(pHi.ws[i])} m/s · Vent au sommet : ${num(pHi.ws[i] * 3.6)} km/h` });
  i = arg(pHi.T, (a, b) => a < b);
  if (i >= 0) beats.push({ h: i, t: `Coldest hour on Toubkal: ${deg(pHi.T[i])} · Heure la plus froide` });
  i = arg(meanRain, (a, b) => a > b);
  if (i >= 0 && meanRain[i] >= .3) beats.push({ h: i, t: `Wettest hour: ${num(meanRain[i], 1)} mm on average${snowShare[i] > .5 ? ', mostly as snow' : ''} · Heure la plus arrosée` });
  i = pHi.rr.findIndex((r, k) => r >= .2 && pHi.T[k] != null && pHi.T[k] <= 1);
  if (i >= 0) beats.push({ h: i, t: 'Snow starts on the summit of Toubkal · Il neige au sommet' });
  if (hasFlow && gMain.med) { i = arg(gMain.q, (a, b) => a > b); if (i >= 0 && gMain.q[i] > 1.5 * gMain.med) beats.push({ h: i, t: `Ourika at its highest: ${num(gMain.q[i], 1)} m³/s · Crue de l'Ourika` }); }
}

// ---------- controls ----------
let t = 0, playing = !reduce, speed = 1;
const SPEEDS = [1, 2, 4, .5];
const playBtn = $('#play');
const setPlaying = v => { playing = v; playBtn.textContent = v ? 'Pause' : 'Play'; };
setPlaying(playing);
playBtn.addEventListener('click', () => setPlaying(!playing));
$('#speed').addEventListener('click', e => { speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]; e.currentTarget.textContent = (speed === .5 ? '½' : speed) + '×'; });
addEventListener('keydown', e => {
  if (e.target.matches('input, button, [role="slider"]') && e.code === 'Space') return;
  if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing); }
  if (e.code === 'Escape') { $('#notes').hidden = true; $('#pickerBox').hidden = true; }
});
const tlEl = $('#timeline');
const scrub = e => { const r = tlEl.getBoundingClientRect(); t = clamp((e.clientX - r.left) / r.width) * (HOURS - .01); };
tlEl.addEventListener('pointerdown', e => { tlEl.setPointerCapture(e.pointerId); scrub(e); tlEl.onpointermove = scrub; });
tlEl.addEventListener('pointerup', () => { tlEl.onpointermove = null; });
tlEl.addEventListener('keydown', e => {
  const step = e.shiftKey ? 24 : 1;
  if (e.key === 'ArrowRight') { t = Math.min(HOURS - .01, t + step); e.preventDefault(); }
  if (e.key === 'ArrowLeft') { t = Math.max(0, t - step); e.preventDefault(); }
  if (e.key === ' ') { setPlaying(!playing); e.preventDefault(); }
});
tlEl.setAttribute('aria-valuemax', String(HOURS));

// legend rows switch layers
const hidden = new Set(store.get('hidden', []));
function applyLayers() {
  for (const b of $$('.lay')) {
    const k = b.dataset.layer, on = !hidden.has(k); b.setAttribute('aria-pressed', String(on));
    if (k === 'labels') document.body.classList.toggle('nolabels', !on);
    else if (k === 'snow' || k === 'weather') { if (layers[k]) layers[k].visible = on; }
    else if (layers[k]) layers[k].visible = on;
  }
  beacons.forEach(b => { b.L.el.style.display = ''; b.L.off = hidden.has('beacons'); });
  wxOnly.forEach(b => { b.L.off = hidden.has('weather'); });
  allLabels.forEach(L => { if (L.group) L.off = hidden.has(L.group); });
  beacons.forEach(b => { b.tt.style.display = hidden.has('weather') ? 'none' : ''; if (b.ws) b.ws.parentElement.style.display = hidden.has('weather') ? 'none' : ''; });
}
$$('.lay').forEach(b => b.addEventListener('click', () => { const k = b.dataset.layer; hidden.has(k) ? hidden.delete(k) : hidden.add(k); store.set('hidden', [...hidden]); applyLayers(); }));
applyLayers();

// period picker: presets and a from/to range, applied by reloading with #from=…&to=…
const pickerBox = $('#pickerBox'), periodBtn = $('#period');
const shortRange = (a, b) => {
  const sameM = fmtD(a, 'en-GB', { month: 'short', year: 'numeric' }) === fmtD(b, 'en-GB', { month: 'short', year: 'numeric' });
  return `${fmtD(a, 'en-GB', sameM ? { day: 'numeric' } : { day: 'numeric', month: 'short' })}–${fmtD(b, 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
};
periodBtn.textContent = shortRange(FROM, TO) + ' ▾';
periodBtn.addEventListener('click', () => { pickerBox.hidden = !pickerBox.hidden; periodBtn.setAttribute('aria-expanded', String(!pickerBox.hidden)); });
const dFrom = $('#dFrom'), dTo = $('#dTo');
dFrom.value = iso(FROM); dTo.value = iso(TO);
dFrom.min = dTo.min = iso(today - PAST_DAYS * DAY); dFrom.max = dTo.max = iso(today + AHEAD_DAYS * DAY);
$('#pickHint').textContent = `From ${fmtD(today - PAST_DAYS * DAY, 'en-GB', { day: 'numeric', month: 'short' })} to ${fmtD(today + AHEAD_DAYS * DAY, 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}, up to ${MAX_DAYS} days at a time. Days from today on are forecast. · ${MAX_DAYS} jours au plus ; à partir d'aujourd'hui, prévision.`;
const go = (a, b) => { location.hash = `from=${iso(a)}&to=${iso(b)}`; location.reload(); };
$$('[data-preset]').forEach(b => b.addEventListener('click', () => {
  const p = b.dataset.preset; p === 'next' ? go(today, today + 6 * DAY) : go(today - p * DAY, today - DAY);
}));
$('#apply').addEventListener('click', () => {
  let a = Date.parse(dFrom.value + 'T00:00:00Z'), b = Date.parse(dTo.value + 'T00:00:00Z');
  if (!(a <= b)) return; if ((b - a) / DAY + 1 > MAX_DAYS) b = a + (MAX_DAYS - 1) * DAY; go(a, b);
});

// notes, orbit
const notes = $('#notes');
$('#tgNotes').addEventListener('click', () => { notes.hidden = !notes.hidden; });
$('#tgLegend').addEventListener('click', () => { const w = $('#legend'); w._setMin(!w.classList.contains('is-min')); saveWins(); });
notes.querySelector('.close').addEventListener('click', () => { notes.hidden = true; });
$('#tgOrbit').addEventListener('click', e => { controls.autoRotate = !controls.autoRotate; e.currentTarget.setAttribute('aria-pressed', String(controls.autoRotate)); store.set('orbit', controls.autoRotate); });

// windows: minimise, drag by the header, double-click to send one home (state remembered per viewer)
const wins = $$('.win'), winState = store.get('win', {});
const narrow = innerWidth < 760;
function saveWins() { const o = {}; wins.forEach(w => { o[w.dataset.win] = { min: w.classList.contains('is-min'), x: w.style.left || null, y: w.style.top || null }; }); store.set('win', o); }
wins.forEach(w => {
  const st = winState[w.dataset.win], btn = w.querySelector('.min');
  const setMin = v => { w.classList.toggle('is-min', v); if (w.id === 'legend') $('#tgLegend').setAttribute('aria-expanded', String(!v)); btn.textContent = v ? '+' : '−'; btn.setAttribute('aria-expanded', String(!v)); btn.setAttribute('aria-label', v ? 'Expand' : 'Minimize'); };
  w._setMin = setMin;
  setMin(narrow ? w.dataset.win !== 'score' : st ? st.min : w.dataset.start === 'min' || (w.dataset.win === 'flow' && innerHeight < 800));
  if (st?.x && !narrow) { w.classList.add('moved'); w.style.left = st.x; w.style.top = st.y; }
  btn.addEventListener('click', e => { e.stopPropagation(); setMin(!w.classList.contains('is-min')); saveWins(); requestAnimationFrame(() => { layoutCols(); makeCharts(); }); });
  const ph = w.querySelector('.ph'); if (!ph) return;
  ph.addEventListener('pointerdown', e => {
    if (e.target.closest('button') || narrow) return;
    const r = w.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top; let moved = false;
    ph.setPointerCapture(e.pointerId);
    ph.onpointermove = ev => {
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
      if (!moved) { moved = true; w.style.width = r.width + 'px'; w.classList.add('moved'); }
      w.style.left = clamp(ev.clientX - dx, 0, innerWidth - 80) + 'px'; w.style.top = clamp(ev.clientY - dy, 0, innerHeight - 40) + 'px'; w.style.bottom = 'auto'; w.style.right = 'auto';
    };
    ph.onpointerup = () => { ph.onpointermove = ph.onpointerup = null; if (moved) saveWins(); };
  });
  ph.addEventListener('dblclick', e => { if (e.target.closest('button')) return; homeWin(w); saveWins(); });
});
function homeWin(w) { w.classList.remove('moved'); ['left', 'top', 'bottom', 'right', 'width'].forEach(k => { w.style[k] = ''; }); }
$('#tgReset').addEventListener('click', () => { wins.forEach(w => { homeWin(w); w._setMin(w.dataset.start === 'min'); }); store.del('win'); fly = { t0: performance.now(), a: controls.target.clone(), b: HOME.target.clone(), ca: camera.position.clone(), cb: HOME.pos.clone() }; requestAnimationFrame(() => { layoutCols(); makeCharts(); }); });
$('#tgMin').addEventListener('click', () => { const any = wins.some(w => !w.classList.contains('is-min')); wins.forEach(w => w._setMin(any)); saveWins(); requestAnimationFrame(() => { layoutCols(); makeCharts(); }); });

// the side columns start under the title and the clock, whatever height those take
function layoutCols() {
  const wide = innerWidth >= 760;
  $('.col.left').style.top = wide ? Math.round($('#title').getBoundingClientRect().bottom + 16) + 'px' : '';
  $('.col.right').style.top = wide ? Math.round($('#clock').getBoundingClientRect().bottom + 16) + 'px' : '';
}

// ---------- frame ----------
function resize() {
  const w = innerWidth, h = innerHeight; renderer.setSize(w, h); labelRenderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  const px = renderer.getPixelRatio() * h / 900;
  [flowDots, carDots, hikerDots, sparks, rain, snowP, clouds].forEach(o => { o.obj.material.uniforms.px.value = px; });
  sunDisc.material.uniforms.px.value = renderer.getPixelRatio();
}
addEventListener('resize', resize); resize();
let rsT; addEventListener('resize', () => { clearTimeout(rsT); rsT = setTimeout(() => { layoutCols(); makeCharts(); makeTimeline(); }, 150); });
layoutCols(); makeCharts(); makeTimeline();
document.fonts?.ready.then(() => { layoutCols(); makeCharts(); makeTimeline(); });

const sunCv = $('#sunarc'), sunG = sunCv.getContext('2d');
{ const d = Math.min(devicePixelRatio, 2); sunCv.width = 220 * d; sunCv.height = 46 * d; sunG.setTransform(d, 0, 0, d, 0, 0); }
function drawSunArc(d, hourOfDay) {
  const w = 220, h = 46, y0 = 34, g = sunG; g.clearRect(0, 0, w, h);
  g.strokeStyle = 'rgba(159,176,191,.35)'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, y0 + .5); g.lineTo(w, y0 + .5); g.stroke();
  g.beginPath();
  for (let m = 0; m <= 1440; m += 20) { const e = sunPos(msAt(d * 24 + m / 60), LAT0, LON0)[0], x = m / 1440 * w, y = y0 - e / 70 * 30; m ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.save(); g.beginPath(); g.rect(0, 0, w, y0); g.clip(); g.beginPath();
  for (let m = 0; m <= 1440; m += 20) { const e = sunPos(msAt(d * 24 + m / 60), LAT0, LON0)[0], x = m / 1440 * w, y = y0 - e / 70 * 30; m ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.strokeStyle = '#E8B76A'; g.lineWidth = 1.5; g.stroke(); g.restore();
  const e = sunPos(msAt(d * 24 + hourOfDay), LAT0, LON0)[0], x = hourOfDay / 24 * w, y = y0 - e / 70 * 30;
  g.beginPath(); g.arc(x, clamp(y, 3, h - 3), 3.5, 0, 7); g.fillStyle = e > 0 ? '#FFD98A' : '#51606E'; g.fill();
}

const vA = new THREE.Vector3(), vB = new THREE.Vector3();
function screenAngle(base, lift, toDeg) {       // screen angle of a compass bearing at a point of the scene
  const th = toDeg * rad; vA.copy(base); vA.y += lift; vB.set(vA.x + Math.sin(th) * .8, vA.y, vA.z - Math.cos(th) * .8);
  vA.project(camera); vB.project(camera);
  return Math.atan2(-(vB.y - vA.y) * innerHeight, (vB.x - vA.x) * innerWidth);
}
function snowLine(h) {       // lowest point where the model holds snow, as a height in the scene
  const i = clamp(Math.floor(h), 0, HOURS - 1), pts = [...PTS].sort((a, b) => a.elev - b.elev);
  const k = pts.findIndex(p => (p.sd[i] || 0) >= .02);
  if (k < 0) return null;
  return yOf(k === 0 ? pts[0].elev - 250 : (pts[k].elev + pts[k - 1].elev) / 2);
}

let last = performance.now(), raceT = 0, clutterT = 0, snowY = 99, snowAmt = 0, shownBeat = null;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = clamp((now - last) / 1000, 0, .05); last = now;
  if (playing) { t += dt * RATE * speed; if (t >= HOURS) t = 0; }
  tick(dt, now);
  controls.update();
  renderer.render(scene, camera); labelRenderer.render(scene, camera);
}

function tick(dt, now) {
  const h = Math.min(t, HOURS - .001), hi = Math.floor(h), d = Math.floor(h / 24), hod = h - d * 24, sec = now / 1000;
  const run = playing && !reduce, step = run ? dt * speed : 0;

  // sun and sky
  const [el, az] = sunPos(msAt(h), LAT0, LON0), day = smooth(el, -4, 12), er = el * rad, ar = az * rad;
  sunL.position.set(Math.sin(ar) * Math.cos(er) * 90, Math.max(.5, Math.sin(er) * 90), -Math.cos(ar) * Math.cos(er) * 90);
  sunL.intensity = 3.1 * smooth(el, -1, 8); sunL.color.setHSL(.09, .6, .5 + .4 * smooth(el, 0, 20));
  hemi.intensity = .5 + .4 * day; moonL.intensity = 1.0 * (1 - day);
  scene.background.copy(nightC).lerp(dayC, day); scene.fog.color.copy(scene.background);
  sky.children[0].material.opacity = .85 * (1 - day);
  sunDisc.position.set(Math.sin(ar) * Math.cos(er) * 220, Math.sin(er) * 220, -Math.cos(ar) * Math.cos(er) * 220);
  sunDisc.material.uniforms.o.value = smooth(el, -3, 2);
  renderer.toneMappingExposure = .9 + .35 * day;
  fenceMat.uniforms.t.value = sec;
  if (fly) { const u = Math.min(1, (performance.now() - fly.t0) / 1400), e = u < .5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; controls.target.lerpVectors(fly.a, fly.b, e); camera.position.lerpVectors(fly.ca, fly.cb, e); if (u >= 1) fly = null; }

  // snow on the ground, from the model
  const sl = hidden.has('snow') ? null : snowLine(h);
  snowAmt += ((sl == null ? 0 : 1) - snowAmt) * Math.min(1, dt * 3); if (sl != null) snowY = snowAmt < .05 ? sl : snowY + (sl - snowY) * Math.min(1, dt * 3);
  uSnow.value = snowY; uSnowAmt.value = snowAmt;

  // walking conditions
  const light = isDay(hi);
  for (const b of beacons) {
    const p = b.p, s = hv(p.S, h), st = statusOf(s, light), c = colOf(st), hgt = .35 + 3.4 * (p.dayMean[d] / 100);
    b.beam.scale.set(1, hgt, 1); b.mat.uniforms.c.value.set(c); b.mat.uniforms.o.value = light ? .95 : .35;
    b.L.o.position.y = b.base.y + hgt + b.extra;
    const pulse = light && s != null ? s / 100 : 0;
    b.rings.forEach(r => { const ph = (sec * (.3 + .5 * pulse) + r.userData.ph) % 1, k = .3 + 1.5 * ph * (.4 + pulse); r.scale.set(k, 1, k); r.material.opacity = (1 - ph) * .6 * pulse; r.material.color.set(c); });
    setText(b.sc, s == null ? '–' : String(Math.round(s))); if (b.sc._c !== st) { b.sc._c = st; b.sc.className = 'sc ' + st; }
    if (b.st) setText(b.st, WORD[st]);
    const T = hv(p.T, h); setText(b.tt, deg(T)); const cold = T != null && T < 0; if (b.tt._c !== cold) { b.tt._c = cold; b.tt.classList.toggle('cold', cold); }
    if (b.ws) { const w = hv(p.ws, h); setText(b.ws, w == null ? '' : num(w, w < 10 ? 1 : 0) + ' m/s'); const wd = p.wd[hi]; if (wd != null) b.ar.style.transform = `rotate(${screenAngle(b.base, hgt, wd + 180)}rad)`; }
    b.rects.forEach((r, i) => { const dst = i > d ? 'rgba(159,176,191,.25)' : colOf(statusOf(p.dayMean[i], true)); if (r._f !== dst + (i === d)) { r._f = dst + (i === d); r.setAttribute('fill', dst); r.setAttribute('opacity', i === d ? 1 : i < d ? .5 : 1); } });
    if (run && light && s != null) { b.acc += s / 100 * dt * speed * 9; while (b.acc >= 1) { b.acc -= 1; const th = Math.random() * 6.283, rr = Math.random() * .25; sparks.emit(b.base.x + Math.cos(th) * rr, b.base.y + .05, b.base.z + Math.sin(th) * rr, (Math.random() - .5) * .15, .55 + Math.random() * .6, (Math.random() - .5) * .15, 2.2 + Math.random(), -99); } }
  }
  sparks.step(run ? dt : 0);

  // weather: pills, rain, snow and cloud over every model point
  for (const c of wxOnly) {
    const p = c.p, T = hv(p.T, h), w = hv(p.ws, h); setText(c.tt, deg(T)); setText(c.ws, w == null ? '' : num(w, w < 10 ? 1 : 0) + ' m/s');
    const wd = p.wd[hi]; if (wd != null) c.ar.style.transform = `rotate(${screenAngle(c.base, 1.3, wd + 180)}rad)`;
  }
  if (run) for (const p of PTS) {
    const r = p.rr[hi] || 0, cc = p.cc[hi] || 0; if (r <= 0 && cc < 85) continue;
    const base = p._b || (p._b = V(p.x, p.y));
    if (Math.random() < (r > 0 ? Math.min(1, .25 + r) : .08) * step * 9) { const th = Math.random() * 6.283, q = Math.sqrt(Math.random()) * 3; clouds.emit(base.x + Math.cos(th) * q, base.y + 2.3 + Math.random() * .7, base.z + Math.sin(th) * q, .08, 0, .03, 5, -99); }
    if (r <= 0) continue;
    const isSnow = (p.T[hi] ?? 3) <= 1, n = Math.min(30, r * 55 * step * (isSnow ? 1.2 : 1)), nn = Math.floor(n) + (Math.random() < n % 1 ? 1 : 0);
    for (let k = 0; k < nn; k++) {
      const th = Math.random() * 6.283, q = Math.sqrt(Math.random()) * 3.1, x = base.x + Math.cos(th) * q, z = base.z + Math.sin(th) * q, top = base.y + 2.1 + Math.random() * 1.1;
      isSnow ? snowP.emit(x, top, z, .05, -.6 - Math.random() * .25, 0, 7, base.y - .3) : rain.emit(x, top, z, .05, -3.3 - Math.random(), 0, 2, base.y - .3);
    }
  }
  rain.step(run ? dt * speed : 0); snowP.step(run ? dt * speed : 0); clouds.step(run ? dt * speed : 0);

  // rivers
  let rel = .5;
  for (const k of gauges) {
    const q = hv(k.g.q, h), r = q == null || !k.g.med ? 0 : q / k.g.med;
    setText(k.q, q == null ? '–' : num(q, q < 10 ? 1 : 0) + ' m³/s');
    const ph = (sec * .6) % 1, s = .3 + 1.2 * ph * Math.min(2.2, r); k.ring.scale.set(s, 1, s); k.ring.material.opacity = (1 - ph) * .55 * Math.min(1.4, r);
    k.lvl.visible = q != null; k.lvl.position.y = .05 + .8 * Math.min(1, r / 2);
    if (k.g === gMain && q != null) rel = clamp(r / 2, .2, 1);
  }
  flowDots.step(step, .9 + 1.6 * rel, () => rel, dt);
  carDots.step(step, 2.2, () => .25 + .6 * day, dt);
  hikerDots.step(step, .55, k => { const pts = routePts[k]; let s = 0; pts.forEach(p => { s += (p.S[hi] ?? 0); }); return light ? clamp(s / pts.length / 100) * smooth(el, 0, 10) : 0; }, dt);

  // clock
  const ms = FROM + d * DAY, hh = Math.floor(hod), mm = Math.floor((hod - hh) * 60 / 10) * 10, tm = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  setText($('#cDay'), fmtD(ms, 'en-GB', { weekday: 'long' })); setText($('#cDate'), fmtD(ms, 'en-GB', { day: 'numeric', month: 'short' }));
  setText($('#cDateFr'), fmtD(ms, 'fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }));
  const phase = el > 6 ? 'day · jour' : el > -6 ? (hod < 12 ? 'dawn · aube' : 'dusk · crépuscule') : 'night · nuit';
  setText($('#cTime'), `${tm} · ${phase}${ms >= today ? ' · forecast · prévision' : ''}`);
  const sn = sunTimes[d], len = sn.rise != null && sn.set != null ? sn.set - sn.rise : null, e0 = Math.round(el);
  setText($('#cSun'), `sunrise ${hm(sn.rise)}, sunset ${hm(sn.set)}, daylight ${len == null ? '–' : hm(len) + ' h'}, sun now ${num(e0)}°`);
  setText($('#cSunFr'), `lever ${hm(sn.rise)}, coucher ${hm(sn.set)}, jour ${len == null ? '–' : hm(len) + ' h'}, soleil ${num(e0)}°`);
  drawSunArc(d, hod);
  const bt = beats.reduce((b, x) => Math.abs(x.h - h) < 5 && (!b || Math.abs(x.h - h) < Math.abs(b.h - h)) ? x : b, null);
  if (bt !== shownBeat) { shownBeat = bt; const be = $('#beat'); be.hidden = !bt; if (bt) { be.textContent = bt.t; be.style.animation = 'none'; void be.offsetWidth; be.style.animation = ''; } }

  // panels
  const frac = h - hi; let cum = 0;
  SCORED.forEach(p => { p.now = p.cum[hi] + p.good[hi] * frac; cum += p.now; });
  setText($('#cum'), num(Math.round(cum)));
  dayEls.forEach((x, i) => { const k = i < d ? 1 : i > d ? 0 : (() => { let g = 0, n = 0; SCORED.forEach(p => { n += p.dayGood[i]; for (let j = i * 24; j < hi; j++) g += p.good[j]; g += p.good[hi] * frac; }); return n ? g / n : 0; })(); const s = (k * 100).toFixed(0) + '%'; if (x.u._h !== s) { x.u._h = s; x.u.style.height = s; } if (x.el._n !== (i === d)) { x.el._n = i === d; x.el.classList.toggle('now', i === d); } });
  if (now - raceT > 300) {
    raceT = now;
    const order = [...raceEls].sort((a, b) => b.p.now - a.p.now || b.p.total - a.p.total);
    order.forEach((r, i) => { const y = `translateY(${i * 25}px)`; if (r.li._y !== y) { r.li._y = y; r.li.style.transform = y; } setText(r.n, String(i + 1)); setText(r.v, num(Math.round(r.p.now)) + ' h'); const w = `calc(${(r.p.now / maxTotal * 100).toFixed(1)}% - 26px)`; if (r.bar._w !== w) { r.bar._w = w; r.bar.style.width = `max(0px, ${w})`; } });
  }
  setText($('#tHi'), pHi.T ? num(hv(pHi.T, h) ?? 0, 1) + '°' : '–'); setText($('#tLo'), num(hv(pLo.T, h) ?? 0, 1) + '°');
  const fz = hv(meanFrz, h); setText($('#frz'), fz == null ? '–' : num(Math.round(fz / 10) * 10) + ' m');
  if (hasFlow) { const q = hv(gMain.q, h); setText($('#qMain'), q == null ? '–' : num(q, q < 10 ? 1 : 0)); flowEls.forEach(f => { const v = hv(f.g.q, h); setText(f.b, v == null ? '–' : num(v, 2)); }); }
  const pc = (h / HOURS * 100).toFixed(3) + '%'; cursors.forEach(c => { c.style.left = pc; }); tlHead.style.left = pc;
  if (tlEl._v !== hi) { tlEl._v = hi; tlEl.setAttribute('aria-valuenow', String(hi)); tlEl.setAttribute('aria-valuetext', `${fmtD(ms, 'en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}, ${tm}`); }

  // north arrow, scale bar and label clutter
  if (now - clutterT > 240) {
    clutterT = now;
    $('#needle').setAttribute('transform', `rotate(${90 - screenAngle(controls.target, 0, 0) / rad})`);
    const dist = camera.position.distanceTo(controls.target), pxPerKm = innerHeight / (2 * Math.tan(camera.fov * rad / 2) * dist);
    const nice = [.5, 1, 2, 5, 10, 20, 50].find(k => k * pxPerKm >= 46) || 50;
    $('#scale i').style.width = (nice * pxPerKm).toFixed(0) + 'px'; setText($('#scale span'), nice + ' km');
    declutter();
  }
}

// hide the labels that would sit on top of a more important one
function declutter() {
  if (hidden.has('labels')) return;
  const kept = [$('#title'), $('#clock')].map(e => e.getBoundingClientRect());
  for (const L of [...allLabels].sort((a, b) => b.prio - a.prio)) {
    if (L.off || L.el.style.display === 'none') { L.el.classList.add('hide'); continue; }
    const r = L.el.getBoundingClientRect();
    const clash = r.width === 0 || kept.some(k => r.left < k.right + 4 && r.right > k.left - 4 && r.top < k.bottom + 3 && r.bottom > k.top - 3);
    L.el.classList.toggle('hide', clash); if (!clash) kept.push(r);
  }
}

tick(0, performance.now());
started = true;
$('#loading').classList.add('done');
requestAnimationFrame(frame);
window.__tbk = { seek: h => { t = clamp(h, 0, HOURS - .01); }, play: setPlaying, get t() { return t; }, HOURS, camera, controls, live: DATA.live };
