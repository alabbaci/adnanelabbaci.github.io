/* Dakhla Watch — live coastal dashboard (static, no build step, no API keys).
 *
 * Static layers come from dakhla/data/ (see dakhla/pipeline/). Live feeds are
 * fetched straight from the browser: Open-Meteo (weather, marine, air quality),
 * USGS (earthquakes) and NASA GIBS (daily satellite tiles).
 */

const TZ = 'Africa/El_Aaiun';
const CITY = [-15.938, 23.705];
const QUAKE_RADIUS_KM = 700;
const REFRESH = { wx: 15 * 60e3, sea: 60 * 60e3, air: 60 * 60e3, quakes: 5 * 60e3 };
const KT = 1.852;                 // km/h per knot
const KITE_KT = 15;               // mean wind most kiters call "on"
const CHERGUI = [45, 160];        // wind from the desert: NE through SSE

/* Screening thresholds over the next 48 h. Index = watch level.
 * gust km/h · temp °C · rain mm in 24 h · wave m (Atlantic-facing sectors only). */
const LEVELS = [
  { name: 'LOW', color: '#4fbf8b' },
  { name: 'WATCH', color: '#e8c84c', gust: 55, temp: 32, rain: 5, wave: 3 },
  { name: 'ALERT', color: '#f08a3c', gust: 70, temp: 36, rain: 15, wave: 4 },
  { name: 'SEVERE', color: '#f0504a', gust: 90, temp: 40, rain: 30, wave: 5.5 },
];
const WIND_RAMP = [[0, '#12302f'], [20, '#17525a'], [30, '#1f7f8c'], [40, '#36b3c9'], [50, '#7fd0f0'], [65, '#f0e27a'], [85, '#f0504a']];
const HEAT_RAMP = [[0, '#1d3140'], [20, '#2f5a6a'], [24, '#4f9a8a'], [28, '#e8c84c'], [32, '#f08a3c'], [36, '#f0504a'], [40, '#b3261e']];
const RAIN_RAMP = [[0, '#12302f'], [0.2, '#17525a'], [1, '#1f7f8c'], [5, '#36b3c9'], [15, '#7fd0f0'], [30, '#f0e27a'], [60, '#f0504a']];
const METRICS = {
  wind: { ramp: WIND_RAMP, unit: 'km/h, peak gust next 48 h', value: (a) => a.gust },
  heat: { ramp: HEAT_RAMP, unit: '°C, warmest hour next 48 h', value: (a) => a.tmax },
  rain: { ramp: RAIN_RAMP, unit: 'mm, next 72 h', value: (a) => a.r72 },
};
const KIND = { peninsula: 'Peninsula', lagoon: 'Lagoon', shore: 'Mainland shore' };
const LAGOON_NAMES = ['Lagoon mouth', 'Central lagoon', 'Lagoon head'];
const SHORE_NAMES = ['East shore south', 'East shore north'];
const SETTLEMENT = new Set(['town', 'village', 'hamlet']);
const MINOR = new Set(['beach', 'wetland', 'peak']);   // labelled only once zoomed in

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

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (deg) => (deg == null ? '—' : COMPASS[Math.round(deg / 22.5) % 16]);
const kt = (kmh) => (kmh == null ? null : kmh / KT);
const signed = (v, d = 1) => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(d)}`;
/* Feeds are requested in GMT and shifted here, so every chart shares one local clock. */
const localFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const toLocal = (isoGMT) => localFmt.format(new Date(`${isoGMT}:00Z`)).replace(' ', 'T');
const nowIndex = (r) => Math.max(0, r.hourly.time.findIndex((t) => t.slice(0, 13) === r.current.time.slice(0, 13)));
const localise = (r) => { r.hourly.time = r.hourly.time.map(toLocal); r.current.time = toLocal(r.current.time); return r; };

const state = {
  data: {}, wx: null, sea: null, air: null, quakes: null, historic: null,
  metric: 'watch', selected: null, basemap: 'night',
  satDate: new Date(Date.now() - 86400e3),
  feeds: { WX: null, SEA: null, AIR: null, SEIS: null },
  labels: [],
};

/* ------------------------------------------------------------------ layers */
const LAYERS = [
  { id: 'area', group: 'Area', label: 'Watch area boundary', color: '#e8b44c', on: true, ids: ['area-glow', 'area-line'], count: () => { const a = state.data.area; return a ? `${fmt(a.peninsula_km2 + a.lagoon_km2 + a.shore_km2)} km²` : ''; } },
  { id: 'sectors', group: 'Area', label: 'Forecast sectors', color: '#4fbf8b', on: true, ids: ['sectors-fill', 'sectors-line'], count: () => state.data.sectors?.features.length },
  { id: 'shore', group: 'Area', label: 'Shoreline', color: '#36d6c9', on: true, ids: ['coast-atlantic', 'coast'], count: () => { const a = state.data.area; return a ? `${fmt(a.shoreline_atlantic_km + a.shoreline_lagoon_km)} km` : ''; } },
  { id: 'relief', group: 'Area', label: 'Relief shading', color: '#9aa7a4', on: true, ids: ['hillshade'] },
  { id: 'places', group: 'People', label: 'Localities & landmarks', color: '#ffffff', on: true, ids: ['places'], count: () => state.data.places?.features.length },
  { id: 'roads', group: 'People', label: 'Roads', color: '#c9b79a', on: true, ids: ['roads'], count: () => (state.data.context ? `${fmt(state.data.context.road_km)} km` : '') },
  { id: 'bld3d', group: 'People', label: 'Buildings · 3D, height ×3', color: '#8fa3a0', on: true, ids: ['bld3d'], count: () => state.data.bld3d?.features.length.toLocaleString('en') },
  { id: 'exposure', group: 'People', label: 'Buildings near shore', color: '#ff6b5e', on: true, ids: ['exposure'], count: () => state.data.exposure?.features.length },
  { id: 'pois', group: 'People', label: 'Points of interest', color: '#c79bff', on: false, ids: ['pois'], count: () => state.data.pois?.features.length },
  { id: 'quakes', group: 'Live', label: 'Earthquakes · 365 d', color: '#f08a3c', on: true, ids: ['quakes'], count: () => state.quakes?.features.length },
  { id: 'historic', group: 'Live', label: 'Historic M5+ · since 1900', color: '#f0504a', on: true, ids: ['historic'], count: () => state.historic?.features.length },
  { id: 'sst', group: 'Satellite', label: 'Sea temperature · MUR', color: '#f0a05a', on: false, ids: ['gibs-sst'], gibs: true },
  { id: 'truecolor', group: 'Satellite', label: 'True colour · MODIS', color: '#7fb37a', on: false, ids: ['gibs-true'], gibs: true },
];
const GIBS = {
  'gibs-sst': { layer: 'GHRSST_L4_MUR_Sea_Surface_Temperature', set: 'GoogleMapsCompatible_Level7', ext: 'png', maxzoom: 7, opacity: 0.8 },
  'gibs-true': { layer: 'MODIS_Terra_CorrectedReflectance_TrueColor', set: 'GoogleMapsCompatible_Level9', ext: 'jpg', maxzoom: 9, opacity: 1 },
};
const gibsTiles = (g) => [`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${g.layer}/default/${isoDay(state.satDate)}/${g.set}/{z}/{y}/{x}.${g.ext}`];
const TERRAIN_TILES = ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'];
const BASEMAPS = {
  night: { tiles: ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png`), maxzoom: 19, attribution: '© <a href="https://carto.com/attributions">CARTO</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
  sat: { tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], maxzoom: 18, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
  topo: { tiles: ['a', 'b', 'c'].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`), maxzoom: 17, attribution: '© <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA) © OpenStreetMap' },
};
const CLICKABLE = ['quakes', 'historic', 'places', 'pois', 'sectors-fill'];

const empty = { type: 'FeatureCollection', features: [] };
const style = {
  version: 8,
  sources: {
    ...Object.fromEntries(Object.entries(BASEMAPS).map(([k, b]) => [`bm-${k}`, { type: 'raster', tiles: b.tiles, tileSize: 256, maxzoom: b.maxzoom, attribution: b.attribution }])),
    dem: { type: 'raster-dem', tiles: TERRAIN_TILES, tileSize: 256, maxzoom: 14, encoding: 'terrarium', attribution: 'Terrain: Mapzen / AWS' },
    'dem-shade': { type: 'raster-dem', tiles: TERRAIN_TILES, tileSize: 256, maxzoom: 14, encoding: 'terrarium' },
    ...Object.fromEntries(Object.entries(GIBS).map(([k, g]) => [k, { type: 'raster', tiles: gibsTiles(g), tileSize: 256, maxzoom: g.maxzoom, attribution: 'NASA GIBS' }])),
    ...Object.fromEntries(['area', 'sectors', 'shore', 'places', 'roads', 'bld3d', 'exposure', 'pois', 'quakes', 'historic', 'probe'].map((k) => [k, { type: 'geojson', data: empty, promoteId: k === 'sectors' ? 'id' : undefined }])),
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#06090a' } },
    { id: 'bm-night', type: 'raster', source: 'bm-night', paint: { 'raster-opacity': 0.9 } },
    { id: 'bm-sat', type: 'raster', source: 'bm-sat', layout: { visibility: 'none' }, paint: { 'raster-saturation': -0.15, 'raster-brightness-max': 0.85 } },
    { id: 'bm-topo', type: 'raster', source: 'bm-topo', layout: { visibility: 'none' }, paint: { 'raster-brightness-max': 0.75, 'raster-saturation': -0.3 } },
    { id: 'gibs-true', type: 'raster', source: 'gibs-true', layout: { visibility: 'none' } },
    { id: 'hillshade', type: 'hillshade', source: 'dem-shade', paint: { 'hillshade-exaggeration': 0.42, 'hillshade-shadow-color': '#000a0c', 'hillshade-highlight-color': '#d9efe9', 'hillshade-accent-color': '#0d2a2c' } },
    { id: 'gibs-sst', type: 'raster', source: 'gibs-sst', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.8 } },
    { id: 'sectors-fill', type: 'fill', source: 'sectors', paint: { 'fill-color': ['coalesce', ['feature-state', 'color'], '#1b2a2a'], 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 11, ['case', ['boolean', ['feature-state', 'selected'], false], 0.62, ['boolean', ['feature-state', 'hover'], false], 0.5, 0.34], 13.5, ['case', ['boolean', ['feature-state', 'selected'], false], 0.4, ['boolean', ['feature-state', 'hover'], false], 0.28, 0.14]] } },
    { id: 'sectors-line', type: 'line', source: 'sectors', paint: { 'line-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#36d6c9', 'rgba(255,255,255,0.28)'], 'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 2.2, 0.7] } },
    { id: 'area-glow', type: 'line', source: 'area', paint: { 'line-color': '#e8b44c', 'line-width': 9, 'line-blur': 8, 'line-opacity': 0.45 } },
    { id: 'area-line', type: 'line', source: 'area', paint: { 'line-color': '#e8b44c', 'line-width': 1.8, 'line-dasharray': [3, 1.5] } },
    { id: 'roads', type: 'line', source: 'roads', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#c9b79a', 'line-opacity': ['match', ['get', 'class'], ['residential', 'unclassified'], 0.4, 0.75], 'line-width': ['match', ['get', 'class'], ['trunk', 'primary'], 2.2, 'secondary', 1.7, 'tertiary', 1.2, 0.6] } },
    { id: 'coast-atlantic', type: 'line', source: 'shore', filter: ['==', ['get', 'side'], 'atlantic'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#36d6c9', 'line-width': 9, 'line-blur': 7, 'line-opacity': 0.4 } },
    { id: 'coast', type: 'line', source: 'shore', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['match', ['get', 'side'], 'atlantic', '#9ff3ea', '#36d6c9'], 'line-width': ['match', ['get', 'side'], 'atlantic', 1.8, 1.1], 'line-opacity': 0.9 } },
    { id: 'bld3d', type: 'fill-extrusion', source: 'bld3d', minzoom: 11.5, paint: { 'fill-extrusion-color': ['interpolate', ['linear'], ['get', 'calculated_height'], 3, '#40514f', 12, '#7d9390', 30, '#c9dbd7'], 'fill-extrusion-height': ['*', 3, ['get', 'calculated_height']], 'fill-extrusion-opacity': 0.9 } },
    { id: 'exposure', type: 'circle', source: 'exposure', minzoom: 10.5, paint: { 'circle-color': '#ff6b5e', 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10.5, 1, 14, 3], 'circle-opacity': 0.85 } },
    { id: 'pois', type: 'circle', source: 'pois', layout: { visibility: 'none' }, paint: { 'circle-color': '#c79bff', 'circle-radius': 3, 'circle-stroke-color': '#06090a', 'circle-stroke-width': 1 } },
    { id: 'places', type: 'circle', source: 'places', paint: { 'circle-color': '#ffffff', 'circle-radius': ['match', ['get', 'class'], 'town', 4.5, 'village', 3, 2], 'circle-stroke-color': '#06090a', 'circle-stroke-width': 1.2, 'circle-opacity': ['case', ['get', 'in_area'], 1, 0.45] } },
    { id: 'historic', type: 'circle', source: 'historic', paint: { 'circle-color': 'rgba(240,80,74,0.08)', 'circle-stroke-color': '#f0504a', 'circle-stroke-width': 1.4, 'circle-radius': ['interpolate', ['exponential', 1.6], ['get', 'mag'], 5, 7, 7, 26] } },
    { id: 'quakes', type: 'circle', source: 'quakes', paint: { 'circle-color': '#f08a3c', 'circle-opacity': 0.75, 'circle-stroke-color': '#06090a', 'circle-stroke-width': 1, 'circle-radius': ['interpolate', ['exponential', 1.6], ['get', 'mag'], 2.5, 3.5, 6, 18] } },
    { id: 'probe', type: 'circle', source: 'probe', paint: { 'circle-radius': 6, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } },
  ],
};

const map = new maplibregl.Map({
  container: 'map', style, center: [-15.86, 23.77], zoom: 9.8, maxZoom: 17, minZoom: 3, maxPitch: 75,
  attributionControl: { compact: true }, hash: true,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
window.__map = map;

const panelPadding = () => (innerWidth > 900 ? { top: 70, bottom: 60, left: 280, right: 370 } : { top: 110, bottom: 90, left: 20, right: 20 });
const fitArea = (animate = true) => {
  const b = state.data.area?.bbox;
  if (b) map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: panelPadding(), animate, pitch: map.getPitch(), bearing: map.getBearing() });
};

/* ------------------------------------------------------------ static data */
async function loadStatic() {
  const names = { area: 'area.json', outline: 'area.geojson', sectors: 'sectors.geojson', shore: 'shoreline.geojson', places: 'places.geojson', roads: 'roads.geojson', exposure: 'exposure.geojson', pois: 'pois.geojson', context: 'context.json' };
  await Promise.all(Object.entries(names).map(async ([k, f]) => {
    try { state.data[k] = await getJSON(`data/${f}`); } catch (e) { console.warn('missing', f, e.message); state.data[k] = f.endsWith('geojson') ? empty : null; }
  }));
  const d = state.data;
  for (const f of d.sectors.features) {
    const p = f.properties, c = d.context?.sectors?.[p.id] || {}, n = +p.id.slice(1) - 1;
    Object.assign(p, { buildings: c.buildings || 0, exposed: c.exposed || 0, pois: c.pois || 0, places: c.places || [] });
    const name = p.kind === 'lagoon' ? LAGOON_NAMES[n] : p.kind === 'shore' ? SHORE_NAMES[n] : p.places[0] || `km ${fmt(p.km_from)}–${fmt(p.km_to)}`;
    p.label = `${p.id} · ${name || KIND[p.kind]}`;
  }
  map.getSource('area').setData(d.outline);
  for (const k of ['sectors', 'shore', 'places', 'roads', 'exposure', 'pois']) map.getSource(k).setData(d[k]);
  addLabels();
  renderLayers();
  renderTerrain();
  fillAbout();
  if (!location.hash) fitArea(false);
  // The 3D building footprints are shared with the heat-trap scene at the site root.
  getJSON('../data/processed/dakhla_buildings_3d.geojson').then((b) => { d.bld3d = b; map.getSource('bld3d').setData(b); renderLayers(); }).catch((e) => console.warn('3D buildings unavailable', e.message));
}

function addLabels() {
  const d = state.data;
  const mk = (lngLat, text, cls) => state.labels.push(new maplibregl.Marker({ element: el('div', { class: `place-label${cls ? ` ${cls}` : ''}` }, esc(text)), anchor: 'bottom' }).setLngLat(lngLat).addTo(map));
  const seen = new Set();
  for (const f of d.places.features) {
    const p = f.properties, n = (p.name || '').trim();
    if (!n || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    mk(f.geometry.coordinates, n, p.class === 'town' ? 'key' : SETTLEMENT.has(p.class) ? '' : MINOR.has(p.class) ? 'mark minor' : 'mark');
  }
  if (d.area) {
    mk([d.area.marine.lon, d.area.marine.lat], '◆ Marine forecast point', 'key');
  }
  const z = () => { document.body.classList.toggle('zoom-far', map.getZoom() < 9.3); document.body.classList.toggle('zoom-mid', map.getZoom() < 11.6); };
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
const HOURLY = 'wind_speed_10m,wind_gusts_10m,wind_direction_10m,temperature_2m,apparent_temperature,precipitation,relative_humidity_2m';
const CURRENT = 'temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,relative_humidity_2m';
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
function peak(values, from, to) {
  let v = -Infinity, i = from;
  for (let k = from; k < to; k++) if (values[k] != null && values[k] > v) { v = values[k]; i = k; }
  return { v: v === -Infinity ? null : v, i };
}
function assess(u, now, sea) {
  const h = u.hourly, end = Math.min(h.time.length, now + 48);
  const gust = peak(h.wind_gusts_10m, now, end), temp = peak(h.temperature_2m, now, end), rain = maxWindow(h.precipitation, now, end, 24);
  const signals = [
    { k: 'gust', v: gust.v, t: h.time[gust.i], text: `gusts ${fmt(gust.v)} km/h` },
    { k: 'temp', v: temp.v, t: h.time[temp.i], text: `${fmt(temp.v, 1)} °C` },
    { k: 'rain', v: rain.v, t: h.time[rain.i], text: `${fmt(rain.v, rain.v < 10 ? 1 : 0)} mm in 24 h` },
  ];
  if (u.p.atlantic && sea?.peak48.v != null) signals.push({ k: 'wave', v: sea.peak48.v, t: sea.peak48.t, text: `${fmt(sea.peak48.v, 1)} m waves` });
  let level = 0, why = '', peakTime = h.time[gust.i];
  for (const s of signals) {
    let L = 0;
    for (let i = 1; i < LEVELS.length; i++) if (s.v >= LEVELS[i][s.k]) L = i;
    if (L > level) { level = L; why = s.text; peakTime = s.t; }
  }
  return {
    level, why, peakTime, gust: gust.v, tmax: temp.v, tmaxTime: h.time[temp.i], r24max: rain.v,
    r24: sum(h.precipitation.slice(now, now + 24)), r72: sum(h.precipitation.slice(now, now + 72)),
  };
}
function evaluate() {
  const wx = state.wx;
  if (!wx) return;
  for (const u of wx.units) u.a = assess(u, wx.now, state.sea);
  wx.level = Math.max(...wx.units.map((u) => u.a.level));
}

async function loadWeather() {
  const secs = state.data.sectors.features;
  if (!secs.length) return;
  const q = (k) => secs.map((f) => f.properties[k]).join(',');
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${q('pt_lat')}&longitude=${q('pt_lon')}&hourly=${HOURLY}&current=${CURRENT}&past_days=1&forecast_days=7&timezone=GMT`;
    let res = await getJSON(url);
    if (!Array.isArray(res)) res = [res];
    const now = nowIndex(res[0]);
    res.forEach(localise);
    const time = res[0].hourly.time;
    const total = sum(secs.map((f) => f.properties.area_km2));
    const units = secs.map((f, i) => ({ id: f.properties.id, p: f.properties, hourly: res[i].hourly, current: res[i].current }));
    const each = (key, fn) => time.map((_, t) => fn(units.map((u) => u.hourly[key][t])));
    state.wx = {
      time, now, units, fetched: Date.now(),
      meanWind: time.map((_, t) => sum(units.map((u) => (u.hourly.wind_speed_10m[t] || 0) * u.p.area_km2)) / total),
      maxGust: each('wind_gusts_10m', (v) => Math.max(...v.map((x) => x || 0))),
      tLo: each('temperature_2m', (v) => Math.min(...v.filter((x) => x != null))),
      tHi: each('temperature_2m', (v) => Math.max(...v.filter((x) => x != null))),
      tMean: time.map((_, t) => sum(units.map((u) => (u.hourly.temperature_2m[t] || 0) * u.p.area_km2)) / total),
      level: 0,
    };
    state.feeds.WX = true;
  } catch (e) { console.warn(e); state.feeds.WX = false; }
  renderWeather();
}

async function loadSea() {
  const m = state.data.area?.marine;
  if (!m) return;
  try {
    const r = await getJSON(`https://marine-api.open-meteo.com/v1/marine?latitude=${m.lat}&longitude=${m.lon}&hourly=wave_height,swell_wave_height,wave_period,wave_direction,sea_surface_temperature,sea_level_height_msl&current=wave_height,wave_period,wave_direction,sea_surface_temperature&past_days=1&forecast_days=7&timezone=GMT`);
    const now = nowIndex(r);
    localise(r);
    const h = r.hourly, p48 = peak(h.wave_height, now, Math.min(h.time.length, now + 48));
    state.sea = { time: h.time, now, h, current: r.current, peak48: { v: p48.v, t: h.time[p48.i] } };
    state.feeds.SEA = true;
  } catch (e) { console.warn(e); state.feeds.SEA = false; }
  renderSea();
  if (state.wx) renderWeather();
}

async function loadAir() {
  try {
    const r = await getJSON(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${CITY[1]}&longitude=${CITY[0]}&hourly=dust&current=dust,pm10,aerosol_optical_depth&forecast_days=3&timezone=GMT`);
    const now = nowIndex(r);
    localise(r);
    const p = peak(r.hourly.dust, now, Math.min(r.hourly.time.length, now + 48));
    state.air = { current: r.current, peak: { v: p.v, t: r.hourly.time[p.i] } };
    state.feeds.AIR = true;
  } catch (e) { console.warn(e); state.feeds.AIR = false; }
  renderFeeds();
  if (state.wx) { renderHeat(); renderTicker(); }
}

/* ---------------------------------------------------------------- colours */
const rampColor = (ramp, v) => {
  for (let i = ramp.length - 1; i >= 0; i--) if (v >= ramp[i][0]) return ramp[i][1];
  return ramp[0][1];
};
function paintSectors() {
  const m = state.metric;
  for (const f of state.data.sectors.features) {
    const u = state.wx?.units.find((x) => x.id === f.properties.id);
    let color = '#1b2a2a';
    if (u) color = m === 'watch' ? LEVELS[u.a.level].color : rampColor(METRICS[m].ramp, METRICS[m].value(u.a));
    map.setFeatureState({ source: 'sectors', id: f.properties.id }, { color });
  }
  const lg = $('#legend');
  if (m === 'watch') lg.innerHTML = `<div class="ramp">${LEVELS.map((l) => `<i style="background:${l.color}"></i>`).join('')}</div><div class="ticks">${LEVELS.map((l) => `<span>${l.name}</span>`).join('')}</div>`;
  else {
    const r = METRICS[m].ramp;
    lg.innerHTML = `<div class="ramp">${r.map((s) => `<i style="background:${s[1]}"></i>`).join('')}</div><div class="ticks">${r.map((s) => `<span>${s[0]}</span>`).join('')}</div><div style="margin-top:4px;color:var(--ink-3)">${METRICS[m].unit}</div>`;
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
function barChart(canvas, time, now, bars, envelope, floor = 20) {
  const { c, w, h } = setup(canvas), pad = { l: 26, r: 4, t: 16, b: 14 };
  const ymax = niceMax(Math.max(...(envelope || bars)), floor), n = time.length;
  const x = (i) => pad.l + ((w - pad.l - pad.r) * i) / n, y = (v) => pad.t + (h - pad.t - pad.b) * (1 - Math.min(v, ymax) / ymax);
  axes(c, w, h, pad, ymax);
  dayTicks(c, time, x, h, pad);
  const bw = Math.max(1, (w - pad.l - pad.r) / n - 0.4);
  if (envelope) { c.fillStyle = 'rgba(54,214,201,0.22)'; envelope.forEach((v, i) => v > 0 && c.fillRect(x(i), y(v), bw, y(0) - y(v))); }
  bars.forEach((v, i) => { if (v > 0) { c.fillStyle = i < now ? 'rgba(54,214,201,0.45)' : css('--water'); c.fillRect(x(i), y(v), bw, y(0) - y(v)); } });
  nowLine(c, x(now), h, pad);
}
function lineChart(canvas, { xs, series, nowIdx, ymax, yfmt, labels, band, bandColor }) {
  const { c, w, h } = setup(canvas), pad = { l: 34, r: 4, t: 16, b: 14 };
  const n = xs.length, x = (i) => pad.l + ((w - pad.l - pad.r) * i) / Math.max(1, n - 1), y = (v) => pad.t + (h - pad.t - pad.b) * (1 - Math.min(v, ymax) / ymax);
  axes(c, w, h, pad, ymax, yfmt);
  if (band) {
    c.fillStyle = bandColor || 'rgba(54,214,201,0.16)'; c.beginPath();
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
const windText = (speed, dir, gust) => `${compass(dir)} ${fmt(speed)} km/h (${fmt(kt(speed))} kt)${gust == null ? '' : `, gusts ${fmt(gust)}`}`;
const cityUnit = () => [...state.wx.units].sort((a, b) => b.p.buildings - a.p.buildings)[0];
const lagoonUnit = () => state.wx.units.filter((u) => u.p.kind === 'lagoon').pop() || state.wx.units[0];

function renderWeather() {
  renderFeeds();
  const wx = state.wx;
  if (!wx) {
    $('#status-body').textContent = 'Forecast feed unreachable — retrying.';
    $('#now-body').textContent = '—';
    return;
  }
  evaluate();
  paintSectors();
  const L = LEVELS[wx.level], worst = [...wx.units].sort((a, b) => b.a.level - a.a.level || b.a.gust - a.a.gust);
  const chip = $('#alert-chip');
  chip.className = `chip lvl-${wx.level}`; chip.textContent = `COASTAL WATCH · ${L.name}`;
  const flagged = wx.units.filter((u) => u.a.level > 0).length, top = worst[0];
  $('#status-body').className = '';
  $('#status-body').innerHTML = `
    <div class="big lvl-${wx.level}"><b>${L.name}</b><span>${wx.level ? `${flagged} of ${wx.units.length} sectors flagged` : 'no sector reaches a threshold'}</span></div>
    <p class="why">${wx.level
      ? `Strongest signal: <b>${esc(top.p.label)}</b>, ${top.a.why}, around ${localTime(top.a.peakTime)}.`
      : `Windiest sector: ${esc(top.p.label)} with gusts up to ${fmt(top.a.gust)} km/h.`}</p>
    <div class="sblist">${worst.map((u) => `<button class="sbrow lvl-${u.a.level}" data-sb="${u.id}"><i></i><span>${esc(u.p.label)}</span><em>${fmt(u.a.gust)} km/h</em><u>${fmt(u.a.tmax, 1)} °C</u></button>`).join('')}</div>`;
  $('#status-body').querySelectorAll('[data-sb]').forEach((b) => (b.onclick = () => select(b.dataset.sb, true)));

  const city = cityUnit(), lag = lagoonUnit(), sea = state.sea;
  $('#now-time').textContent = `${city.current.time.slice(11)} local`;
  $('#now-body').className = 'grid3';
  $('#now-body').innerHTML = `
    <div class="tile"><i>City · ${city.id}</i><b>${fmt(city.current.temperature_2m, 1)}°</b><u>${WMO[city.current.weather_code] || '—'}<br>feels ${fmt(city.current.apparent_temperature)}° · RH ${fmt(city.current.relative_humidity_2m)}%</u></div>
    <div class="tile"><i>Lagoon · ${lag.id}</i><b>${fmt(kt(lag.current.wind_speed_10m))} <small>kt</small></b><u>${compass(lag.current.wind_direction_10m)} ${fmt(lag.current.wind_speed_10m)} km/h<br>gust ${fmt(lag.current.wind_gusts_10m)} km/h</u></div>
    <div class="tile"><i>Atlantic</i><b>${sea ? `${fmt(sea.current.wave_height, 1)} <small>m</small>` : '—'}</b><u>${sea ? `${fmt(sea.current.wave_period)} s from ${compass(sea.current.wave_direction)}<br>sea ${fmt(sea.current.sea_surface_temperature, 1)} °C` : 'sea feed loading'}</u></div>`;

  barChart($('#chart-wind'), wx.time, wx.now, wx.meanWind, wx.maxGust);
  const days = {};
  wx.time.forEach((t, i) => { if (i >= wx.now - (wx.now % 24)) days[t.slice(0, 10)] = Math.max(days[t.slice(0, 10)] || 0, wx.maxGust[i]); });
  $('#wind-days').innerHTML = Object.entries(days).slice(0, 7).map(([d, v]) => `<div>${new Date(`${d}T12:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })}<b>${fmt(v)}</b></div>`).join('');
  const lw = lag.hourly.wind_speed_10m.slice(wx.now, wx.now + 72), on = lw.filter((v) => kt(v) >= KITE_KT).length;
  $('#wind-note').innerHTML = `Bars: mean wind; shade: strongest gust in any sector. Boxes: peak gust per day. Lagoon now <b>${windText(lag.current.wind_speed_10m, lag.current.wind_direction_10m, lag.current.wind_gusts_10m)}</b>; mean wind at or above ${KITE_KT} kt there for ${on} of the next ${lw.length} h.`;

  renderHeat();
  if (state.selected) renderSelected();
  renderTicker();
}

function renderHeat() {
  const wx = state.wx;
  if (!wx) return;
  const from = wx.now, to = Math.min(wx.time.length, wx.now + 96), cut = (a) => a.slice(from, to);
  const mean = cut(wx.tMean), hi = cut(wx.tHi), lo = cut(wx.tLo), T = LEVELS[1].temp;
  lineChart($('#chart-heat'), {
    xs: mean, ymax: Math.max(...hi) > 40 ? 50 : 40, yfmt: (v) => fmt(v), nowIdx: 0,
    band: { hi, lo }, bandColor: 'rgba(240,138,60,0.2)',
    series: [
      { values: mean.map(() => T), color: 'rgba(232,200,76,0.6)', dash: [3, 3], width: 1 },
      { values: mean, color: '#f08a3c', width: 1.8 },
    ],
    labels: [[mean.length - 1, '+96 h', 'right'], [Math.floor(mean.length / 2), '+48 h']],
  });
  const city = cityUnit(), hot = [...wx.units].map((u) => ({ u, p: peak(u.hourly.temperature_2m, from, to) })).sort((a, b) => b.p.v - a.p.v)[0];
  const dirs = cut(city.hourly.wind_direction_10m), east = dirs.filter((d) => d >= CHERGUI[0] && d <= CHERGUI[1]).length;
  const air = state.air;
  $('#heat-note').innerHTML = `City now <b>${fmt(city.current.temperature_2m, 1)} °C</b>, feels ${fmt(city.current.apparent_temperature, 1)}. Warmest in 96 h: <b>${fmt(hot.p.v, 1)} °C</b> in ${esc(hot.u.p.label)}, ${localTime(hot.u.hourly.time[hot.p.i])}. Wind off the desert (${compass(CHERGUI[0])} to ${compass(CHERGUI[1])}) for ${east} of the next ${dirs.length} h. ` +
    (air ? `Dust now <b>${fmt(air.current.dust)} µg/m³</b>, PM10 ${fmt(air.current.pm10)}, aerosol depth ${fmt(air.current.aerosol_optical_depth, 2)}; dust peaks at ${fmt(air.peak.v)} µg/m³ ${localTime(air.peak.t)}. ` : '') +
    `Line: area mean; band: coolest to warmest sector; dashed: ${T} °C watch threshold.`;
}

function tides(h, now) {
  const z = h.sea_level_height_msl, out = {};
  if (!z) return out;
  for (let k = Math.max(1, now + 1); k < z.length - 1 && !(out.high && out.low); k++) {
    if (z[k] == null || z[k - 1] == null || z[k + 1] == null) continue;
    if (!out.high && z[k] >= z[k - 1] && z[k] > z[k + 1]) out.high = { v: z[k], t: h.time[k] };
    if (!out.low && z[k] <= z[k - 1] && z[k] < z[k + 1]) out.low = { v: z[k], t: h.time[k] };
  }
  return out;
}
function renderSea() {
  renderFeeds();
  const s = state.sea;
  if (!s) { $('#sea-note').textContent = 'Marine feed unreachable — retrying.'; return; }
  const wave = s.h.wave_height, swell = s.h.swell_wave_height.map((v, i) => Math.min(v ?? wave[i], wave[i] ?? v));
  const ymax = niceMax(Math.max(...wave.filter((v) => v != null)), 2);
  const mid = s.time.findIndex((t, i) => i > s.now + 60 && t.endsWith('T00:00'));
  lineChart($('#chart-sea'), {
    xs: s.time, ymax, yfmt: (v) => fmt(v, 1), nowIdx: s.now,
    band: { hi: wave, lo: swell }, series: [{ values: wave, color: css('--water'), width: 1.8 }],
    labels: [[0, s.time[0].slice(5, 10), 'left'], ...(mid > 0 ? [[mid, s.time[mid].slice(5, 10)]] : []), [s.time.length - 1, s.time[s.time.length - 1].slice(5, 10), 'right']],
  });
  const p = peak(wave, s.now, wave.length), td = tides(s.h, s.now), c = s.current;
  $('#sea-note').innerHTML = `Now <b>${fmt(c.wave_height, 1)} m</b> at ${fmt(c.wave_period)} s from ${compass(c.wave_direction)}, sea surface ${fmt(c.sea_surface_temperature, 1)} °C. Highest in the forecast: <b>${fmt(p.v, 1)} m</b>, ${localTime(s.time[p.i])}. ` +
    (td.high && td.low ? `Tide (model): ${[['high', td.high], ['low', td.low]].sort((a, b) => (a[1].t < b[1].t ? -1 : 1)).map(([n, x]) => `${n} ${localTime(x.t)} (${signed(x.v)} m)`).join(', then ')}. ` : '') +
    'Line: significant wave height; band: the share above the swell is local wind sea. Open-ocean model: the lagoon is sheltered, and tide times are hourly, not for navigation.';
  renderTicker();
}

async function loadQuakes() {
  const base = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&latitude=${CITY[1]}&longitude=${CITY[0]}&maxradiuskm=${QUAKE_RADIUS_KM}&orderby=time`;
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
  return `<button class="quake" data-q="${f.id}"><b class="${p.mag >= 5 ? 'm5' : ''}">M ${fmt(p.mag, 1)}</b><span title="${esc(p.place)}">${esc(p.place || 'Unnamed')}</span><em>${fmt(km(CITY, c))} km · ${ago(p.time)}</em></button>`;
}
function renderQuakes() {
  renderFeeds(); renderLayers();
  const box = $('#quake-body');
  if (!state.quakes) { box.textContent = 'Earthquake feed unreachable — retrying.'; return; }
  box.className = '';
  const recent = state.quakes.features, hist = [...state.historic.features].sort((a, b) => b.properties.mag - a.properties.mag);
  box.innerHTML = `<div class="sub">Past 365 days · M 2.5+ · ${recent.length} event${recent.length === 1 ? '' : 's'}</div>` +
    (recent.length ? recent.slice(0, 6).map(quakeRow).join('') : '<p class="note">No catalogued events in the past year. This stretch of the Saharan margin is seismically quiet; the nearest active zone is the Canary Islands.</p>') +
    `<div class="sub">Largest on record · M 5+ since 1900 · ${hist.length}</div>` + (hist.length ? hist.slice(0, 4).map(quakeRow).join('') : '<p class="note">None in the USGS catalogue.</p>');
  box.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => {
    const f = [...recent, ...hist].find((x) => x.id === b.dataset.q);
    map.flyTo({ center: f.geometry.coordinates, zoom: 7.5 });
    quakePopup(f);
  }));
  renderTicker();
}
let popup;
const showPopup = (lngLat, html) => { popup?.remove(); popup = new maplibregl.Popup({ offset: 10, maxWidth: '260px' }).setLngLat(lngLat).setHTML(`<div class="pop">${html}</div>`).addTo(map); };
function quakePopup(f) {
  const p = f.properties, c = f.geometry.coordinates;
  showPopup(c, `<h4>M ${fmt(p.mag, 1)} earthquake</h4><div>${esc(p.place)}</div><dl><dt>Time (UTC)</dt><dd>${new Date(p.time).toISOString().slice(0, 16).replace('T', ' ')}</dd><dt>Depth</dt><dd>${fmt(c[2])} km</dd><dt>From Dakhla</dt><dd>${fmt(km(CITY, c))} km</dd></dl><a href="${esc(p.url)}" target="_blank" rel="noopener">USGS event page ↗</a>`);
}

function renderTerrain() {
  const a = state.data.area, x = state.data.context;
  if (!a) return;
  $('#terrain-stats').innerHTML = [
    ['Peninsula', `${fmt(a.peninsula_km2, 1)} km²`], ['Lagoon', `${fmt(a.lagoon_km2)} km²`], ['Length', `${fmt(a.length_km, 1)} km`], ['Mean width', `${fmt(a.width_mean_km, 1)} km`],
    ['Highest', `${a.elev_max} m`], ['Shoreline', `${fmt(a.shoreline_atlantic_km + a.shoreline_lagoon_km)} km`], ['Buildings', x ? x.buildings.toLocaleString('en') : '—'], ['Near shore', x ? x.exposed_buildings.toLocaleString('en') : '—'],
  ].map(([k, v]) => `<div><i>${k}</i><b>${v}</b></div>`).join('');
  const pr = a.profile, dmax = pr[pr.length - 1][0], N = 80;
  const at = (col) => Array.from({ length: N + 1 }, (_, i) => { const d = (dmax * i) / N; const j = pr.findIndex((p) => p[0] >= d); return pr[Math.max(0, j)][col]; });
  const top = at(2), mean = at(1);
  lineChart($('#chart-profile'), {
    xs: top, ymax: niceMax(a.elev_max, 10), yfmt: (v) => fmt(v),
    series: [{ values: mean, color: 'rgba(232,180,76,0.55)', dash: [3, 3], width: 1.2 }, { values: top, color: css('--gold'), width: 1.8 }],
    labels: [[0, 'tip', 'left'], [Math.round((N * 9.5) / dmax), 'city'], [N, `${fmt(dmax)} km`, 'right']],
  });
  const { c, w, h } = setup($('#chart-hyps')), hy = a.hypsometry, n = hy.from_m.length, mx = Math.max(...hy.area_km2);
  const bw = (w - 4) / n;
  hy.from_m.forEach((lo, i) => {
    const bh = ((h - 26) * hy.area_km2[i]) / mx;
    c.fillStyle = 'rgba(232,180,76,0.75)'; c.fillRect(2 + i * bw, h - 14 - bh, bw - 2, Math.max(bh, hy.area_km2[i] > 0 ? 1 : 0));
    c.fillStyle = css('--ink-3'); c.textAlign = 'center';
    c.fillText(`${lo}–${lo + hy.band_m}${i === n - 1 ? ' m' : ''}`, 2 + i * bw + bw / 2, h - 2);
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
    const lag = lagoonUnit(), city = cityUnit();
    items.push([LEVELS[wx.level].color, `COASTAL WATCH ${LEVELS[wx.level].name}`]);
    for (const u of wx.units.filter((x) => x.a.level > 0)) items.push([LEVELS[u.a.level].color, `${u.p.label}: ${u.a.why}, ~${localTime(u.a.peakTime)}`]);
    items.push(['#36d6c9', `Lagoon wind ${windText(lag.current.wind_speed_10m, lag.current.wind_direction_10m, lag.current.wind_gusts_10m)}`]);
    items.push(['#f08a3c', `City ${fmt(city.current.temperature_2m, 1)} °C · peak gust next 48 h ${fmt(Math.max(...wx.units.map((u) => u.a.gust)))} km/h`]);
  }
  const s = state.sea;
  if (s) items.push(['#36d6c9', `Atlantic ${fmt(s.current.wave_height, 1)} m at ${fmt(s.current.wave_period)} s from ${compass(s.current.wave_direction)} · sea ${fmt(s.current.sea_surface_temperature, 1)} °C`]);
  if (state.air) items.push(['#e8b44c', `Dust ${fmt(state.air.current.dust)} µg/m³ · PM10 ${fmt(state.air.current.pm10)}`]);
  for (const f of state.quakes?.features.slice(0, 4) || []) items.push(['#f08a3c', `M${fmt(f.properties.mag, 1)} ${f.properties.place} · ${ago(f.properties.time)}`]);
  $('#ticker-items').innerHTML = items.map(([c, t]) => `<span style="--c:${c}">${esc(t)}</span>`).join('');
}

/* ---------------------------------------------------------- interactions */
function select(id, fly) {
  if (state.selected) map.setFeatureState({ source: 'sectors', id: state.selected }, { selected: false });
  state.selected = id;
  const card = $('#card-selected');
  if (!id) { card.hidden = true; return; }
  map.setFeatureState({ source: 'sectors', id }, { selected: true });
  renderSelected();
  $('#intel').scrollTo({ top: 0, behavior: 'smooth' });
  if (fly) {
    const f = state.data.sectors.features.find((x) => x.properties.id === id), xs = [], ys = [];
    (function walk(a) { typeof a[0] === 'number' ? (xs.push(a[0]), ys.push(a[1])) : a.forEach(walk); })(f.geometry.coordinates);
    map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: panelPadding(), maxZoom: 13.5 });
  }
}
function renderSelected() {
  const f = state.data.sectors.features.find((x) => x.properties.id === state.selected);
  if (!f) return;
  const p = f.properties, u = state.wx?.units.find((x) => x.id === p.id), card = $('#card-selected'), water = p.kind === 'lagoon';
  card.hidden = false;
  card.innerHTML = `<h3><span>${esc(p.label)}</span><button class="x" aria-label="Close">×</button></h3>
    <div class="grid3">
      <div class="tile"><i>Watch</i><b class="lvl-${u?.a.level ?? 0}">${u ? LEVELS[u.a.level].name : '—'}</b><u>${u?.a.why || 'below thresholds'}</u></div>
      <div class="tile"><i>Gust 48 h</i><b>${fmt(u?.a.gust)} <small>km/h</small></b><u>now ${u ? `${compass(u.current.wind_direction_10m)} ${fmt(kt(u.current.wind_speed_10m))} kt` : '—'}</u></div>
      <div class="tile"><i>Warmest 48 h</i><b>${fmt(u?.a.tmax, 1)}°</b><u>rain ${fmt(u?.a.r72, 1)} mm in 72 h</u></div>
    </div>
    <canvas id="chart-sel" height="100" style="margin-top:8px"></canvas>
    <div class="stats" style="margin-top:8px">
      <div><i>Type</i><b>${KIND[p.kind]}</b></div><div><i>Area</i><b>${fmt(p.area_km2, 1)} km²</b></div>
      <div><i>Along axis</i><b>km ${fmt(p.km_from)}–${fmt(p.km_to)}</b></div><div><i>${water ? 'Surface' : 'Mean / high'}</i><b>${water ? 'open water' : `${p.elev_mean} / ${p.elev_max} m`}</b></div>
      <div><i>Buildings</i><b>${p.buildings.toLocaleString('en')}</b></div><div><i>Near shore</i><b>${p.exposed.toLocaleString('en')}</b></div>
    </div>
    ${p.places.length ? `<p class="note">Places: ${p.places.slice(0, 12).map(esc).join(', ')}${p.places.length > 12 ? '…' : ''}</p>` : ''}`;
  card.querySelector('.x').onclick = () => select(null);
  if (u) barChart($('#chart-sel'), state.wx.time, state.wx.now, u.hourly.wind_speed_10m, u.hourly.wind_gusts_10m.map((v) => v || 0));
}

async function probe(lngLat) {
  map.getSource('probe').setData({ type: 'Feature', geometry: { type: 'Point', coordinates: [lngLat.lng, lngLat.lat] } });
  const head = `<h4>Point forecast</h4><div>${lngLat.lat.toFixed(4)}°N ${Math.abs(lngLat.lng).toFixed(4)}°W</div>`;
  showPopup(lngLat, `${head}<div class="muted">Loading…</div>`);
  popup.on('close', () => map.getSource('probe').setData(empty));
  try {
    const r = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lngLat.lat.toFixed(4)}&longitude=${lngLat.lng.toFixed(4)}&current=${CURRENT}&hourly=precipitation,wind_gusts_10m,temperature_2m&forecast_days=3&timezone=GMT`);
    const i = nowIndex(r), h = r.hourly, c = r.current;
    popup.setHTML(`<div class="pop">${head}<dl><dt>Elevation</dt><dd>${fmt(r.elevation)} m</dd><dt>Now</dt><dd>${fmt(c.temperature_2m, 1)} °C · ${WMO[c.weather_code] || ''}</dd><dt>Wind</dt><dd>${compass(c.wind_direction_10m)} ${fmt(c.wind_speed_10m)} km/h · ${fmt(kt(c.wind_speed_10m))} kt</dd><dt>Gusts</dt><dd>${fmt(c.wind_gusts_10m)} km/h</dd><dt>Peak gust 48 h</dt><dd>${fmt(peak(h.wind_gusts_10m, i, i + 48).v)} km/h</dd><dt>Warmest 48 h</dt><dd>${fmt(peak(h.temperature_2m, i, i + 48).v, 1)} °C</dd><dt>Rain next 48 h</dt><dd>${fmt(sum(h.precipitation.slice(i, i + 48)), 1)} mm</dd></dl></div>`);
  } catch { popup.setHTML(`<div class="pop">${head}<div class="muted">Forecast feed unreachable.</div></div>`); }
}

let hovered = null;
map.on('mousemove', (e) => {
  $('#cursor').textContent = `${e.lngLat.lat.toFixed(4)}°N  ${Math.abs(e.lngLat.lng).toFixed(4)}°${e.lngLat.lng < 0 ? 'W' : 'E'}  z${map.getZoom().toFixed(1)}`;
  const f = map.queryRenderedFeatures(e.point, { layers: ['sectors-fill'].filter((id) => map.getLayer(id)) })[0];
  const id = f?.id ?? null;
  if (id !== hovered) {
    if (hovered) map.setFeatureState({ source: 'sectors', id: hovered }, { hover: false });
    if (id) map.setFeatureState({ source: 'sectors', id }, { hover: true });
    hovered = id;
  }
  map.getCanvas().style.cursor = map.queryRenderedFeatures(e.point, { layers: CLICKABLE }).length ? 'pointer' : 'crosshair';
});
map.on('click', (e) => {
  const hits = map.queryRenderedFeatures(e.point, { layers: CLICKABLE });
  const f = hits[0];
  if (!f) return probe(e.lngLat);
  if (f.layer.id === 'quakes' || f.layer.id === 'historic') return quakePopup({ properties: f.properties, geometry: f.geometry });
  if (f.layer.id === 'places') return showPopup(f.geometry.coordinates, `<h4>${esc(f.properties.class || 'locality')}</h4><div>${esc(f.properties.name)}</div>${f.properties.population ? `<dl><dt>Population</dt><dd>${Number(f.properties.population).toLocaleString('en')}</dd></dl>` : ''}`);
  if (f.layer.id === 'pois') return showPopup(f.geometry.coordinates, `<h4>${esc((f.properties.category || 'place').replace(/_/g, ' '))}</h4><div>${esc(f.properties.name)}</div>`);
  if (e.originalEvent.shiftKey) return probe(e.lngLat);
  select(f.id === state.selected ? null : f.id);
});
map.on('contextmenu', (e) => probe(e.lngLat));

const segment = (sel, attr, fn) => document.querySelectorAll(`${sel} button`).forEach((b) => (b.onclick = () => {
  document.querySelectorAll(`${sel} button`).forEach((x) => x.classList.toggle('on', x === b));
  fn(b.dataset[attr]);
}));
segment('#metric', 'm', (m) => { state.metric = m; paintSectors(); });
segment('#basemap', 'b', (b) => { state.basemap = b; for (const k of Object.keys(BASEMAPS)) map.setLayoutProperty(`bm-${k}`, 'visibility', k === b ? 'visible' : 'none'); });
let is3d = false;
segment('#dim', 'd', (d) => {
  is3d = d === '3d';
  // The peninsula tops out near 30 m, so the relief is stretched to read at all.
  if (is3d) { map.setTerrain({ source: 'dem', exaggeration: 3 }); map.easeTo({ pitch: 62, bearing: 38, duration: 1200 }); }
  else { map.easeTo({ pitch: 0, bearing: 0, duration: 800 }); map.once('moveend', () => map.setTerrain(null)); }
});
$('#btn-home').onclick = () => fitArea();
$('#btn-city').onclick = () => map.flyTo({ center: CITY, zoom: 13.6, pitch: is3d ? 62 : map.getPitch(), bearing: map.getBearing(), padding: panelPadding() });
$('#btn-region').onclick = () => map.easeTo({ center: CITY, zoom: 4.8, pitch: 0, bearing: 0, padding: 0 });
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
  const x = state.data.context, a = state.data.area;
  $('#about-pen').textContent = fmt(a?.peninsula_km2, 1);
  $('#about-lag').textContent = fmt(a?.lagoon_km2);
  $('#about-buf').textContent = x?.shore_buffer_m ?? '150';
  $('#quake-radius').textContent = `within ${QUAKE_RADIUS_KM} km`;
  $('#about-thresholds').innerHTML = '<tr><th>Level</th><th>Gust</th><th>Air temp.</th><th>Rain 24 h</th><th>Waves</th></tr>' + LEVELS.slice(1).map((l) => `<tr><td style="color:${l.color}">${l.name}</td><td>≥ ${l.gust} km/h</td><td>≥ ${l.temp} °C</td><td>≥ ${l.rain} mm</td><td>≥ ${l.wave} m</td></tr>`).join('');
}
function clock() {
  const now = new Date(), t = (tz) => now.toLocaleTimeString('en-GB', { timeZone: tz, hour12: false });
  $('#clock-local').textContent = t(TZ); $('#clock-utc').textContent = t('UTC');
}
function redraw() { if (state.wx) renderWeather(); if (state.sea) renderSea(); renderTerrain(); }
let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(redraw, 150); });

setInterval(clock, 1000); clock(); renderFeeds();
map.once('style.load', async () => {
  await loadStatic();
  loadWeather(); loadSea(); loadAir(); loadQuakes();
  setInterval(loadWeather, REFRESH.wx); setInterval(loadSea, REFRESH.sea); setInterval(loadAir, REFRESH.air); setInterval(loadQuakes, REFRESH.quakes);
});
