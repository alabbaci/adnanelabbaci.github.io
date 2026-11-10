/* Ourika Watch — live watershed dashboard (static, no build step, no API keys).
 *
 * Static layers come from ourika/data/ (see ourika/pipeline/). Live feeds are
 * fetched straight from the browser: Open-Meteo (forecast + GloFAS discharge),
 * USGS (earthquakes) and NASA GIBS (daily satellite tiles).
 */

const TZ = 'Africa/Casablanca';
const CENTER = [-7.745, 31.19];
const QUAKE_RADIUS_KM = 300;
const REFRESH = { wx: 15 * 60e3, flood: 3 * 3600e3, quakes: 5 * 60e3 };

/* Screening thresholds (mm) over the next 48 h. Index = watch level. */
const LEVELS = [
  { name: 'LOW', color: '#4fbf8b' },
  { name: 'WATCH', color: '#e8c84c', h1: 5, h3: 10, h24: 20 },
  { name: 'ALERT', color: '#f08a3c', h1: 10, h3: 20, h24: 40 },
  { name: 'SEVERE', color: '#f0504a', h1: 20, h3: 35, h24: 70 },
];
const RAIN_RAMP = [[0, '#12302f'], [1, '#17525a'], [5, '#1f7f8c'], [15, '#36b3c9'], [30, '#7fd0f0'], [60, '#f0e27a'], [100, '#f0504a']];
const SNOW_RAMP = [[0, '#182226'], [0.02, '#2f4a5a'], [0.1, '#5b8fb0'], [0.3, '#a9cfe6'], [1, '#ffffff']];

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, html = '') => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k === 'class' ? (n.className = v) : n.setAttribute(k, v);
  n.innerHTML = html;
  return n;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 0) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(d));
const sum = (a) => a.reduce((s, v) => s + (v || 0), 0);
const isoDay = (d) => d.toISOString().slice(0, 10);
const getJSON = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url.split('?')[0]}`);
  return r.json();
};
const km = (a, b) => {
  const R = 6371, p = Math.PI / 180;
  const h = Math.sin(((b[1] - a[1]) * p) / 2) ** 2 + Math.cos(a[1] * p) * Math.cos(b[1] * p) * Math.sin(((b[0] - a[0]) * p) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const ago = (t) => {
  const h = (Date.now() - t) / 3600e3;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`;
  if (h < 48) return `${Math.round(h)} h ago`;
  if (h < 24 * 60) return `${Math.round(h / 24)} d ago`;
  return new Date(t).toISOString().slice(0, 10);
};

const state = {
  data: {}, wx: null, flood: null, quakes: null, historic: null,
  metric: 'watch', selected: null, basemap: 'night',
  satDate: new Date(Date.now() - 86400e3),
  feeds: { WX: null, FLOW: null, SEIS: null },
  labels: [],
};

/* ------------------------------------------------------------------ layers */
const LAYERS = [
  { id: 'basin', group: 'Basin', label: 'Watershed boundary', color: '#e8b44c', on: true, ids: ['basin-glow', 'basin-line'], count: () => `${fmt(state.data.basin?.area_km2)} km²` },
  { id: 'subs', group: 'Basin', label: 'Sub-basins', color: '#4fbf8b', on: true, ids: ['subs-fill', 'subs-line'], count: () => state.data.subs?.features.length },
  { id: 'rivers', group: 'Basin', label: 'River network', color: '#36d6c9', on: true, ids: ['river-main', 'rivers'], count: () => `${fmt(sum(state.data.rivers?.features.filter((f) => !f.properties.main_stem).map((f) => f.properties.length_km) || []))} km` },
  { id: 'relief', group: 'Basin', label: 'Relief shading', color: '#9aa7a4', on: true, ids: ['hillshade'] },
  { id: 'places', group: 'People', label: 'Villages', color: '#ffffff', on: true, ids: ['places'], count: () => state.data.places?.features.length },
  { id: 'roads', group: 'People', label: 'Roads', color: '#c9b79a', on: true, ids: ['roads'], count: () => state.data.roads?.features.length },
  { id: 'exposure', group: 'People', label: 'Buildings near channels', color: '#ff6b5e', on: true, ids: ['exposure'], count: () => state.data.exposure?.features.length },
  { id: 'pois', group: 'People', label: 'Points of interest', color: '#c79bff', on: false, ids: ['pois'], count: () => state.data.pois?.features.length },
  { id: 'quakes', group: 'Live', label: 'Earthquakes · 365 d', color: '#f08a3c', on: true, ids: ['quakes'], count: () => state.quakes?.features.length },
  { id: 'historic', group: 'Live', label: 'Historic M5+ · since 1900', color: '#f0504a', on: true, ids: ['historic'], count: () => state.historic?.features.length },
  { id: 'snowcover', group: 'Satellite', label: 'Snow cover · MODIS', color: '#a9cfe6', on: false, ids: ['gibs-snow'], gibs: true },
  { id: 'truecolor', group: 'Satellite', label: 'True colour · MODIS', color: '#7fb37a', on: false, ids: ['gibs-true'], gibs: true },
];
const GIBS = {
  'gibs-snow': { layer: 'MODIS_Terra_NDSI_Snow_Cover', set: 'GoogleMapsCompatible_Level8', ext: 'png', maxzoom: 8, opacity: 0.8 },
  'gibs-true': { layer: 'MODIS_Terra_CorrectedReflectance_TrueColor', set: 'GoogleMapsCompatible_Level9', ext: 'jpg', maxzoom: 9, opacity: 1 },
};
const gibsTiles = (g) => [`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${g.layer}/default/${isoDay(state.satDate)}/${g.set}/{z}/{y}/{x}.${g.ext}`];
const TERRAIN_TILES = ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'];
const BASEMAPS = {
  night: { tiles: ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png`), maxzoom: 19, attribution: '© <a href="https://carto.com/attributions">CARTO</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
  sat: { tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], maxzoom: 18, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
  topo: { tiles: ['a', 'b', 'c'].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`), maxzoom: 17, attribution: '© <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA) © OpenStreetMap' },
};

const empty = { type: 'FeatureCollection', features: [] };
const style = {
  version: 8,
  sources: {
    ...Object.fromEntries(Object.entries(BASEMAPS).map(([k, b]) => [`bm-${k}`, { type: 'raster', tiles: b.tiles, tileSize: 256, maxzoom: b.maxzoom, attribution: b.attribution }])),
    dem: { type: 'raster-dem', tiles: TERRAIN_TILES, tileSize: 256, maxzoom: 14, encoding: 'terrarium', attribution: 'Terrain: Mapzen / AWS' },
    'dem-shade': { type: 'raster-dem', tiles: TERRAIN_TILES, tileSize: 256, maxzoom: 14, encoding: 'terrarium' },
    ...Object.fromEntries(Object.entries(GIBS).map(([k, g]) => [k, { type: 'raster', tiles: gibsTiles(g), tileSize: 256, maxzoom: g.maxzoom, attribution: 'NASA GIBS / MODIS' }])),
    ...Object.fromEntries(['basin', 'subs', 'rivers', 'places', 'roads', 'exposure', 'pois', 'quakes', 'historic', 'probe'].map((k) => [k, { type: 'geojson', data: empty, promoteId: k === 'subs' ? 'id' : undefined }])),
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#06090a' } },
    { id: 'bm-night', type: 'raster', source: 'bm-night', paint: { 'raster-opacity': 0.9 } },
    { id: 'bm-sat', type: 'raster', source: 'bm-sat', layout: { visibility: 'none' }, paint: { 'raster-saturation': -0.15, 'raster-brightness-max': 0.85 } },
    { id: 'bm-topo', type: 'raster', source: 'bm-topo', layout: { visibility: 'none' }, paint: { 'raster-brightness-max': 0.75, 'raster-saturation': -0.3 } },
    { id: 'gibs-true', type: 'raster', source: 'gibs-true', layout: { visibility: 'none' } },
    { id: 'hillshade', type: 'hillshade', source: 'dem-shade', paint: { 'hillshade-exaggeration': 0.42, 'hillshade-shadow-color': '#000a0c', 'hillshade-highlight-color': '#d9efe9', 'hillshade-accent-color': '#0d2a2c' } },
    { id: 'gibs-snow', type: 'raster', source: 'gibs-snow', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.8 } },
    { id: 'subs-fill', type: 'fill', source: 'subs', paint: { 'fill-color': ['coalesce', ['feature-state', 'color'], '#1b2a2a'], 'fill-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0.62, ['boolean', ['feature-state', 'hover'], false], 0.5, 0.34] } },
    { id: 'subs-line', type: 'line', source: 'subs', paint: { 'line-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#36d6c9', 'rgba(255,255,255,0.28)'], 'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 2.2, 0.7] } },
    { id: 'basin-glow', type: 'line', source: 'basin', paint: { 'line-color': '#e8b44c', 'line-width': 9, 'line-blur': 8, 'line-opacity': 0.45 } },
    { id: 'basin-line', type: 'line', source: 'basin', paint: { 'line-color': '#e8b44c', 'line-width': 1.8, 'line-dasharray': [3, 1.5] } },
    { id: 'roads', type: 'line', source: 'roads', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#c9b79a', 'line-opacity': 0.75, 'line-width': ['match', ['get', 'class'], ['trunk', 'primary'], 2.2, 'secondary', 1.7, 'tertiary', 1.2, 0.7] } },
    { id: 'river-main', type: 'line', source: 'rivers', filter: ['has', 'main_stem'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#36d6c9', 'line-width': 9, 'line-blur': 7, 'line-opacity': 0.4 } },
    { id: 'rivers', type: 'line', source: 'rivers', filter: ['!', ['has', 'main_stem']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['interpolate', ['linear'], ['get', 'upstream_km2'], 1.5, '#1f8f93', 30, '#36d6c9', 300, '#9ff3ea'], 'line-width': ['interpolate', ['linear'], ['sqrt', ['get', 'upstream_km2']], 1.2, 0.5, 8, 1.8, 22.4, 4], 'line-opacity': ['interpolate', ['linear'], ['zoom'], 9, ['case', ['>', ['get', 'upstream_km2'], 8], 0.9, 0.25], 12, 0.95] } },
    { id: 'exposure', type: 'circle', source: 'exposure', minzoom: 10.5, paint: { 'circle-color': '#ff6b5e', 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10.5, 1, 14, 3], 'circle-opacity': 0.85 } },
    { id: 'pois', type: 'circle', source: 'pois', layout: { visibility: 'none' }, paint: { 'circle-color': '#c79bff', 'circle-radius': 3, 'circle-stroke-color': '#06090a', 'circle-stroke-width': 1 } },
    { id: 'places', type: 'circle', source: 'places', paint: { 'circle-color': '#ffffff', 'circle-radius': ['match', ['get', 'class'], 'town', 4.5, 'village', 3, 2], 'circle-stroke-color': '#06090a', 'circle-stroke-width': 1.2, 'circle-opacity': ['case', ['get', 'in_basin'], 1, 0.45] } },
    { id: 'historic', type: 'circle', source: 'historic', paint: { 'circle-color': 'rgba(240,80,74,0.08)', 'circle-stroke-color': '#f0504a', 'circle-stroke-width': 1.4, 'circle-radius': ['interpolate', ['exponential', 1.6], ['get', 'mag'], 5, 7, 7, 26] } },
    { id: 'quakes', type: 'circle', source: 'quakes', paint: { 'circle-color': '#f08a3c', 'circle-opacity': 0.75, 'circle-stroke-color': '#06090a', 'circle-stroke-width': 1, 'circle-radius': ['interpolate', ['exponential', 1.6], ['get', 'mag'], 2.5, 3.5, 6, 18] } },
    { id: 'probe', type: 'circle', source: 'probe', paint: { 'circle-radius': 6, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } },
  ],
};

const map = new maplibregl.Map({
  container: 'map', style, center: CENTER, zoom: 9.6, maxZoom: 16, minZoom: 4, maxPitch: 75,
  attributionControl: { compact: true }, hash: true,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
window.__map = map;

const panelPadding = () => (innerWidth > 900 ? { top: 70, bottom: 60, left: 280, right: 370 } : { top: 110, bottom: 90, left: 20, right: 20 });
const fitBasin = (animate = true) => {
  const b = state.data.basin?.bbox;
  if (b) map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: panelPadding(), animate, pitch: map.getPitch(), bearing: map.getBearing() });
};

/* ------------------------------------------------------------ static data */
async function loadStatic() {
  const names = { basin: 'basin.json', watershed: 'watershed.geojson', subs: 'subbasins.geojson', rivers: 'rivers.geojson', places: 'places.geojson', roads: 'roads.geojson', exposure: 'exposure.geojson', pois: 'pois.geojson', context: 'context.json' };
  await Promise.all(Object.entries(names).map(async ([k, f]) => {
    try { state.data[k] = await getJSON(`data/${f}`); } catch (e) { console.warn('missing', f, e.message); state.data[k] = f.endsWith('geojson') ? empty : null; }
  }));
  const d = state.data;
  for (const f of d.subs.features) {
    const c = d.context?.subbasins?.[f.properties.id] || {};
    Object.assign(f.properties, { buildings: c.buildings || 0, exposed: c.exposed || 0, villages: c.villages || [] });
    f.properties.label = `${f.properties.id} · ${f.properties.villages[0] || `headwaters ${f.properties.elev_mean} m`}`;
  }
  map.getSource('basin').setData(d.watershed);
  for (const k of ['subs', 'rivers', 'places', 'roads', 'exposure', 'pois']) map.getSource(k).setData(d[k]);
  addLabels();
  renderLayers();
  renderTerrain();
  fillAbout();
  if (!location.hash) fitBasin(false);
}

function addLabels() {
  const d = state.data;
  const mk = (lngLat, text, key) => state.labels.push(new maplibregl.Marker({ element: el('div', { class: `place-label${key ? ' key' : ''}` }, esc(text)), anchor: 'bottom' }).setLngLat(lngLat).addTo(map));
  const seen = new Set();
  for (const f of d.places.features) {
    const p = f.properties, n = (p.name || '').trim();
    if (!p.in_basin || p.class === 'hamlet' || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    mk(f.geometry.coordinates, n);
  }
  if (d.basin) {
    mk([d.basin.outlet.lon, d.basin.outlet.lat], `▼ Aghbalou gauge · ${d.basin.outlet.elev_m} m`, true);
    mk([d.basin.summit.lon, d.basin.summit.lat], `▲ ${d.basin.elev_max} m`, true);
  }
  const z = () => document.body.classList.toggle('zoom-far', map.getZoom() < 10.4);
  map.on('zoom', z); z();
}

/* -------------------------------------------------------------- layer UI */
function setLayer(l, on) {
  l.on = on;
  for (const id of l.ids) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  if (l.id === 'places') for (const m of state.labels) m.getElement().style.visibility = on ? '' : 'hidden';
  $('#satdate').style.display = LAYERS.some((x) => x.gibs && x.on) ? 'flex' : 'none';
}
function renderLayers() {
  const box = $('#layer-list');
  box.innerHTML = '';
  let group = '';
  for (const l of LAYERS) {
    if (l.group !== group) box.append(el('div', { class: 'group' }, (group = l.group)));
    const c = l.count?.();
    const b = el('button', { class: `layer${l.on ? ' on' : ''}`, style: `--c:${l.color}`, 'aria-pressed': l.on }, `<i class="sw"></i><span>${l.label}</span><em>${c ?? ''}</em>`);
    b.onclick = () => { setLayer(l, !l.on); renderLayers(); };
    box.append(b);
  }
  $('#layer-total').textContent = `${LAYERS.filter((l) => l.on).length}/${LAYERS.length}`;
  $('#sat-label').textContent = isoDay(state.satDate);
  $('#sat-next').disabled = isoDay(state.satDate) >= isoDay(new Date(Date.now() - 86400e3));
  $('#satdate').style.display = LAYERS.some((x) => x.gibs && x.on) ? 'flex' : 'none';
}
function shiftSat(days) {
  state.satDate = new Date(state.satDate.getTime() + days * 86400e3);
  for (const [k, g] of Object.entries(GIBS)) map.getSource(k).setTiles(gibsTiles(g));
  renderLayers();
}

/* ------------------------------------------------------------- forecasts */
const HOURLY = 'precipitation,snowfall,temperature_2m,freezing_level_height,snow_depth,wind_gusts_10m,precipitation_probability';
const CURRENT = 'temperature_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,relative_humidity_2m';
const WMO = { 0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Showers', 81: 'Heavy showers', 82: 'Violent showers', 85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail' };

function maxWindow(values, from, to, w) {
  let best = 0, at = from;
  for (let i = from; i + w <= to; i++) {
    let s = 0;
    for (let j = 0; j < w; j++) s += values[i + j] || 0;
    if (s > best) { best = s; at = i; }
  }
  return { v: best, i: at };
}
function assess(h, now) {
  const p = h.precipitation, end = Math.min(p.length, now + 48);
  const h1 = maxWindow(p, now, end, 1), h3 = maxWindow(p, now, end, 3), h24 = maxWindow(p, now, end, 24);
  let level = 0, why = '';
  for (let L = LEVELS.length - 1; L > 0 && !level; L--) {
    const t = LEVELS[L];
    if (h1.v >= t.h1) { level = L; why = `${fmt(h1.v, 1)} mm in 1 h`; }
    else if (h3.v >= t.h3) { level = L; why = `${fmt(h3.v, 1)} mm in 3 h`; }
    else if (h24.v >= t.h24) { level = L; why = `${fmt(h24.v, 0)} mm in 24 h`; }
  }
  const snowNow = h.snow_depth[now] || 0;
  return {
    level, why, peakTime: h.time[h1.v >= 0.1 ? h1.i : now], h1: h1.v, h3: h3.v, h24max: h24.v,
    r24: sum(p.slice(now, now + 24)), r72: sum(p.slice(now, now + 72)),
    snow: snowNow, snowfall72: sum(h.snowfall.slice(now, now + 72)),
    fzl: h.freezing_level_height[now],
  };
}

async function loadWeather() {
  const subs = state.data.subs.features;
  if (!subs.length) return;
  const q = (k) => subs.map((f) => f.properties[k]).join(',');
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${q('pt_lat')}&longitude=${q('pt_lon')}&elevation=${q('elev_mean')}&hourly=${HOURLY}&current=${CURRENT}&past_days=1&forecast_days=7&timezone=${encodeURIComponent(TZ)}`;
    let res = await getJSON(url);
    if (!Array.isArray(res)) res = [res];
    const time = res[0].hourly.time;
    const nowKey = res[0].current.time.slice(0, 13);
    const now = Math.max(0, time.findIndex((t) => t.slice(0, 13) === nowKey));
    const total = sum(subs.map((f) => f.properties.area_km2));
    const units = subs.map((f, i) => ({ id: f.properties.id, p: f.properties, hourly: res[i].hourly, current: res[i].current, a: assess(res[i].hourly, now) }));
    const mean = (key) => time.map((_, t) => sum(units.map((u) => (u.hourly[key][t] || 0) * u.p.area_km2)) / total);
    state.wx = {
      time, now, units, fetched: Date.now(),
      meanRain: mean('precipitation'), meanFzl: mean('freezing_level_height'),
      maxRain: time.map((_, t) => Math.max(...units.map((u) => u.hourly.precipitation[t] || 0))),
      level: Math.max(...units.map((u) => u.a.level)),
    };
    state.feeds.WX = true;
  } catch (e) { console.warn(e); state.feeds.WX = false; }
  renderWeather();
}

/* ---------------------------------------------------------------- colours */
const rampColor = (ramp, v) => {
  for (let i = ramp.length - 1; i >= 0; i--) if (v >= ramp[i][0]) return ramp[i][1];
  return ramp[0][1];
};
function paintSubs() {
  const m = state.metric;
  for (const f of state.data.subs.features) {
    const u = state.wx?.units.find((x) => x.id === f.properties.id);
    let color = '#1b2a2a';
    if (u) color = m === 'watch' ? LEVELS[u.a.level].color : m === 'snow' ? rampColor(SNOW_RAMP, u.a.snow) : rampColor(RAIN_RAMP, m === 'r24' ? u.a.r24 : u.a.r72);
    map.setFeatureState({ source: 'subs', id: f.properties.id }, { color });
  }
  const lg = $('#legend');
  if (m === 'watch') lg.innerHTML = `<div class="ramp">${LEVELS.map((l) => `<i style="background:${l.color}"></i>`).join('')}</div><div class="ticks">${LEVELS.map((l) => `<span>${l.name}</span>`).join('')}</div>`;
  else {
    const r = m === 'snow' ? SNOW_RAMP : RAIN_RAMP, u = m === 'snow' ? 'm snow depth' : `mm, next ${m === 'r24' ? 24 : 72} h`;
    lg.innerHTML = `<div class="ramp">${r.map((s) => `<i style="background:${s[1]}"></i>`).join('')}</div><div class="ticks">${r.map((s) => `<span>${s[0]}</span>`).join('')}</div><div style="margin-top:4px;color:var(--ink-3)">${u}</div>`;
  }
}

/* ----------------------------------------------------------------- charts */
function setup(canvas) {
  const dpr = devicePixelRatio || 1, w = canvas.clientWidth || 300, h = +canvas.getAttribute('height');
  canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.height = `${h}px`;
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  c.font = '10px ui-monospace, Menlo, Consolas, monospace';
  return { c, w, h };
}
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const niceMax = (v, floor) => { const m = Math.max(v, floor); const p = 10 ** Math.floor(Math.log10(m)); return Math.ceil(m / p) * p; };
function axes(c, w, h, pad, ymax, yfmt = (v) => v) {
  c.strokeStyle = 'rgba(190,220,215,0.13)'; c.fillStyle = css('--ink-3'); c.lineWidth = 1; c.textAlign = 'right'; c.textBaseline = 'middle';
  for (const f of [0, 0.5, 1]) {
    const y = pad.t + (h - pad.t - pad.b) * (1 - f);
    c.beginPath(); c.moveTo(pad.l, y + 0.5); c.lineTo(w - pad.r, y + 0.5); c.stroke();
    c.fillText(yfmt(ymax * f), pad.l - 4, y);
  }
}
function dayTicks(c, time, x, h, pad) {
  c.fillStyle = css('--ink-3'); c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  time.forEach((t, i) => {
    if (!t.endsWith('T00:00')) return;
    c.fillRect(x(i), pad.t, 1, h - pad.t - pad.b + 3);
    c.fillText(new Date(`${t}:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }).toUpperCase(), x(i) + 3, h - 2);
  });
}
function nowLine(c, x, h, pad) {
  c.strokeStyle = css('--gold'); c.setLineDash([2, 2]); c.beginPath(); c.moveTo(x + 0.5, pad.t - 4); c.lineTo(x + 0.5, h - pad.b); c.stroke(); c.setLineDash([]);
  c.fillStyle = css('--gold'); c.textAlign = 'center'; c.textBaseline = 'alphabetic'; c.fillText('NOW', x, pad.t - 5);
}
function rainChart(canvas, time, now, bars, envelope) {
  const { c, w, h } = setup(canvas), pad = { l: 26, r: 4, t: 16, b: 14 };
  const ymax = niceMax(Math.max(...(envelope || bars)), 2), n = time.length;
  const x = (i) => pad.l + ((w - pad.l - pad.r) * i) / n, y = (v) => pad.t + (h - pad.t - pad.b) * (1 - Math.min(v, ymax) / ymax);
  axes(c, w, h, pad, ymax);
  dayTicks(c, time, x, h, pad);
  const bw = Math.max(1, (w - pad.l - pad.r) / n - 0.4);
  if (envelope) { c.fillStyle = 'rgba(54,214,201,0.22)'; envelope.forEach((v, i) => v > 0 && c.fillRect(x(i), y(v), bw, y(0) - y(v))); }
  bars.forEach((v, i) => { if (v > 0) { c.fillStyle = i < now ? 'rgba(54,214,201,0.45)' : css('--water'); c.fillRect(x(i), y(v), bw, y(0) - y(v)); } });
  nowLine(c, x(now), h, pad);
}
function lineChart(canvas, { xs, series, nowIdx, ymax, yfmt, labels, band }) {
  const { c, w, h } = setup(canvas), pad = { l: 34, r: 4, t: 16, b: 14 };
  const n = xs.length, x = (i) => pad.l + ((w - pad.l - pad.r) * i) / Math.max(1, n - 1), y = (v) => pad.t + (h - pad.t - pad.b) * (1 - Math.min(v, ymax) / ymax);
  axes(c, w, h, pad, ymax, yfmt);
  if (band) {
    c.fillStyle = 'rgba(54,214,201,0.16)'; c.beginPath();
    band.hi.forEach((v, i) => (i ? c.lineTo(x(i), y(v)) : c.moveTo(x(i), y(v))));
    for (let i = n - 1; i >= 0; i--) c.lineTo(x(i), y(band.lo[i]));
    c.fill();
  }
  for (const s of series) {
    c.strokeStyle = s.color; c.lineWidth = s.width || 1.6; c.setLineDash(s.dash || []); c.beginPath();
    let pen = false;
    s.values.forEach((v, i) => { if (v == null) { pen = false; return; } pen ? c.lineTo(x(i), y(v)) : c.moveTo(x(i), y(v)); pen = true; });
    c.stroke(); c.setLineDash([]);
  }
  c.fillStyle = css('--ink-3'); c.textBaseline = 'alphabetic';
  (labels || []).forEach(([i, text, align]) => { c.textAlign = align || 'center'; c.fillText(text, x(i), h - 2); });
  if (nowIdx != null && nowIdx >= 0) nowLine(c, x(nowIdx), h, pad);
}

/* ------------------------------------------------------------- rendering */
const localTime = (iso) => `${new Date(`${iso}:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })} ${iso.slice(11, 16)}`;

function renderWeather() {
  renderFeeds();
  const wx = state.wx;
  if (!wx) {
    $('#status-body').textContent = 'Forecast feed unreachable — retrying.';
    $('#now-body').textContent = '—';
    return;
  }
  paintSubs();
  const L = LEVELS[wx.level], worst = [...wx.units].sort((a, b) => b.a.level - a.a.level || b.a.h24max - a.a.h24max);
  const chip = $('#alert-chip');
  chip.className = `chip lvl-${wx.level}`; chip.textContent = `FLOOD WATCH · ${L.name}`;
  const counts = LEVELS.map((_, i) => wx.units.filter((u) => u.a.level === i).length);
  const top = worst[0];
  $('#status-body').className = '';
  $('#status-body').innerHTML = `
    <div class="big lvl-${wx.level}"><b>${L.name}</b><span>${wx.level ? `${counts.slice(1).reduce((s, v) => s + v, 0)} of ${wx.units.length} sub-basins flagged` : 'no sub-basin reaches a threshold'}</span></div>
    <p class="why">${wx.level
      ? `Heaviest signal: <b>${esc(top.p.label)}</b>, ${top.a.why}, peaking around ${localTime(top.a.peakTime)}.`
      : `Wettest unit: ${esc(top.p.label)} with ${fmt(top.a.h24max, 1)} mm in its wettest 24 h.`}</p>
    <div class="sblist">${worst.map((u) => `<button class="sbrow lvl-${u.a.level}" data-sb="${u.id}"><i></i><span>${esc(u.p.label)}</span><em>${fmt(u.a.h1, 1)} mm/h</em><u>${fmt(u.a.r24, 1)} mm/24h</u></button>`).join('')}</div>`;
  $('#status-body').querySelectorAll('[data-sb]').forEach((b) => (b.onclick = () => select(b.dataset.sb, true)));

  const byElev = [...wx.units].sort((a, b) => a.p.elev_mean - b.p.elev_mean);
  const refs = [byElev[0], byElev[Math.floor(byElev.length / 2)], byElev[byElev.length - 1]];
  $('#now-time').textContent = `${wx.units[0].current.time.slice(11)} local`;
  $('#now-body').className = 'grid3';
  $('#now-body').innerHTML = refs.map((u, i) => `<div class="tile"><i>${['Low', 'Mid', 'High'][i]} ${u.p.elev_mean} m</i><b>${fmt(u.current.temperature_2m, 1)}°</b><u>${WMO[u.current.weather_code] || '—'}<br>gust ${fmt(u.current.wind_gusts_10m)} km/h · RH ${fmt(u.current.relative_humidity_2m)}%</u></div>`).join('');

  rainChart($('#chart-rain'), wx.time, wx.now, wx.meanRain, wx.maxRain);
  const days = {};
  wx.time.forEach((t, i) => { if (i >= wx.now - (wx.now % 24)) days[t.slice(0, 10)] = (days[t.slice(0, 10)] || 0) + wx.meanRain[i]; });
  $('#rain-days').innerHTML = Object.entries(days).slice(0, 7).map(([d, v]) => `<div>${new Date(`${d}T12:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })}<b>${fmt(v, v < 10 ? 1 : 0)}</b></div>`).join('');

  renderSnow();
  if (state.selected) renderSelected();
  renderTicker();
}

function renderSnow() {
  const wx = state.wx, b = state.data.basin;
  if (!wx || !b) return;
  const hy = b.hypsometry, total = sum(hy.area_km2);
  const above = (z) => sum(hy.from_m.map((lo, i) => hy.area_km2[i] * Math.min(1, Math.max(0, (lo + hy.band_m - z) / hy.band_m)))) / total;
  const from = wx.now, to = Math.min(wx.time.length, wx.now + 96);
  const fz = wx.meanFzl.slice(from, to);
  lineChart($('#chart-snow'), {
    xs: fz, ymax: 5000, yfmt: (v) => `${v / 1000}k`, nowIdx: 0,
    series: [
      { values: fz.map(() => b.elev_max), color: 'rgba(255,255,255,0.35)', dash: [3, 3], width: 1 },
      { values: fz.map(() => b.elev_mean), color: 'rgba(255,255,255,0.2)', dash: [3, 3], width: 1 },
      { values: fz, color: '#a9cfe6', width: 1.8 },
    ],
    labels: [[fz.length - 1, '+96 h', 'right'], [Math.floor(fz.length / 2), '+48 h']],
  });
  const lo = Math.min(...fz), snowiest = [...wx.units].sort((a, c) => c.a.snow - a.a.snow)[0];
  $('#snow-note').innerHTML = `Freezing level now <b>${fmt(fz[0])} m</b>: ${fmt(above(fz[0]) * 100)}% of the basin sits above it. Lowest in 96 h: ${fmt(lo)} m (${fmt(above(lo) * 100)}% above). ` +
    (snowiest.a.snow > 0.01 ? `Deepest modelled snowpack: ${fmt(snowiest.a.snow * 100)} cm in ${esc(snowiest.p.label)}.` : 'No modelled snowpack in any sub-basin.') +
    ' Dashed: summit and mean basin elevation.';
}

async function loadFlood() {
  const o = state.data.basin?.outlet;
  if (!o) return;
  try {
    state.flood = await getJSON(`https://flood-api.open-meteo.com/v1/flood?latitude=${o.lat}&longitude=${o.lon}&daily=river_discharge,river_discharge_mean,river_discharge_max&past_days=30&forecast_days=14`);
    state.feeds.FLOW = true;
  } catch (e) { console.warn(e); state.feeds.FLOW = false; }
  renderFlood();
}
function renderFlood() {
  renderFeeds();
  const d = state.flood?.daily;
  if (!d) { $('#flow-note').textContent = 'Discharge feed unreachable — retrying.'; return; }
  const today = isoDay(new Date()), nowIdx = d.time.indexOf(today);
  const q = d.river_discharge, hi = d.river_discharge_max.map((v, i) => v ?? q[i]), lo = d.river_discharge_mean.map((v, i) => Math.min(v ?? q[i], q[i] ?? v));
  const ymax = niceMax(Math.max(...hi.filter((v) => v != null)), 1);
  lineChart($('#chart-flow'), {
    xs: d.time, ymax, yfmt: (v) => fmt(v, ymax < 10 ? 1 : 0), nowIdx,
    band: { hi, lo }, series: [{ values: q, color: css('--water'), width: 1.8 }],
    labels: [[0, d.time[0].slice(5), 'left'], [d.time.length - 1, d.time[d.time.length - 1].slice(5), 'right']],
  });
  const nowQ = q[Math.max(0, nowIdx)], past = q.slice(0, Math.max(1, nowIdx)), fut = hi.slice(Math.max(0, nowIdx));
  const peak = Math.max(...fut), peakDay = d.time[Math.max(0, nowIdx) + fut.indexOf(peak)];
  $('#flow-note').innerHTML = `Today <b>${fmt(nowQ, 2)} m³/s</b> (30-day mean ${fmt(sum(past) / past.length, 2)}). Ensemble peak in the next 14 days: <b>${fmt(peak, 2)} m³/s</b> on ${peakDay}. Band: ensemble mean to maximum. Modelled on a 5 km cell — read the trend, not the absolute value.`;
  renderTicker();
}

async function loadQuakes() {
  const base = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude=${CENTER[1]}&longitude=${CENTER[0]}&maxradiuskm=${QUAKE_RADIUS_KM}&orderby=time`;
  try {
    const start = isoDay(new Date(Date.now() - 365 * 86400e3));
    const [recent, hist] = await Promise.all([
      getJSON(`${base}&minmagnitude=2.5&starttime=${start}&limit=200`),
      state.historic ? Promise.resolve(state.historic) : getJSON(`${base}&minmagnitude=5&starttime=1900-01-01&limit=200`),
    ]);
    state.quakes = recent; state.historic = hist;
    map.getSource('quakes').setData(recent); map.getSource('historic').setData(hist);
    state.feeds.SEIS = true;
  } catch (e) { console.warn(e); state.feeds.SEIS = false; }
  renderQuakes();
}
function quakeRow(f) {
  const p = f.properties, c = f.geometry.coordinates;
  return `<button class="quake" data-q="${f.id}"><b class="${p.mag >= 5 ? 'm5' : ''}">M ${fmt(p.mag, 1)}</b><span title="${esc(p.place)}">${esc(p.place || 'Unnamed')}</span><em>${fmt(km(CENTER, c))} km · ${ago(p.time)}</em></button>`;
}
function renderQuakes() {
  renderFeeds(); renderLayers();
  const box = $('#quake-body');
  if (!state.quakes) { box.textContent = 'Earthquake feed unreachable — retrying.'; return; }
  box.className = '';
  const recent = state.quakes.features, hist = [...state.historic.features].sort((a, b) => b.properties.mag - a.properties.mag);
  box.innerHTML = `<div class="sub">Past 365 days · M 2.5+ · ${recent.length} event${recent.length === 1 ? '' : 's'}</div>` +
    (recent.length ? recent.slice(0, 6).map(quakeRow).join('') : '<p class="note">No catalogued events in the past year.</p>') +
    `<div class="sub">Largest on record · M 5+ since 1900 · ${hist.length}</div>` + hist.slice(0, 4).map(quakeRow).join('');
  box.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => {
    const f = [...recent, ...hist].find((x) => x.id === b.dataset.q);
    map.flyTo({ center: f.geometry.coordinates, zoom: 8.5 });
    quakePopup(f);
  }));
  renderTicker();
}
let popup;
const showPopup = (lngLat, html) => { popup?.remove(); popup = new maplibregl.Popup({ offset: 10, maxWidth: '260px' }).setLngLat(lngLat).setHTML(`<div class="pop">${html}</div>`).addTo(map); };
function quakePopup(f) {
  const p = f.properties, c = f.geometry.coordinates;
  showPopup(c, `<h4>M ${fmt(p.mag, 1)} earthquake</h4><div>${esc(p.place)}</div><dl><dt>Time (UTC)</dt><dd>${new Date(p.time).toISOString().slice(0, 16).replace('T', ' ')}</dd><dt>Depth</dt><dd>${fmt(c[2])} km</dd><dt>From basin</dt><dd>${fmt(km(CENTER, c))} km</dd></dl><a href="${esc(p.url)}" target="_blank" rel="noopener">USGS event page ↗</a>`);
}

function renderTerrain() {
  const b = state.data.basin, x = state.data.context;
  if (!b) return;
  $('#terrain-stats').innerHTML = [
    ['Area', `${fmt(b.area_km2)} km²`], ['Relief', `${b.elev_min}–${b.elev_max} m`], ['Mean elev.', `${b.elev_mean} m`], ['Main stem', `${fmt(b.main_stem_km, 1)} km`],
    ['Stem slope', `${fmt(b.mean_slope_main_stem_pct, 1)} %`], ['Villages', x ? x.villages_in_basin : '—'], ['Buildings', x ? x.buildings.toLocaleString('en') : '—'], ['Near channels', x ? x.exposed_buildings.toLocaleString('en') : '—'],
  ].map(([k, v]) => `<div><i>${k}</i><b>${v}</b></div>`).join('');
  const pr = b.profile, dmax = pr[pr.length - 1][0], N = 80;
  const resampled = Array.from({ length: N + 1 }, (_, i) => { const d = (dmax * i) / N; const j = pr.findIndex((p) => p[0] >= d); return pr[Math.max(0, j)][1]; });
  lineChart($('#chart-profile'), { xs: resampled, ymax: 4000, yfmt: (v) => `${v / 1000}k`, series: [{ values: resampled, color: css('--gold'), width: 1.8 }], labels: [[0, 'outlet', 'left'], [N, `${fmt(dmax)} km`, 'right']] });
  const { c, w, h } = setup($('#chart-hyps')), hy = b.hypsometry, n = hy.from_m.filter((_, i) => hy.area_km2[i] > 0).length, mx = Math.max(...hy.area_km2);
  const bw = (w - 4) / n;
  hy.from_m.slice(0, n).forEach((lo, i) => {
    const bh = ((h - 26) * hy.area_km2[i]) / mx;
    c.fillStyle = 'rgba(232,180,76,0.75)'; c.fillRect(2 + i * bw, h - 14 - bh, bw - 2, bh);
    c.fillStyle = css('--ink-3'); c.textAlign = 'center';
    if (i % 3 === 0) c.fillText(`${lo / 1000}k`, 2 + i * bw + bw / 2, h - 2);
    if (hy.area_km2[i] === mx) c.fillText(`${fmt(mx)} km²`, 2 + i * bw + bw / 2, h - 18 - bh);
  });
}

function renderFeeds() {
  $('#feeds').innerHTML = Object.entries(state.feeds).map(([k, v]) => `<span class="feed ${v == null ? '' : v ? 'ok' : 'err'}" title="${k} feed ${v == null ? 'loading' : v ? 'live' : 'unreachable'}">${k}</span>`).join('');
}
function renderTicker() {
  const items = [];
  const wx = state.wx;
  if (wx) {
    items.push([LEVELS[wx.level].color, `FLOOD WATCH ${LEVELS[wx.level].name}`]);
    for (const u of wx.units.filter((x) => x.a.level > 0)) items.push([LEVELS[u.a.level].color, `${u.p.label}: ${u.a.why}, ~${localTime(u.a.peakTime)}`]);
    items.push(['#36d6c9', `Basin rain next 24 h ${fmt(sum(wx.meanRain.slice(wx.now, wx.now + 24)), 1)} mm · 72 h ${fmt(sum(wx.meanRain.slice(wx.now, wx.now + 72)), 1)} mm`]);
    items.push(['#a9cfe6', `Freezing level ${fmt(wx.meanFzl[wx.now])} m`]);
  }
  const d = state.flood?.daily;
  if (d) { const i = Math.max(0, d.time.indexOf(isoDay(new Date()))); items.push(['#36d6c9', `Aghbalou (GloFAS) ${fmt(d.river_discharge[i], 2)} m³/s`]); }
  for (const f of state.quakes?.features.slice(0, 4) || []) items.push(['#f08a3c', `M${fmt(f.properties.mag, 1)} ${f.properties.place} · ${ago(f.properties.time)}`]);
  $('#ticker-items').innerHTML = items.map(([c, t]) => `<span style="--c:${c}">${esc(t)}</span>`).join('');
}

/* ---------------------------------------------------------- interactions */
function select(id, fly) {
  if (state.selected) map.setFeatureState({ source: 'subs', id: state.selected }, { selected: false });
  state.selected = id;
  const card = $('#card-selected');
  if (!id) { card.hidden = true; return; }
  map.setFeatureState({ source: 'subs', id }, { selected: true });
  renderSelected();
  $('#intel').scrollTo({ top: 0, behavior: 'smooth' });
  if (fly) {
    const f = state.data.subs.features.find((x) => x.properties.id === id), xs = [], ys = [];
    (function walk(a) { typeof a[0] === 'number' ? (xs.push(a[0]), ys.push(a[1])) : a.forEach(walk); })(f.geometry.coordinates);
    map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: panelPadding(), maxZoom: 13 });
  }
}
function renderSelected() {
  const f = state.data.subs.features.find((x) => x.properties.id === state.selected);
  if (!f) return;
  const p = f.properties, u = state.wx?.units.find((x) => x.id === p.id), card = $('#card-selected');
  card.hidden = false;
  card.innerHTML = `<h3><span>${esc(p.label)}</span><button class="x" aria-label="Close">×</button></h3>
    <div class="grid3">
      <div class="tile"><i>Watch</i><b class="lvl-${u?.a.level ?? 0}">${u ? LEVELS[u.a.level].name : '—'}</b><u>${u?.a.why || 'below thresholds'}</u></div>
      <div class="tile"><i>Rain 24 h</i><b>${fmt(u?.a.r24, 1)} mm</b><u>${fmt(u?.a.r72, 1)} mm in 72 h</u></div>
      <div class="tile"><i>Snow depth</i><b>${fmt((u?.a.snow || 0) * 100)} cm</b><u>+${fmt(u?.a.snowfall72, 0)} cm in 72 h</u></div>
    </div>
    <canvas id="chart-sel" height="100" style="margin-top:8px"></canvas>
    <div class="stats" style="margin-top:8px">
      <div><i>Area</i><b>${fmt(p.area_km2, 1)} km²</b></div><div><i>Drains</i><b>${fmt(p.upstream_km2)} km²</b></div>
      <div><i>Elevation</i><b>${p.elev_min}–${p.elev_max} m</b></div><div><i>Mean</i><b>${p.elev_mean} m</b></div>
      <div><i>Buildings</i><b>${p.buildings.toLocaleString('en')}</b></div><div><i>Near channels</i><b>${p.exposed.toLocaleString('en')}</b></div>
    </div>
    ${p.villages.length ? `<p class="note">Villages: ${p.villages.slice(0, 12).map(esc).join(', ')}${p.villages.length > 12 ? '…' : ''}</p>` : ''}`;
  card.querySelector('.x').onclick = () => select(null);
  if (u) rainChart($('#chart-sel'), state.wx.time, state.wx.now, u.hourly.precipitation);
}

async function probe(lngLat) {
  map.getSource('probe').setData({ type: 'Feature', geometry: { type: 'Point', coordinates: [lngLat.lng, lngLat.lat] } });
  const head = `<h4>Point forecast</h4><div>${lngLat.lat.toFixed(4)}°N ${Math.abs(lngLat.lng).toFixed(4)}°W</div>`;
  showPopup(lngLat, `${head}<div class="muted">Loading…</div>`);
  popup.on('close', () => map.getSource('probe').setData(empty));
  try {
    const r = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lngLat.lat.toFixed(4)}&longitude=${lngLat.lng.toFixed(4)}&current=${CURRENT}&hourly=precipitation,snow_depth&forecast_days=3&timezone=${encodeURIComponent(TZ)}`);
    const i = Math.max(0, r.hourly.time.findIndex((t) => t.slice(0, 13) === r.current.time.slice(0, 13))), p = r.hourly.precipitation;
    popup.setHTML(`<div class="pop">${head}<dl><dt>Elevation</dt><dd>${fmt(r.elevation)} m</dd><dt>Now</dt><dd>${fmt(r.current.temperature_2m, 1)} °C · ${WMO[r.current.weather_code] || ''}</dd><dt>Gusts</dt><dd>${fmt(r.current.wind_gusts_10m)} km/h</dd><dt>Rain next 24 h</dt><dd>${fmt(sum(p.slice(i, i + 24)), 1)} mm</dd><dt>Rain next 48 h</dt><dd>${fmt(sum(p.slice(i, i + 48)), 1)} mm</dd><dt>Peak hour</dt><dd>${fmt(Math.max(...p.slice(i, i + 48)), 1)} mm</dd><dt>Snow depth</dt><dd>${fmt((r.hourly.snow_depth[i] || 0) * 100)} cm</dd></dl></div>`);
  } catch { popup.setHTML(`<div class="pop">${head}<div class="muted">Forecast feed unreachable.</div></div>`); }
}

let hovered = null;
map.on('mousemove', (e) => {
  $('#cursor').textContent = `${e.lngLat.lat.toFixed(4)}°N  ${Math.abs(e.lngLat.lng).toFixed(4)}°${e.lngLat.lng < 0 ? 'W' : 'E'}  z${map.getZoom().toFixed(1)}`;
  const f = map.queryRenderedFeatures(e.point, { layers: ['subs-fill'].filter((id) => map.getLayer(id)) })[0];
  const id = f?.id ?? null;
  if (id !== hovered) {
    if (hovered) map.setFeatureState({ source: 'subs', id: hovered }, { hover: false });
    if (id) map.setFeatureState({ source: 'subs', id }, { hover: true });
    hovered = id;
  }
  map.getCanvas().style.cursor = map.queryRenderedFeatures(e.point, { layers: ['quakes', 'historic', 'places', 'pois', 'subs-fill'] }).length ? 'pointer' : 'crosshair';
});
map.on('click', (e) => {
  const hits = map.queryRenderedFeatures(e.point, { layers: ['quakes', 'historic', 'places', 'pois', 'subs-fill'] });
  const f = hits[0];
  if (!f) return probe(e.lngLat);
  if (f.layer.id === 'quakes' || f.layer.id === 'historic') return quakePopup({ properties: f.properties, geometry: f.geometry });
  if (f.layer.id === 'places') return showPopup(f.geometry.coordinates, `<h4>${esc(f.properties.class || 'locality')}</h4><div>${esc(f.properties.name)}</div>${f.properties.population ? `<dl><dt>Population</dt><dd>${fmt(f.properties.population)}</dd></dl>` : ''}`);
  if (f.layer.id === 'pois') return showPopup(f.geometry.coordinates, `<h4>${esc((f.properties.category || 'place').replace(/_/g, ' '))}</h4><div>${esc(f.properties.name)}</div>`);
  if (e.originalEvent.shiftKey) return probe(e.lngLat);
  select(f.id === state.selected ? null : f.id);
});
map.on('contextmenu', (e) => probe(e.lngLat));

const segment = (sel, attr, fn) => document.querySelectorAll(`${sel} button`).forEach((b) => (b.onclick = () => {
  document.querySelectorAll(`${sel} button`).forEach((x) => x.classList.toggle('on', x === b));
  fn(b.dataset[attr]);
}));
segment('#metric', 'm', (m) => { state.metric = m; paintSubs(); });
segment('#basemap', 'b', (b) => { state.basemap = b; for (const k of Object.keys(BASEMAPS)) map.setLayoutProperty(`bm-${k}`, 'visibility', k === b ? 'visible' : 'none'); });
segment('#dim', 'd', (d) => {
  if (d === '3d') { map.setTerrain({ source: 'dem', exaggeration: 1.35 }); map.easeTo({ pitch: 62, bearing: 168, duration: 1200 }); }
  else { map.easeTo({ pitch: 0, bearing: 0, duration: 800 }); map.once('moveend', () => map.setTerrain(null)); }
});
$('#btn-home').onclick = () => fitBasin();
$('#btn-region').onclick = () => map.easeTo({ center: CENTER, zoom: 6.2, pitch: 0, bearing: 0 });
$('#sat-prev').onclick = () => shiftSat(-1);
$('#sat-next').onclick = () => shiftSat(1);
$('#alert-chip').onclick = () => { $('#intel').classList.add('open'); $('#card-status').scrollIntoView({ behavior: 'smooth' }); };
$('#btn-about').onclick = () => $('#about').showModal();
$('#about-close').onclick = () => $('#about').close();
$('#about').addEventListener('click', (e) => e.target === e.currentTarget && e.currentTarget.close());
for (const [btn, panel, other] of [['#btn-layers', '#layers', '#intel'], ['#btn-intel', '#intel', '#layers']]) {
  $(btn).onclick = () => {
    const open = $(panel).classList.toggle('open');
    $(other).classList.remove('open');
    $('#btn-layers').setAttribute('aria-expanded', $('#layers').classList.contains('open'));
    $('#btn-intel').setAttribute('aria-expanded', $('#intel').classList.contains('open'));
    if (open) redraw();
  };
}
function fillAbout() {
  const x = state.data.context;
  $('#about-area').textContent = fmt(state.data.basin?.area_km2, 1);
  $('#about-buf').textContent = x?.flood_buffer_m ?? '60';
  $('#about-chan').textContent = x?.flood_channel_km2 ?? '20';
  $('#about-thresholds').innerHTML = '<tr><th>Level</th><th>1 h</th><th>3 h</th><th>24 h</th></tr>' + LEVELS.slice(1).map((l) => `<tr><td style="color:${l.color}">${l.name}</td><td>≥ ${l.h1} mm</td><td>≥ ${l.h3} mm</td><td>≥ ${l.h24} mm</td></tr>`).join('');
}
function clock() {
  const now = new Date(), t = (tz) => now.toLocaleTimeString('en-GB', { timeZone: tz, hour12: false });
  $('#clock-local').textContent = t(TZ); $('#clock-utc').textContent = t('UTC');
}
function redraw() { if (state.wx) renderWeather(); if (state.flood) renderFlood(); renderTerrain(); }
let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(redraw, 150); });

setInterval(clock, 1000); clock(); renderFeeds();
map.once('style.load', async () => {
  await loadStatic();
  loadWeather(); loadFlood(); loadQuakes();
  setInterval(loadWeather, REFRESH.wx); setInterval(loadFlood, REFRESH.flood); setInterval(loadQuakes, REFRESH.quakes);
});
