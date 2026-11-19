/* Maâmora Watch: monthly Sentinel-2 NDVI of the Maâmora forest.
 * Everything is read from ./data, written by pipeline/run_workflow.py.
 * NDVI rasters are 8 bit PNGs (0 = no data); they are decoded and coloured here,
 * so any two months can be differenced in the browser. */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const label = (ym) => `${MON[+ym.slice(5) - 1]} ${ym.slice(0, 4)}`;
  const fmt = (v, d = 2) => (v == null || !isFinite(v) ? '–' : v.toFixed(d));
  const signed = (v, d = 2) => (v == null || !isFinite(v) ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d));
  const num = (v) => Math.round(v).toLocaleString('en-US');

  // ---- colour ramps -------------------------------------------------------
  const SEQ = ['#f5ecd6', '#e3d7a4', '#c3cc7c', '#8fbf62', '#52a552', '#22803f', '#0d5a2e', '#063b1f'];   // low to high NDVI
  const DIV = ['#7a3b0c', '#b0692a', '#d9a866', '#efdcb8', '#f4f1ea', '#bfe0dc', '#74bcb6', '#2b8a86', '#0b5553']; // loss to gain
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  function lut(stops) {
    const out = new Uint8Array(256 * 3), s = stops.map(hex);
    for (let i = 0; i < 256; i++) {
      const t = (i / 255) * (s.length - 1), k = Math.min(s.length - 2, Math.floor(t)), f = t - k;
      for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(s[k][c] + (s[k + 1][c] - s[k][c]) * f);
    }
    return out;
  }
  const LUT_SEQ = lut(SEQ), LUT_DIV = lut(DIV);
  const css = (stops) => `linear-gradient(90deg, ${stops.join(',')})`;

  const VIEWS = {
    ndvi: { note: 'Greenness in the selected month. Dense, leafy canopy is dark green; bare sand and cleared ground are pale.', ramp: SEQ, ticks: ['0', '0.2', '0.4', '0.6', '0.8'], cap: ['bare', 'dense canopy'] },
    anomaly: { note: 'The selected month minus the 2019–2023 mean for the same calendar month. Brown is browner than normal, teal is greener.', ramp: DIV, ticks: ['−0.25', '', '0', '', '+0.25'], cap: ['below normal', 'above normal'] },
    compare: { note: 'The selected month minus another month of your choice.', ramp: DIV, ticks: ['−0.30', '', '0', '', '+0.30'], cap: ['lower than then', 'higher than then'] },
    trend: { note: 'Slope of dry-season (July–September) NDVI across all years, per year. Dry-season NDVI mostly reflects tree canopy.', ramp: DIV, ticks: ['−0.03', '', '0', '', '+0.03 / yr'], cap: ['thinning', 'thickening'] },
    change: { note: '', ramp: DIV, ticks: ['−0.40', '', '0', '', '+0.40'], cap: ['canopy loss', 'canopy gain'] },
  };

  const S = { view: 'ndvi', t: 0, cmp: 0, cell: null, feat: null, cat: 'canopy_loss', playing: false };
  let D, CH, map, W, H, canvas, ctx, img, cur = { a: null, b: null };

  // ---- raster loading -----------------------------------------------------
  const cache = new Map();
  function raster(path) {
    if (cache.has(path)) { const v = cache.get(path); cache.delete(path); cache.set(path, v); return v; }
    const p = new Promise((res) => {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0);
        const px = x.getImageData(0, 0, W, H).data, q = new Uint8Array(W * H);
        for (let i = 0; i < q.length; i++) q[i] = px[i * 4];
        res(q);
      };
      im.onerror = () => res(null);
      im.src = `data/${path}`;
    });
    cache.set(path, p);
    if (cache.size > 30) cache.delete(cache.keys().next().value);
    return p;
  }
  const monthRaster = (t) => raster(`ndvi/${D.months[t]}.png`);
  const [N0, N1] = [-0.2, 1.0];
  const ndvi = (q) => (q - 1) / 254 * (N1 - N0) + N0;

  let drawToken = 0;
  async function draw() {
    const token = ++drawToken, v = S.view;
    let a = null, b = null;
    if (v === 'trend') a = await raster('trend.png');
    else if (v === 'change') a = await raster('change.png');
    else {
      a = await monthRaster(S.t);
      if (v === 'anomaly') b = await raster(`clim/${D.months[S.t].slice(5)}.png`);
      if (v === 'compare') b = await monthRaster(S.cmp);
    }
    if (token !== drawToken) return;
    cur = { a, b };
    const o = img.data;
    o.fill(0);
    if (a && (b || v === 'ndvi' || v === 'trend' || v === 'change')) {
      const k = (N1 - N0) / 254, span = v === 'anomaly' ? 0.25 : 0.3;
      for (let i = 0, j = 0; i < a.length; i++, j += 4) {
        const q = a[i];
        if (!q) continue;
        let idx, L;
        if (v === 'ndvi') { idx = Math.max(0, Math.min(255, Math.round(ndvi(q) / 0.8 * 255))); L = LUT_SEQ; }
        else if (v === 'trend') { idx = Math.max(0, Math.min(255, Math.round(127.5 + ((q - 1) / 254 - 0.5) * (0.1 / 0.06) * 255))); L = LUT_DIV; }
        else if (v === 'change') { idx = Math.max(0, Math.min(255, Math.round(127.5 + ((q - 1) / 254 - 0.5) * (1 / 0.8) * 255))); L = LUT_DIV; }
        else { if (!b[i]) continue; idx = Math.max(0, Math.min(255, Math.round(127.5 + (q - b[i]) * k / span * 127.5))); L = LUT_DIV; }
        o[j] = L[idx * 3]; o[j + 1] = L[idx * 3 + 1]; o[j + 2] = L[idx * 3 + 2]; o[j + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const src = map.getSource('ndvi');
    if (src) { src.play(); map.once('render', () => src.pause()); map.triggerRepaint(); }
  }

  /** Value under a map position, in the units of the current view. */
  function probe(lngLat) {
    const c = D.raster.corners, my = (lat) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
    const x = Math.floor((lngLat.lng - c[0][0]) / (c[1][0] - c[0][0]) * W);
    const y = Math.floor((my(c[0][1]) - my(lngLat.lat)) / (my(c[0][1]) - my(c[3][1])) * H);
    if (x < 0 || y < 0 || x >= W || y >= H || !cur.a) return null;
    const i = y * W + x, q = cur.a[i];
    if (!q) return null;
    if (S.view === 'ndvi') return `NDVI ${fmt(ndvi(q))}`;
    if (S.view === 'trend') return `${signed(((q - 1) / 254 - 0.5) * 0.1, 3)} NDVI / yr`;
    if (S.view === 'change') return `${signed(((q - 1) / 254 - 0.5) * 1.0)} summer NDVI`;
    if (!cur.b || !cur.b[i]) return null;
    return `${signed(ndvi(q) - ndvi(cur.b[i]))} (NDVI ${fmt(ndvi(q))})`;
  }

  // ---- side panel ---------------------------------------------------------
  function renderFlow() {
    const w = D.workflow, first = D.months[0], last = D.months[D.months.length - 1];
    const rows = [
      ['Area and period', `${num(D.forest_ha)} ha · ${first.slice(0, 4)}–${last.slice(0, 4)}`],
      ['Sentinel-2 scenes found', num(w.scenes_listed)],
      ['Clear scenes composited', `${num(w.scenes_used)} → ${w.months} months`],
      [`${D.cell_km} km processing cells`, num(w.cells)],
      ['Change features catalogued', num(D.change.features)],
    ];
    $('#flow').innerHTML = rows.map(([a, b]) => `<li><span>${a}</span><b>${b}</b></li>`).join('');
    $('#generated').textContent = `Last run ${D.generated.replace('T', ' ').replace('Z', ' UTC')}. Latest month ${label(last)}.`;
  }

  function renderLegend() {
    const v = VIEWS[S.view], c = D.change;
    $('#view-note').textContent = S.view === 'change'
      ? `Summer ${c.latest_summer} NDVI minus the median of summers ${c.reference_summers[0]}–${c.reference_summers[c.reference_summers.length - 1]}. Outlined patches moved by ${c.threshold} or more over at least ${c.min_patch_ha} ha.`
      : v.note;
    $('#legend').innerHTML = `<div class="ramp" style="background:${css(v.ramp)}"></div><div class="ticks">${v.ticks.map((t) => `<span>${t}</span>`).join('')}</div><div class="cap"><span>${v.cap[0]}</span><span>${v.cap[1]}</span></div>`;
    $('#compare-row').hidden = S.view !== 'compare';
    for (const b of document.querySelectorAll('#views button')) b.setAttribute('aria-selected', b.dataset.v === S.view);
  }

  function renderReadout() {
    const f = D.forest, t = S.t, ym = D.months[t], m = +ym.slice(5) - 1;
    $('#month-label').textContent = label(ym);
    $('#read-title').textContent = `Whole forest · ${label(ym)}`;
    const a = f.anomaly[t], z = f.z[t], cls = a == null ? '' : a > 0.005 ? 'up' : a < -0.005 ? 'down' : '';
    const word = z == null ? '' : Math.abs(z) < 1 ? 'within the usual range' : `${fmt(Math.abs(z), 1)}σ ${z > 0 ? 'above' : 'below'} usual`;
    $('#readout').innerHTML = `
      <div class="kpi"><i>Mean NDVI</i><b>${fmt(f.mean[t])}</b><em>${f.mean[t] == null ? 'too cloudy to average' : `10–90%: ${fmt(f.p10[t])}–${fmt(f.p90[t])}`}</em></div>
      <div class="kpi"><i>Against normal</i><b class="${cls}">${signed(a)}</b><em>${word || `normal ${fmt(D.clim.mean[m])}`}</em></div>
      <div class="kpi"><i>Forest seen</i><b>${Math.round(f.cover[t] * 100)}<small>%</small></b><em>cloud-free</em></div>`;
    const sc = D.scenes[ym];
    $('#scenes').textContent = sc && sc.dates && sc.dates.length
      ? `Built from ${sc.dates.length} of ${sc.listed} Sentinel-2 passes: ${sc.dates.map((d) => `${+d.slice(6)} ${MON[+d.slice(4, 6) - 1]}`).join(', ')}.` : '';
  }

  function renderChange() {
    const c = D.change;
    $('#change-sub').textContent = `summer ${c.reference_summers[0]}–${String(c.reference_summers[c.reference_summers.length - 1]).slice(2)} → ${c.latest_summer}`;
    const pct = (ha) => `${(ha / D.forest_ha * 100).toFixed(1)}% of the forest`;
    $('#change-summary').innerHTML = `
      <div class="kpi"><i>Canopy loss patches</i><b class="down">${num(c.loss_ha)}<small>ha</small></b><em>${pct(c.loss_ha)}</em></div>
      <div class="kpi"><i>Canopy gain patches</i><b class="up">${num(c.gain_ha)}<small>ha</small></b><em>${pct(c.gain_ha)}</em></div>`;
    for (const b of document.querySelectorAll('#change-filter button')) b.setAttribute('aria-selected', b.dataset.c === S.cat);
    const list = CH.features.filter((f) => f.properties.category === S.cat).slice(0, 60);
    $('#change-list').innerHTML = list.length ? list.map((f) => {
      const p = f.properties;
      return `<li><button data-id="${p.id}" class="${S.feat === p.id ? 'on' : ''}"><b>${num(p.area_ha)} ha</b><span>${signed(p.delta_ndvi)}</span><span>${Math.round(p.confidence * 100)}%</span></button></li>`;
    }).join('') : '<li class="empty">No patch passes the thresholds.</li>';
  }

  function bars(values, years, refN) {
    const max = Math.max(0.01, ...values.filter((v) => v != null));
    return `<div class="bars">${values.map((v, i) => `<div class="${i < refN ? 'ref' : ''}" style="height:${v == null ? 0 : Math.max(3, v / max * 100)}%" title="${years[i]}: ${fmt(v)}"><span>${String(years[i]).slice(2)}</span></div>`).join('')}</div>`;
  }

  function renderSelection() {
    const box = $('#sel'), body = $('#sel-body');
    $('#key-cell').hidden = S.cell == null;
    if (S.feat != null) {
      const p = CH.features.find((f) => f.properties.id === S.feat).properties, loss = p.category === 'canopy_loss';
      box.hidden = false;
      body.innerHTML = `<p class="title">${loss ? 'Canopy loss' : 'Canopy gain'} patch · ${num(p.area_ha)} ha</p>
        <div class="kpis"><div class="kpi"><i>Summer NDVI</i><b>${fmt(p.ndvi_before)} → ${fmt(p.ndvi_after)}</b></div>
        <div class="kpi"><i>Confidence</i><b>${Math.round(p.confidence * 100)}<small>%</small></b></div>
        <div class="kpi"><i>Largest step</i><b>${p.step_year ?? '–'}</b></div></div>
        ${bars(p.summer_ndvi, D.summer.years, D.change.reference_summers.length)}
        <p class="bars-cap">Mean July–September NDVI of the patch by year. Pale bars are the reference summers. ${loss ? 'The cause is not known from NDVI: harvest, fire, dieback and clearing all look like this.' : 'Regrowth after a harvest and new planting both look like this.'}</p>`;
    } else if (S.cell != null) {
      const c = D.cells[S.cell];
      box.hidden = false;
      body.innerHTML = `<p class="title">Cell ${c.id} · ${num(c.forest_ha)} ha of forest</p>
        <div class="kpis"><div class="kpi"><i>Latest vs normal</i><b class="${c.anomaly > 0 ? 'up' : 'down'}">${signed(c.anomaly)}</b></div>
        <div class="kpi"><i>Summer trend</i><b class="${c.trend > 0 ? 'up' : 'down'}">${signed(c.trend, 3)}<small>/yr</small></b></div>
        <div class="kpi"><i>Summer change</i><b class="${c.change > 0 ? 'up' : 'down'}">${signed(c.change)}</b></div></div>
        <p class="note">Its monthly series is drawn in orange on the chart.</p>`;
      $('#key-cell-label').textContent = `Cell ${c.id}`;
    } else box.hidden = true;
    map.getSource('sel').setData(S.feat != null ? CH.features.find((f) => f.properties.id === S.feat)
      : S.cell != null ? GRID.features[S.cell] : { type: 'FeatureCollection', features: [] });
  }

  // ---- chart --------------------------------------------------------------
  const NS = 'http://www.w3.org/2000/svg';
  let CX = null;
  function renderChart() {
    const svg = $('#chart'), bw = svg.clientWidth, bh = svg.clientHeight;
    if (!bw || !bh) return;
    const pad = { l: 30, r: 8, t: 6, b: 16 }, n = D.months.length;
    const cell = S.cell != null ? D.cells[S.cell].ndvi.map((v) => (v == null ? null : v / 1000)) : null;
    const all = [...D.forest.mean, ...(cell || [])].filter((v) => v != null);
    const lo = Math.floor((Math.min(...all) - 0.03) * 10) / 10, hi = Math.ceil((Math.max(...all) + 0.03) * 10) / 10;
    const x = (i) => pad.l + (i / (n - 1)) * (bw - pad.l - pad.r);
    const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (bh - pad.t - pad.b);
    CX = { x, pad, bw, n };
    const path = (vals) => { let d = '', pen = false; vals.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; }); return d; };
    const mo = D.months.map((s) => +s.slice(5) - 1);
    const cm = mo.map((m) => D.clim.mean[m]), cs = mo.map((m) => D.clim.std[m] ?? 0);
    let band = '';
    if (cm.every((v) => v != null)) band = `M${cm.map((v, i) => `${x(i).toFixed(1)},${y(v + cs[i]).toFixed(1)}`).join('L')}L${cm.map((v, i) => `${x(i).toFixed(1)},${y(v - cs[i]).toFixed(1)}`).reverse().join('L')}Z`;
    let g = '';
    for (let v = lo; v <= hi + 1e-6; v += 0.1) g += `<line x1="${pad.l}" x2="${bw - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="#d9d0bd" stroke-width="1"/><text x="${pad.l - 5}" y="${y(v) + 3}" text-anchor="end">${v.toFixed(1)}</text>`;
    D.months.forEach((s, i) => { if (s.endsWith('-01')) g += `<line x1="${x(i)}" x2="${x(i)}" y1="${pad.t}" y2="${bh - pad.b}" stroke="#d9d0bd" stroke-width="1"/><text x="${x(i) + 3}" y="${bh - 4}">${s.slice(0, 4)}</text>`; });
    const dots = D.forest.mean.map((v, i) => (v != null && (D.forest.mean[i - 1] == null && D.forest.mean[i + 1] == null) ? `<circle cx="${x(i)}" cy="${y(v)}" r="1.6" fill="#1f6b45"/>` : '')).join('');
    const t = S.t, tv = D.forest.mean[t];
    const cmpMark = S.view === 'compare' ? `<line x1="${x(S.cmp)}" x2="${x(S.cmp)}" y1="${pad.t}" y2="${bh - pad.b}" stroke="#9a5b2c" stroke-width="1.5" stroke-dasharray="3 3"/>` : '';
    svg.setAttribute('viewBox', `0 0 ${bw} ${bh}`);
    svg.innerHTML = `${g}<path d="${band}" fill="#8a8272" opacity="0.16"/>
      <path d="${path(cm)}" fill="none" stroke="#8a8272" stroke-width="1.2" stroke-dasharray="4 3"/>
      <path d="${path(D.forest.mean)}" fill="none" stroke="#1f6b45" stroke-width="2" stroke-linejoin="round"/>${dots}
      ${cell ? `<path d="${path(cell)}" fill="none" stroke="#c2410c" stroke-width="1.6" stroke-linejoin="round"/>` : ''}
      ${cmpMark}<line x1="${x(t)}" x2="${x(t)}" y1="${pad.t}" y2="${bh - pad.b}" stroke="#23201a" stroke-width="1.5"/>
      ${tv != null ? `<circle cx="${x(t)}" cy="${y(tv)}" r="4" fill="#faf7f0" stroke="#23201a" stroke-width="2"/>` : ''}`;
  }
  function chartIndex(ev) {
    const r = $('#chart').getBoundingClientRect(), px = ev.clientX - r.left;
    return Math.max(0, Math.min(CX.n - 1, Math.round((px - CX.pad.l) / (CX.bw - CX.pad.l - CX.pad.r) * (CX.n - 1))));
  }

  // ---- state changes ------------------------------------------------------
  function setMonth(t, fromPlay) {
    S.t = Math.max(0, Math.min(D.months.length - 1, t));
    if (!fromPlay) stop();
    if (S.view === 'trend' || S.view === 'change') { /* raster does not depend on the month */ } else draw();
    renderReadout(); renderChart();
    if (S.t + 1 < D.months.length) monthRaster(S.t + 1);
  }
  function setView(v) { S.view = v; if (v === 'trend' || v === 'change') stop(); renderLegend(); renderChart(); draw(); }
  let timer = null;
  function stop() { S.playing = false; clearInterval(timer); $('#play').textContent = '▶'; $('#play').setAttribute('aria-label', 'Play months'); }
  function play() {
    if (S.view === 'trend' || S.view === 'change') setView('ndvi');
    S.playing = true; $('#play').textContent = '❚❚'; $('#play').setAttribute('aria-label', 'Pause');
    if (S.t >= D.months.length - 1) setMonth(0, true);
    timer = setInterval(() => { if (S.t >= D.months.length - 1) return stop(); setMonth(S.t + 1, true); }, 420);
  }
  function selectFeature(id, fly) {
    S.feat = id; S.cell = null;
    const f = CH.features.find((x) => x.properties.id === id);
    S.cat = f.properties.category;
    if (fly) map.flyTo({ center: f.properties.center, zoom: Math.max(map.getZoom(), 12.2), speed: 1.4 });
    renderSelection(); renderChange(); renderChart();
  }

  // ---- map ----------------------------------------------------------------
  let GRID;
  function buildMap() {
    const carto = (n) => ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/${n}/{z}/{x}/{y}@2x.png`);
    const attr = '© <a href="https://carto.com/attributions">CARTO</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
    map = new maplibregl.Map({
      container: 'map', attributionControl: { compact: true }, maxZoom: 15, minZoom: 7,
      bounds: [[D.aoi[0], D.aoi[1] - 0.14], [D.aoi[2], D.aoi[3]]], fitBoundsOptions: { padding: 24 },
      style: {
        version: 8,
        sources: {
          base: { type: 'raster', tiles: carto('light_nolabels'), tileSize: 256, maxzoom: 19, attribution: attr },
          sat: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 18, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
          labels: { type: 'raster', tiles: carto('light_only_labels'), tileSize: 256, maxzoom: 19 },
        },
        layers: [
          { id: 'base', type: 'raster', source: 'base' },
          { id: 'sat', type: 'raster', source: 'sat', layout: { visibility: 'none' } },
        ],
      },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    return new Promise((res) => map.on('load', res));
  }
  function addLayers(forest) {
    map.addSource('ndvi', { type: 'canvas', canvas, coordinates: D.raster.corners, animate: false });
    map.addLayer({ id: 'ndvi', type: 'raster', source: 'ndvi', paint: { 'raster-opacity': 0.92, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } });
    map.addSource('forest', { type: 'geojson', data: forest });
    map.addLayer({ id: 'forest', type: 'line', source: 'forest', paint: { 'line-color': '#23201a', 'line-width': 0.6, 'line-opacity': 0.45 } });
    map.addSource('grid', { type: 'geojson', data: GRID });
    map.addLayer({ id: 'grid', type: 'fill', source: 'grid', paint: { 'fill-color': '#000', 'fill-opacity': 0 } });
    map.addLayer({ id: 'grid-hover', type: 'line', source: 'grid', paint: { 'line-color': '#23201a', 'line-width': 1, 'line-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.7, 0] } });
    map.addSource('change', { type: 'geojson', data: CH });
    map.addLayer({ id: 'change', type: 'line', source: 'change', paint: { 'line-color': ['match', ['get', 'category'], 'canopy_loss', '#b3401f', '#1c6f8a'], 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.8, 13, 2] } });
    map.addLayer({ id: 'change-hit', type: 'fill', source: 'change', paint: { 'fill-opacity': 0 } });
    map.addSource('sel', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'sel-halo', type: 'line', source: 'sel', paint: { 'line-color': '#fff', 'line-width': 5 } });
    map.addLayer({ id: 'sel', type: 'line', source: 'sel', paint: { 'line-color': '#c2410c', 'line-width': 2.5 } });
    map.addLayer({ id: 'labels', type: 'raster', source: 'labels' });

    let hover = null;
    const tip = $('#probe');
    map.on('mousemove', (e) => {
      const txt = probe(e.lngLat);
      tip.hidden = !txt;
      if (txt) { tip.textContent = txt; tip.style.left = `${e.point.x}px`; tip.style.top = `${e.point.y}px`; }
      const f = map.queryRenderedFeatures(e.point, { layers: ['grid'] })[0];
      if (hover != null && (!f || f.id !== hover)) map.setFeatureState({ source: 'grid', id: hover }, { hover: false });
      hover = f ? f.id : null;
      if (f) map.setFeatureState({ source: 'grid', id: f.id }, { hover: true });
      map.getCanvas().style.cursor = f ? 'pointer' : '';
    });
    map.on('mouseout', () => { tip.hidden = true; });
    map.on('click', (e) => {
      const ch = $('#opt-outlines').checked ? map.queryRenderedFeatures(e.point, { layers: ['change-hit'] })[0] : null;
      if (ch) return selectFeature(ch.properties.id, false);
      const f = map.queryRenderedFeatures(e.point, { layers: ['grid'] })[0];
      S.feat = null; S.cell = f ? f.id : null;
      renderSelection(); renderChange(); renderChart();
    });
  }

  // ---- wiring -------------------------------------------------------------
  function wire() {
    $('#views').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setView(b.dataset.v); });
    $('#change-filter').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { S.cat = b.dataset.c; renderChange(); } });
    $('#change-list').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { if (S.view !== 'change') setView('change'); selectFeature(+b.dataset.id, true); } });
    $('#sel-clear').addEventListener('click', () => { S.cell = null; S.feat = null; renderSelection(); renderChange(); renderChart(); });
    $('#play').addEventListener('click', () => (S.playing ? stop() : play()));
    $('#prev').addEventListener('click', () => setMonth(S.t - 1));
    $('#next').addEventListener('click', () => setMonth(S.t + 1));
    $('#compare-month').addEventListener('change', (e) => { S.cmp = +e.target.value; renderChart(); draw(); });
    $('#opt-outlines').addEventListener('change', (e) => { for (const l of ['change', 'change-hit']) map.setLayoutProperty(l, 'visibility', e.target.checked ? 'visible' : 'none'); });
    $('#opt-sat').addEventListener('change', (e) => { map.setLayoutProperty('sat', 'visibility', e.target.checked ? 'visible' : 'none'); });
    $('#opt-opacity').addEventListener('input', (e) => map.setPaintProperty('ndvi', 'raster-opacity', e.target.value / 100));
    $('#btn-about').addEventListener('click', () => $('#about').showModal());
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, select, textarea') || $('#about').open) return;
      if (e.key === 'ArrowLeft') setMonth(S.t - 1); else if (e.key === 'ArrowRight') setMonth(S.t + 1);
    });
    const svg = $('#chart'), tip = $('#chart-tip');
    let drag = false;
    svg.addEventListener('pointerdown', (e) => { drag = true; svg.setPointerCapture(e.pointerId); setMonth(chartIndex(e)); });
    svg.addEventListener('pointerup', () => { drag = false; });
    svg.addEventListener('pointermove', (e) => {
      const i = chartIndex(e);
      if (drag && i !== S.t) setMonth(i);
      const v = D.forest.mean[i], c = S.cell != null ? D.cells[S.cell].ndvi[i] : null;
      tip.hidden = false;
      tip.innerHTML = `${label(D.months[i])} · forest ${fmt(v)}${S.cell != null ? ` · cell ${fmt(c == null ? null : c / 1000)}` : ''}`;
      const r = svg.getBoundingClientRect(), dock = svg.parentElement.getBoundingClientRect();
      tip.style.left = `${Math.min(dock.width - 190, Math.max(4, e.clientX - dock.left + 10))}px`;
      tip.style.top = `${r.top - dock.top - 2}px`;
    });
    svg.addEventListener('pointerleave', () => { tip.hidden = true; });
    new ResizeObserver(renderChart).observe(svg);
  }

  async function init() {
    const get = (p) => fetch(`data/${p}`).then((r) => { if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); });
    let forest;
    try { [D, CH, GRID, forest] = await Promise.all([get('series.json'), get('change.geojson'), get('grid.geojson'), get('forest.geojson')]); }
    catch (err) { $('#loading').textContent = `Could not load the data (${err.message}).`; return; }
    W = D.raster.width; H = D.raster.height;
    canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    ctx = canvas.getContext('2d'); img = ctx.createImageData(W, H);
    S.t = D.months.length - 1;
    // Start on the latest month that saw most of the forest.
    while (S.t > 0 && D.forest.mean[S.t] == null) S.t--;
    S.cmp = Math.max(0, D.months.indexOf(`${+D.months[S.t].slice(0, 4) - 1}${D.months[S.t].slice(4)}`));
    $('#compare-month').innerHTML = D.months.map((m, i) => `<option value="${i}"${i === S.cmp ? ' selected' : ''}>${label(m)}</option>`).reverse().join('');
    await buildMap();
    addLayers(forest);
    wire();
    renderFlow(); renderLegend(); renderReadout(); renderChange(); renderSelection(); renderChart();
    await draw();
    $('#loading').hidden = true;
  }
  init();
})();
