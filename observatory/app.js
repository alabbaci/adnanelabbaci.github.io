/* Dakhla Urban Observatory — guided 3D presentation of city indicators.
 *
 * Static site: no build step, no server, no API keys. Every layer of the 3D
 * scene (land, streets, buildings, zones, vegetation) is drawn from files in
 * this repository, so the Simulation view needs no basemap service at all.
 * The Map view adds a raster basemap under the same zones.
 */

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, html = '') => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k === 'class' ? (n.className = v) : n.setAttribute(k, v);
  n.innerHTML = html;
  return n;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const getJSON = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); };
const int = (v) => Math.round(v).toLocaleString('en');
const dec = (d) => (v) => Number(v).toLocaleString('en', { minimumFractionDigits: d, maximumFractionDigits: d });
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

const WARM = ['#f6e3c5', '#f2c08d', '#ea9560', '#d96a46', '#b3433c', '#7d2439'];
const VIOLET = ['#ece4f5', '#cfbde6', '#ad92d3', '#8a67bd', '#683f9f', '#45217a'];
const BLUE = ['#e2eef5', '#b5d5e6', '#82b7d6', '#4f94c1', '#2c6ea3', '#174a7c'];
const GREEN = ['#eef2d5', '#cfdf9f', '#a3c773', '#73a955', '#45853f', '#235e33'];
const SCENE = { water: '#2b2440', land: '#8f8873', road: '#b9a8cc', green: '#6f9d5b', bldLow: '#c8643c', bldHigh: '#f6b98a' };
const HEIGHT_X = 3;      // buildings are low; stretch them so the skyline reads

/* Each indicator reads one property per zone. `years` marks a real time series. */
const INDICATORS = [
  { id: 'population', label: 'Population', short: 'Population', unit: 'people', fmt: int, ramp: WARM, year: 2024,
    value: (p) => p.population, city: (c) => c.city_values.population,
    note: 'Modelled. The 2024 census total for the city, shared out by residential building volume.',
    how: 'RGPH 2024 city total (161,723), distributed across zones in proportion to residential building volume.' },
  { id: 'density', label: 'Population density', short: 'Density', unit: 'people per km²', fmt: int, ramp: WARM, year: 2024,
    value: (p) => p.density, city: (c) => c.city_values.density,
    note: 'Modelled population divided by the area of the zone.',
    how: 'Modelled population divided by zone area.' },
  { id: 'built', label: 'Built-up land', short: 'Built-up', unit: '% of the zone under roofs', fmt: dec(1), suffix: '%', ramp: VIOLET, year: 2026,
    value: (p) => p.built_share, city: (c) => c.city_values.built_share,
    note: 'Area of building footprints as a share of the zone. Overture Maps, 2026 release.',
    how: 'Building footprint area over zone area (Overture Maps buildings).' },
  { id: 'streets', label: 'Street density', short: 'Streets', unit: 'km of street per km²', fmt: dec(1), ramp: BLUE, year: 2026,
    value: (p) => p.street_density, city: (c) => c.city_values.street_density,
    note: 'Length of mapped streets inside the zone, per square kilometre. Overture Maps, 2026 release.',
    how: 'Length of Overture Maps road segments inside the zone, per km².' },
  { id: 'veg', label: 'Vegetation cover', short: 'Vegetation', unit: '% of the zone', fmt: dec(2), suffix: '%', ramp: GREEN, years: true,
    value: (p, y) => p[`veg_${y}`], city: (c, y) => c.vegetation[y].share,
    note: 'Measured. Share of 10 m Sentinel-2 pixels whose spring NDVI reaches 0.20.',
    how: 'Sentinel-2 L2A, every March–May scene of each year: cloud-masked NDVI, per-pixel median, vegetated where NDVI ≥ 0.20.' },
  { id: 'green_pc', label: 'Vegetation per person', short: 'Green / person', unit: 'm² per person', fmt: dec(1), ramp: GREEN, year: 2024,
    value: (p) => (p.population ? p.veg_m2_2024 / p.population : 0), city: (c) => c.city_values.green_per_capita,
    note: 'Vegetated area in spring 2024 divided by the modelled 2024 population.',
    how: 'Vegetated area (Sentinel-2, spring 2024) divided by modelled population.' },
];

const state = {
  city: null, zones: null, ind: null, year: null, mode: 'sim',
  selected: null, playing: null, breaks: [], labels: [],
  tour: { on: true, i: 0, paused: false, t0: 0, elapsed: 0, flying: false },
};

/* ------------------------------------------------------------------- map */
const empty = { type: 'FeatureCollection', features: [] };
const style = {
  version: 8,
  sources: {
    basemap: { type: 'raster', tiles: ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png`), tileSize: 256, maxzoom: 19, attribution: '© <a href="https://carto.com/attributions">CARTO</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
    ...Object.fromEntries(['land', 'roads', 'green', 'zones', 'buildings'].map((k) => [k, { type: 'geojson', data: empty, promoteId: k === 'zones' ? 'id' : undefined }])),
  },
  layers: [
    { id: 'water', type: 'background', paint: { 'background-color': SCENE.water } },
    { id: 'basemap', type: 'raster', source: 'basemap', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.95 } },
    { id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': SCENE.land, 'fill-antialias': true } },
    { id: 'land-edge', type: 'line', source: 'land', paint: { 'line-color': '#d8c9b0', 'line-width': 1, 'line-opacity': 0.35 } },
    { id: 'zones-fill', type: 'fill', source: 'zones', paint: { 'fill-color': '#8f8873', 'fill-opacity': 0, 'fill-color-transition': { duration: 700 }, 'fill-opacity-transition': { duration: 700 } } },
    { id: 'green', type: 'fill', source: 'green', filter: ['==', ['get', 'year'], 0], paint: { 'fill-color': SCENE.green, 'fill-opacity': 0.9 } },
    { id: 'roads', type: 'line', source: 'roads', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': SCENE.road, 'line-opacity': ['match', ['get', 'class'], ['residential', 'unclassified'], 0.45, 0.85], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, ['match', ['get', 'class'], ['trunk', 'primary'], 1.2, 'secondary', 0.9, 0.3], 15, ['match', ['get', 'class'], ['trunk', 'primary'], 5, 'secondary', 4, 'tertiary', 3, 1.6]] } },
    { id: 'zones-line', type: 'line', source: 'zones', paint: { 'line-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#f3b27a', '#ffffff'], 'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 3, ['boolean', ['feature-state', 'hover'], false], 2, 0.8], 'line-opacity': 0, 'line-opacity-transition': { duration: 700 } } },
    { id: 'buildings', type: 'fill-extrusion', source: 'buildings', paint: { 'fill-extrusion-color': SCENE.bldLow, 'fill-extrusion-height': 0, 'fill-extrusion-opacity': 0.96, 'fill-extrusion-vertical-gradient': true, 'fill-extrusion-color-transition': { duration: 700 } } },
  ],
};
const map = new maplibregl.Map({
  container: 'map', style, center: [-15.93, 23.71], zoom: 10.6, pitch: 62, bearing: 24, maxPitch: 78, minZoom: 9, maxZoom: 17.5,
  attributionControl: { compact: true }, canvasContextAttributes: { antialias: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
window.__map = map; window.__state = state;

/* ------------------------------------------------------------ geometry */
const rings = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.coordinates);
function inside(pt, geom) {
  for (const poly of rings(geom)) {
    let hit = false;
    const ring = poly[0];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) hit = !hit;
    }
    if (hit) return true;
  }
  return false;
}
function centre(geom) {
  const ring = rings(geom).map((p) => p[0]).sort((a, b) => b.length - a.length)[0];
  let x = 0, y = 0;
  for (const c of ring) { x += c[0]; y += c[1]; }
  return [x / ring.length, y / ring.length];
}
function bounds(geom) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of rings(geom)) for (const c of poly[0]) { b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]); b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]); }
  return [[b[0], b[1]], [b[2], b[3]]];
}

/* --------------------------------------------------------------- values */
const yearsOf = (ind) => (ind.years ? state.city.years : [ind.year]);
const valueOf = (f, ind = state.ind, year = state.year) => ind.value(f.properties, year);
const show = (ind, v) => `${ind.fmt(v)}${ind.suffix || ''}`;
function computeBreaks(ind) {
  const all = [];
  for (const y of yearsOf(ind)) for (const f of state.zones.features) all.push(ind.value(f.properties, y));
  all.sort((a, b) => a - b);
  const q = (p) => all[Math.min(all.length - 1, Math.floor(p * all.length))];
  const n = ind.ramp.length;
  return [all[0], ...Array.from({ length: n - 1 }, (_, i) => q((i + 1) / n)), all[all.length - 1]];
}
const classOf = (v) => { const b = state.breaks; let k = 0; for (let i = 1; i < b.length - 1; i++) if (v >= b[i]) k = i; return k; };
const colourOf = (f) => state.ind.ramp[classOf(valueOf(f))];
const padding = () => (innerWidth > 980 ? { top: 80, bottom: 110, left: 350, right: 330 } : { top: 70, bottom: 100, left: 16, right: 16 });

/* --------------------------------------------------------------- render */
function paint() {
  const ind = state.ind;
  if (!ind) {     // intro: the city in its own colours
    map.setPaintProperty('zones-fill', 'fill-opacity', 0);
    map.setPaintProperty('zones-line', 'line-opacity', 0);
    map.setPaintProperty('buildings', 'fill-extrusion-color', ['interpolate', ['linear'], ['get', 'calculated_height'], 3, SCENE.bldLow, 9, '#e38a5c', 22, SCENE.bldHigh]);
    map.setFilter('green', ['==', ['get', 'year'], state.city.years[state.city.years.length - 1]]);
    return;
  }
  const match = ['match', ['get', 'id']], bmatch = ['match', ['get', 'zone']];
  for (const f of state.zones.features) { const c = colourOf(f); match.push(f.properties.id, c); bmatch.push(f.properties.id, c); }
  match.push('#8f8873'); bmatch.push('#b9aa9a');
  const sim = state.mode === 'sim';
  map.setPaintProperty('zones-fill', 'fill-color', match);
  map.setPaintProperty('zones-fill', 'fill-opacity', sim ? 0.62 : 0.74);
  map.setPaintProperty('zones-line', 'line-opacity', 0.75);
  map.setPaintProperty('buildings', 'fill-extrusion-color', bmatch);
  const vegYear = ind.years ? state.year : ind.id === 'green_pc' ? 2024 : 0;
  map.setFilter('green', ['==', ['get', 'year'], vegYear]);
}

function renderIndicator() {
  const ind = state.ind || INDICATORS[0], c = state.city, feats = state.zones.features;
  const top = [...feats].sort((a, b) => valueOf(b, ind) - valueOf(a, ind))[0];
  $('#ind-title').textContent = ind.label;
  $('#ind-top').innerHTML = `Highest: <b>${esc(top.properties.name)}</b> — ${show(ind, valueOf(top, ind))} ${ind.suffix ? ind.unit.replace(/^% /, '') : ind.unit}`;
  $('#ind-city').textContent = `${show(ind, ind.city(c, state.year))}${ind.suffix ? '' : ` ${ind.unit}`}`;
  $('#ind-note').textContent = ind.note;
  $('#scope').textContent = `Dakhla · ${feats.length} zones`;
  const b = state.breaks;
  $('#legend').innerHTML = `<div class="ramp">${ind.ramp.map((col) => `<i style="background:${col}"></i>`).join('')}</div><div class="ticks">${b.map((v) => `<span>${ind.fmt(v)}</span>`).join('')}</div>`;
  const ys = yearsOf(ind), sel = $('#year-select');
  sel.innerHTML = ys.map((y) => `<option${y === state.year ? ' selected' : ''}>${y}</option>`).join('');
  sel.disabled = ys.length < 2;
  $('#chips').innerHTML = '';
  for (const i of INDICATORS) {
    const chip = el('button', { class: `chip${i === ind ? ' on' : ''}`, role: 'tab', 'aria-selected': i === ind }, `${i.short}${i.years ? `<small>${c.years[0]}–${String(c.years[c.years.length - 1]).slice(2)}</small>` : ''}`);
    chip.onclick = () => setIndicator(i.id);
    $('#chips').append(chip);
  }
  $('#years').innerHTML = '';
  for (const y of c.years) {
    const bt = el('button', { class: y === state.year ? 'on' : '', role: 'tab' }, y);
    bt.disabled = !ys.includes(y);
    if (bt.disabled) bt.title = `${ind.label} is a single snapshot (${ind.year})`;
    bt.onclick = () => { stopPlay(); setYear(y); };
    $('#years').append(bt);
  }
  $('#btn-play').disabled = ys.length < 2;
  $('#btn-play').title = ys.length < 2 ? 'Only vegetation has a year-by-year record' : 'Play the years';
  $('#stage-year').textContent = state.ind ? state.year : '';
}

function renderRank() {
  const ind = state.ind || INDICATORS[0], feats = state.zones.features, ol = $('#rank');
  const order = [...feats].sort((a, b) => valueOf(b, ind) - valueOf(a, ind));
  const max = Math.max(...order.map((f) => valueOf(f, ind))) || 1;
  $('#rank-sub').textContent = `${ind.label} · ${state.year}`;
  if (ol.children.length !== feats.length) {
    ol.innerHTML = '';
    for (const f of feats) {
      const li = el('li', { 'data-id': f.properties.id }, `<button><i class="fill"></i><span class="n"></span><span class="name">${esc(f.properties.name)}</span><span class="v"></span></button>`);
      li.firstChild.onclick = () => select(f.properties.id, true);
      li.firstChild.onmouseenter = () => hover(f.properties.id);
      li.firstChild.onmouseleave = () => hover(null);
      ol.append(li);
    }
    ol.style.height = `${feats.length * 30}px`;
  }
  order.forEach((f, i) => {
    const li = ol.querySelector(`[data-id="${f.properties.id}"]`), v = valueOf(f, ind);
    li.style.transform = `translateY(${i * 30}px)`;
    li.classList.toggle('sel', f.properties.id === state.selected);
    li.querySelector('.n').textContent = i + 1;
    li.querySelector('.v').textContent = show(ind, v);
    const fill = li.querySelector('.fill');
    fill.style.width = `${Math.max(2, (100 * v) / max)}%`;
    fill.style.background = ind.ramp[classOf(v)];
  });
}

function renderZone() {
  const card = $('#zone-card'), f = state.zones.features.find((x) => x.properties.id === state.selected);
  if (!f || state.tour.on) { card.hidden = true; return; }
  const p = f.properties, c = state.city, ys = c.years;
  card.hidden = false;
  card.innerHTML = `<button class="x" aria-label="Close">×</button><h4>${esc(p.name)}</h4>
    <p class="where">${p.position === 'centre' ? 'At the centre of the built city' : `${p.km_from_centre} km ${p.position} of the centre`} · ${dec(2)(p.area_km2)} km² · ${int(p.buildings)} footprints</p>
    <dl>${INDICATORS.map((i) => { const y = i.years ? state.year : i.year; return `<dt>${i.label}${i.years ? ` ${y}` : ''}</dt><dd>${show(i, i.value(p, y))}</dd>`; }).join('')}</dl>
    <canvas id="spark" height="62"></canvas><p class="cap">Vegetation cover, ${ys[0]}–${ys[ys.length - 1]} (%). Dashed: city.</p>`;
  card.querySelector('.x').onclick = () => select(null);
  spark($('#spark'), ys, ys.map((y) => p[`veg_${y}`]), ys.map((y) => c.vegetation[y].share), ys.indexOf(state.year));
}
function spark(canvas, xs, a, b, mark) {
  const dpr = devicePixelRatio || 1, w = canvas.clientWidth || 268, h = 62;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const max = Math.max(...a, ...b, 0.1) * 1.15, pad = { l: 4, r: 30, t: 6, b: 14 };
  const x = (i) => pad.l + ((w - pad.l - pad.r) * i) / (xs.length - 1), y = (v) => pad.t + (h - pad.t - pad.b) * (1 - v / max);
  const line = (vals, col, dash) => { g.strokeStyle = col; g.lineWidth = 1.8; g.setLineDash(dash); g.beginPath(); vals.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)))); g.stroke(); g.setLineDash([]); };
  line(b, 'rgba(246,241,234,0.4)', [3, 3]); line(a, '#8fc46f', []);
  g.font = '10px ui-monospace, Menlo, monospace'; g.fillStyle = '#9a8fa6'; g.textBaseline = 'alphabetic';
  g.textAlign = 'left'; g.fillText(xs[0], pad.l, h - 2); g.textAlign = 'right'; g.fillText(xs[xs.length - 1], w - pad.r, h - 2);
  g.textAlign = 'left'; g.fillStyle = '#8fc46f'; g.fillText(dec(1)(a[a.length - 1]), w - pad.r + 4, y(a[a.length - 1]) + 3);
  if (mark >= 0) { g.fillStyle = '#f6f1ea'; g.beginPath(); g.arc(x(mark), y(a[mark]), 3, 0, 7); g.fill(); }
}

function refresh() { paint(); renderIndicator(); renderRank(); renderZone(); }
function setIndicator(id, year) {
  const ind = INDICATORS.find((i) => i.id === id) || null;
  if (ind !== state.ind) stopPlay();
  state.ind = ind;
  const use = ind || INDICATORS[0], ys = yearsOf(use);
  state.year = year && ys.includes(year) ? year : ys[ys.length - 1];
  state.breaks = computeBreaks(use);
  refresh();
}
function setYear(y) { state.year = y; refresh(); }
function stopPlay() { clearInterval(state.playing); state.playing = null; $('#btn-play').textContent = '▶'; }
function play(loop = false) {
  const ys = yearsOf(state.ind || INDICATORS[0]);
  if (ys.length < 2) return;
  stopPlay();
  $('#btn-play').textContent = '❚❚';
  let i = state.year === ys[ys.length - 1] ? -1 : ys.indexOf(state.year);
  const step = () => {
    i += 1;
    if (i >= ys.length) { if (!loop) return stopPlay(); i = 0; }
    setYear(ys[i]);
  };
  step();
  state.playing = setInterval(step, 1500);
}

/* --------------------------------------------------------- interactions */
let hovered = null;
function hover(id) {
  if (id === hovered) return;
  if (hovered) map.setFeatureState({ source: 'zones', id: hovered }, { hover: false });
  if (id) map.setFeatureState({ source: 'zones', id }, { hover: true });
  hovered = id;
}
function select(id, fly) {
  if (state.selected) map.setFeatureState({ source: 'zones', id: state.selected }, { selected: false });
  state.selected = id === state.selected && !fly ? null : id;
  if (state.selected) {
    map.setFeatureState({ source: 'zones', id: state.selected }, { selected: true });
    if (fly) map.fitBounds(bounds(state.zones.features.find((f) => f.properties.id === id).geometry), { padding: 30, maxZoom: 14.6, pitch: map.getPitch(), bearing: map.getBearing(), duration: 1400 });
  }
  renderRank(); renderZone();
}
map.on('mousemove', 'zones-fill', (e) => {
  if (state.tour.on || !state.ind) return;
  const f = e.features[0], z = state.zones.features.find((x) => x.properties.id === f.id);
  hover(f.id);
  map.getCanvas().style.cursor = 'pointer';
  const tip = $('#tip');
  tip.hidden = false; tip.style.left = `${e.point.x}px`; tip.style.top = `${e.point.y}px`;
  tip.innerHTML = `<b>${esc(z.properties.name)}</b><span>${show(state.ind, valueOf(z))} ${state.ind.suffix ? '' : state.ind.unit}</span>`;
});
map.on('mouseleave', 'zones-fill', () => { hover(null); $('#tip').hidden = true; map.getCanvas().style.cursor = ''; });
map.on('click', 'zones-fill', (e) => { if (!state.tour.on && state.ind) select(e.features[0].id); });
map.on('zoom', () => document.body.classList.toggle('far', map.getZoom() < 11.6));

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  const sim = mode === 'sim';
  map.setLayoutProperty('basemap', 'visibility', sim ? 'none' : 'visible');
  for (const id of ['land', 'land-edge']) map.setLayoutProperty(id, 'visibility', sim ? 'visible' : 'none');
  map.setPaintProperty('roads', 'line-opacity', sim ? ['match', ['get', 'class'], ['residential', 'unclassified'], 0.45, 0.85] : 0);
  raise(sim ? HEIGHT_X : 0, 900);
  map.easeTo(sim ? { pitch: 58, bearing: 24, duration: 1200 } : { pitch: 0, bearing: 0, duration: 1200 });
  paint();
}
let raiseRaf;
function raise(to, ms) {
  cancelAnimationFrame(raiseRaf);
  const from = raise.k ?? 0, t0 = performance.now();
  const tick = (t) => {
    const u = reduced ? 1 : Math.min(1, (t - t0) / ms);
    raise.k = from + (to - from) * ease(u);
    map.setPaintProperty('buildings', 'fill-extrusion-height', ['*', ['get', 'calculated_height'], raise.k]);
    if (u < 1) raiseRaf = requestAnimationFrame(tick);
  };
  raiseRaf = requestAnimationFrame(tick);
}

/* ----------------------------------------------------------------- tour */
function countUp(node, to, fmt = int, ms = 1400) {
  if (reduced) { node.textContent = fmt(to); return; }
  const t0 = performance.now();
  const tick = (t) => { const u = Math.min(1, (t - t0) / ms); node.textContent = fmt(to * ease(u)); if (u < 1) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}
const topOf = (id, y) => { const i = INDICATORS.find((x) => x.id === id); return [...state.zones.features].sort((a, b) => i.value(b.properties, y) - i.value(a.properties, y)); };
function scenes() {
  const c = state.city, z = state.zones.features, ys = c.years, y0 = ys[0], y1 = ys[ys.length - 1];
  const pop = topOf('population'), den = topOf('density'), built = topOf('built'), str = topOf('streets'), veg = topOf('veg', y1);
  const share3 = (100 * (pop[0].properties.population + pop[1].properties.population + pop[2].properties.population)) / c.population;
  const sparse = z.filter((f) => f.properties.density < 1000).length;
  const v0 = c.vegetation[y0], v1 = c.vegetation[y1];
  const C = c.centre;
  return [
    { ms: 10000, ind: null, cls: '', cam: { center: [C[0] + 0.03, C[1] + 0.03], zoom: 10.9, pitch: 64, bearing: 28 },
      kicker: 'Urban Observatory', title: 'Dakhla', lede: `A city on a sand spit, between the open Atlantic and its lagoon. This is what open data can say about it, zone by zone, from ${y0} to ${y1}.`,
      stats: [[z.length, 'analysis zones'], [c.population, `people · ${c.population_year} census`], [c.buildings, 'building footprints']] },
    { ms: 9500, ind: 'population', cls: 'show-ind show-rank', cam: { center: C, zoom: 12.5, pitch: 56, bearing: -18 },
      kicker: 'Population · 2024', title: 'Where people live', lede: `Three zones hold <b>${dec(0)(share3)}%</b> of the city: ${pop.slice(0, 3).map((f) => esc(f.properties.id)).join(', ')}. The largest, <b>${esc(pop[0].properties.name)}</b>, is home to about ${int(pop[0].properties.population)} people. Modelled from the census total and building volume.` },
    { ms: 9500, ind: 'density', cls: 'show-ind show-rank', cam: { center: [C[0] + 0.004, C[1] - 0.004], zoom: 13.3, pitch: 62, bearing: 40 },
      kicker: 'Population density · 2024', title: 'A dense core, an open edge', lede: `<b>${esc(den[0].properties.name)}</b> reaches ${int(den[0].properties.density)} people per km², against ${int(c.city_values.density)} for the city. ${sparse} of the ${z.length} zones stay under 1,000.` },
    { ms: 9500, ind: 'built', cls: 'show-ind show-rank', cam: { center: [C[0] - 0.006, C[1] + 0.002], zoom: 13.6, pitch: 66, bearing: 110 },
      kicker: 'Built-up land', title: `Roofs cover ${dec(1)(c.city_values.built_share)}% of the city`, lede: `In <b>${esc(built[0].properties.name)}</b> it is ${dec(1)(built[0].properties.built_share)}%. Most zones are still mostly open ground: sand, plots and wide streets.` },
    { ms: 9500, ind: 'streets', cls: 'show-ind show-rank', cam: { center: [C[0] + 0.012, C[1] + 0.02], zoom: 12.4, pitch: 50, bearing: 190 },
      kicker: 'Street density', title: 'Where the grid is drawn', lede: `<b>${esc(str[0].properties.name)}</b> has ${dec(1)(str[0].properties.street_density)} km of street per km². The city averages ${dec(1)(c.city_values.street_density)}, and the outer zones are a single road through open land.` },
    { ms: 15000, ind: 'veg', year: y0, play: true, cls: 'show-ind show-rank show-dock', cam: { center: [C[0] - 0.02, C[1] - 0.025], zoom: 12.2, pitch: 52, bearing: 300 },
      kicker: `Vegetation cover · ${y0} — ${y1}`, title: `${ys.length} springs, seen from space`, lede: `Sentinel-2 finds vegetation on <b>${dec(2)(v0.share)}%</b> of the city in ${y0} and <b>${dec(2)(v1.share)}%</b> in ${y1}: ${dec(1)(v1.m2 / 1e4)} hectares. Most of it sits in one zone, <b>${esc(veg[0].properties.name)}</b>, where ${dec(0)(veg[0].properties[`veg_${y1}`])}% of the ground is green.` },
    { ms: 9000, ind: 'density', cls: '', cam: { center: [C[0] + 0.02, C[1] + 0.02], zoom: 11.4, pitch: 60, bearing: 20 },
      kicker: 'Your turn', title: 'Explore the city', lede: 'Pick an indicator, step through the years, click a zone. Population is modelled and vegetation is measured; the Method button says how each number is made.',
      stats: [[INDICATORS.length, 'indicators'], [ys.length, 'years of imagery'], [Object.values(c.sentinel.scenes_used).reduce((a, b) => a + b, 0), 'satellite scenes']] },
  ];
}
let SC = [];
function showScene(i) {
  const t = state.tour, s = SC[i];
  t.i = i; t.elapsed = 0; t.t0 = performance.now();
  stopPlay();
  document.body.classList.remove('show-ind', 'show-rank', 'show-dock');
  if (s.cls) document.body.classList.add(...s.cls.split(' '));
  setIndicator(s.ind, s.year);
  const copy = document.querySelector('.stage-copy');
  copy.classList.add('swap');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    $('#stage-kicker').textContent = s.kicker; $('#stage-title').textContent = s.title; $('#stage-lede').innerHTML = s.lede;
    $('#stage-stats').innerHTML = (s.stats || []).map(([, label]) => `<div><b>0</b>${esc(label)}</div>`).join('');
    (s.stats || []).forEach(([v], k) => countUp($('#stage-stats').children[k].firstChild, v));
    copy.classList.remove('swap');
  }));
  $('#stage-count').textContent = `${i + 1} / ${SC.length}`;
  $('#stage-year').textContent = s.ind ? state.year : '';
  t.flying = true;
  const done = () => { t.flying = false; };
  map.once('moveend', done);
  map.flyTo({ ...s.cam, duration: reduced ? 0 : 5200, curve: 1.1, essential: true, padding: s.cls.includes('show-ind') && innerWidth > 980 ? { left: 340, right: 320, top: 60, bottom: 120 } : { left: 0, right: 0, top: 0, bottom: 0 } });
  if (s.play && !t.paused) setTimeout(() => t.on && t.i === i && play(true), 1600);
}
function setPaused(p) {
  const t = state.tour;
  t.paused = p; t.t0 = performance.now();
  $('#stage-pause').textContent = p ? '▶ Play' : '❚❚ Pause';
  if (p) stopPlay(); else if (SC[t.i].play) play(true);
}
function startTour(i = 0) {
  state.tour.on = true; select(null);
  document.body.classList.add('presenting');
  if (state.mode !== 'sim') setMode('sim');
  setPaused(false); showScene(i);
}
function endTour() {
  const t = state.tour;
  t.on = false; stopPlay();
  document.body.classList.remove('presenting', 'show-ind', 'show-rank', 'show-dock');
  if (!state.ind) setIndicator('density');
  map.stop();
  map.easeTo({ center: state.city.centre, zoom: 12.3, pitch: 56, bearing: 24, padding: padding(), duration: 1600 });
}
let last = performance.now();
function frame(now) {
  const dt = Math.min(100, now - last); last = now;
  const t = state.tour;
  if (t.on && SC.length) {
    if (!t.paused) {
      t.elapsed += dt;
      if (!t.flying && !reduced && !map.isMoving()) map.setBearing(map.getBearing() + dt * 0.0022);   // slow orbit between moves
      const s = SC[t.i];
      $('#stage-bar').style.width = `${Math.min(100, (100 * (t.i + t.elapsed / s.ms)) / SC.length)}%`;
      if (t.elapsed >= s.ms) (t.i + 1 < SC.length ? showScene(t.i + 1) : endTour());
    }
    if (SC[t.i].ind) $('#stage-year').textContent = state.year;
  }
  requestAnimationFrame(frame);
}

/* ----------------------------------------------------------------- boot */
function fillMethod() {
  const c = state.city;
  $('#m-zones').textContent = c.zones;
  $('#m-indicators').innerHTML = INDICATORS.map((i) => `<li><b>${i.label}</b> (${i.unit}${i.years ? `, ${c.years[0]}–${c.years[c.years.length - 1]}` : `, ${i.year}`}) — ${i.how}</li>`).join('');
  $('#m-sources').innerHTML = `Sources: © Overture Maps Foundation and OpenStreetMap contributors (buildings, streets, coastline); Copernicus Sentinel-2 L2A (${Object.values(c.sentinel.scenes_used).reduce((a, b) => a + b, 0)} scenes, tile ${c.sentinel.tile}, ${c.sentinel.season}); RGPH 2024 for the city total. Map engine: MapLibre GL JS.`;
  $('#credit').innerHTML = 'Zones and indicators computed from Overture Maps, Copernicus Sentinel-2 and the RGPH 2024 city total. Zones are analysis units, not official districts.';
}
async function boot() {
  const [city, zones, land, green, roads, bld] = await Promise.all([
    getJSON('data/city.json'), getJSON('data/zones.geojson'), getJSON('data/land.geojson'), getJSON('data/green.geojson'),
    getJSON('../dakhla/data/roads.geojson'), getJSON('../data/processed/dakhla_buildings_3d.geojson'),
  ]);
  state.city = city; state.zones = zones;
  for (const f of bld.features) {     // each building takes the colour of the zone it stands in
    const g = f.geometry, pt = centre(g);
    f.properties.zone = (zones.features.find((z) => inside(pt, z.geometry)) || {}).properties?.id || '';
  }
  map.getSource('land').setData(land); map.getSource('green').setData(green); map.getSource('roads').setData(roads);
  map.getSource('zones').setData(zones); map.getSource('buildings').setData(bld);
  try { map.setLight({ anchor: 'map', position: [1.4, 215, 38], color: '#ffd7b5', intensity: 0.5 }); } catch { /* optional */ }
  try { map.setSky({ 'sky-color': '#3a2d57', 'horizon-color': '#e09a72', 'fog-color': '#5a4468', 'sky-horizon-blend': 0.7, 'horizon-fog-blend': 0.8, 'fog-ground-blend': 0.55 }); } catch { /* optional */ }
  for (const f of zones.features) state.labels.push(new maplibregl.Marker({ element: el('div', { class: 'zlabel' }, f.properties.id) }).setLngLat(centre(f.geometry)).addTo(map));
  fillMethod();
  SC = scenes();
  setIndicator(null);
  $('#loading').classList.add('done');
  raise(HEIGHT_X, 2600);
  showScene(0);
  requestAnimationFrame(frame);
}

$('#year-select').onchange = (e) => { stopPlay(); setYear(+e.target.value); };
$('#btn-play').onclick = () => (state.playing ? stopPlay() : play());
document.querySelectorAll('#mode button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
$('#btn-present').onclick = () => startTour(0);
$('#stage-close').onclick = endTour;
$('#stage-pause').onclick = () => setPaused(!state.tour.paused);
$('#stage-prev').onclick = () => showScene(Math.max(0, state.tour.i - 1));
$('#stage-next').onclick = () => (state.tour.i + 1 < SC.length ? showScene(state.tour.i + 1) : endTour());
$('#btn-method').onclick = () => $('#method').showModal();
$('#method-close').onclick = () => $('#method').close();
$('#method').addEventListener('click', (e) => e.target === e.currentTarget && e.currentTarget.close());
addEventListener('keydown', (e) => {
  if ($('#method').open || !state.tour.on || e.target.closest('select, input')) return;
  if (e.key === 'ArrowRight') $('#stage-next').click();
  else if (e.key === 'ArrowLeft') $('#stage-prev').click();
  else if (e.key === ' ') { e.preventDefault(); $('#stage-pause').click(); }
  else if (e.key === 'Escape') endTour();
});
addEventListener('resize', () => state.zones && renderZone());
map.once('load', () => boot().catch((e) => { console.error(e); $('#loading').innerHTML = 'Could not load the city data.'; }));
