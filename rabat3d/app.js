/* Mini Rabat 3D — trams and trains of Rabat–Salé moving on a 3D map.
 *
 * Track geometry and stop order come from OpenStreetMap (see
 * scripts/rabat3d_build_network.py). Departure times are simulated from
 * typical headways: there is no public real-time feed for Rabat.
 */
(() => {
  "use strict";

  const TZ = "Africa/Casablanca";
  const ORIGIN = [-6.83, 34.02]; // local metric frame for geometry maths
  const KX = 111320 * Math.cos((ORIGIN[1] * Math.PI) / 180);
  const KY = 110540;
  const FOLLOW_ZOOM = 16.4;
  const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------------------------------------------------------------- services
  // Tram headways in minutes, from the given time of day (seconds).
  const TRAM_HEADWAYS = {
    weekday: [[6 * 3600, 12], [7 * 3600, 8], [9.5 * 3600, 10], [16.5 * 3600, 8], [19.5 * 3600, 12], [21 * 3600, 15]],
    weekend: [[6.5 * 3600, 15], [9 * 3600, 12], [20 * 3600, 15]],
  };
  const TRAM_LAST = 22 * 3600;

  const SERVICES = [
    {
      id: "T1", line: "T1", kind: "tram", label: "L1", name: "Tramway L1", color: "#f08a24",
      vmax: 10, acc: 1.0, dwell: 25, layover: 180, dirOffset: { 1: 0, "-1": 240 },
      car: { n: 5, len: 13, w: 2.4, h: 3.3, lat: 1.6 },
    },
    {
      id: "T2", line: "T2", kind: "tram", label: "L2", name: "Tramway L2", color: "#2ba3de",
      vmax: 10, acc: 1.0, dwell: 25, layover: 180, dirOffset: { 1: 120, "-1": 360 },
      car: { n: 5, len: 13, w: 2.4, h: 3.3, lat: 1.6 },
    },
    {
      id: "TNR", line: "ONCF", kind: "rail", label: "TNR", name: "TNR shuttle", long: "Train Navette Rapide",
      color: "#e0445e", vmax: 30, acc: 0.6, dwell: 60,
      stops: ["Témara", "Rabat Riad", "Rabat Agdal", "Rabat Ville", "Salé Ville", "Salé Tabriquet"],
      dest: { 1: "Kénitra", "-1": "Casablanca" },
      first: 5.75 * 3600, last: 22 * 3600, headway: 30 * 60, offset: { 1: 0, "-1": 15 * 60 },
      car: { n: 4, len: 26, w: 3.0, h: 4.4, lat: 2.4 },
    },
    {
      id: "ATL", line: "ONCF", kind: "rail", label: "ATL", name: "Al Atlas", long: "Al Atlas intercity",
      color: "#2fae76", vmax: 33, acc: 0.5, dwell: 120,
      stops: ["Rabat Agdal", "Rabat Ville", "Salé Ville"],
      dest: { 1: "Fès", "-1": "Marrakech" },
      first: 5.5 * 3600, last: 21.5 * 3600, headway: 60 * 60, offset: { 1: 45 * 60, "-1": 0 },
      car: { n: 8, len: 24, w: 3.0, h: 4.0, lat: 2.4 },
    },
    {
      id: "BRQ", line: "ONCF", kind: "rail", label: "BRQ", name: "Al Boraq", long: "Al Boraq high-speed",
      color: "#9b7cf0", vmax: 36, acc: 0.5, dwell: 120,
      stops: ["Rabat Agdal"],
      dest: { 1: "Tanger", "-1": "Casablanca" },
      first: 6 * 3600, last: 21 * 3600, headway: 60 * 60, offset: { 1: 20 * 60, "-1": 35 * 60 },
      car: { n: 8, len: 25, w: 2.9, h: 4.0, lat: 2.4 },
    },
  ];
  const SERVICE_BY_ID = Object.fromEntries(SERVICES.map((s) => [s.id, s]));

  // ------------------------------------------------------------------ state
  const state = {
    simMs: Date.now(),
    live: true,
    speed: 1,
    paused: false,
    lastFrame: performance.now(),
    hidden: new Set(),
    selected: null, // { type: "vehicle", id } | { type: "station", key }
    follow: false,
    lockBearing: false,
    approach: false,
    hover: null,
    night: -1,
    scrubbing: false,
    styleReady: false,
  };

  let network, lines, stations, patterns, vehicles = [], vehicleById = new Map();
  let map, overlay, lighting, ambient, sun;
  const PATH_OFFSET = new deck.PathStyleExtension({ offset: true });

  // ---------------------------------------------------------------- time
  const partsFmt = safeFormat({
    hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const dateFmt = safeFormat({ weekday: "short", day: "numeric", month: "short" });
  const offsetCache = new Map();

  function safeFormat(opts) {
    try { return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, ...opts }); } catch { return null; }
  }

  // Milliseconds to add to UTC to get Morocco wall-clock time (handles the Ramadan switch to UTC+0).
  function tzOffset(ms) {
    const bucket = Math.floor(ms / 3.6e6);
    if (offsetCache.has(bucket)) return offsetCache.get(bucket);
    let off = 3.6e6;
    if (partsFmt) {
      const p = Object.fromEntries(partsFmt.formatToParts(new Date(bucket * 3.6e6)).map((x) => [x.type, x.value]));
      off = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - bucket * 3.6e6;
    }
    offsetCache.set(bucket, off);
    return off;
  }

  function localInfo(ms) {
    const wall = ms + tzOffset(ms);
    const sod = (((wall % 864e5) + 864e5) % 864e5) / 1000;
    const dow = new Date(wall).getUTCDay();
    return { sod, dayStart: ms - sod * 1000, weekend: dow === 0 || dow === 6, dayKey: Math.floor(wall / 864e5) };
  }

  const pad = (n) => String(n).padStart(2, "0");
  function hhmm(sod) {
    const m = Math.round(sod / 60);
    return `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
  }
  function hhmmss(sod) {
    const s = Math.floor(sod);
    return `${pad(Math.floor(s / 3600) % 24)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  }

  // ------------------------------------------------------------ geometry
  function prepLine(l) {
    const xy = l.coords.map(([lon, lat]) => [(lon - ORIGIN[0]) * KX, (lat - ORIGIN[1]) * KY]);
    const cum = [0];
    for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
    // Station distances were measured on the sphere; rescale to this planar frame.
    const f = cum[cum.length - 1] / l.length;
    l.stations.forEach((s) => (s.d *= f));
    return { ...l, xy, cum, L: cum[cum.length - 1] };
  }

  // Point and unit tangent at distance d along the line; extrapolates past the ends.
  function pointAt(line, d) {
    const { xy, cum, L } = line;
    let i;
    if (d <= 0) i = 0;
    else if (d >= L) i = xy.length - 2;
    else {
      let lo = 0, hi = cum.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
      i = lo;
    }
    const [x1, y1] = xy[i], [x2, y2] = xy[i + 1];
    const seg = cum[i + 1] - cum[i] || 1e-9;
    const t = (d - cum[i]) / seg;
    return { x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t, tx: (x2 - x1) / seg, ty: (y2 - y1) / seg };
  }

  const toLngLat = (x, y) => [ORIGIN[0] + x / KX, ORIGIN[1] + y / KY];

  // ------------------------------------------------------- motion model
  // Accelerate from v0 to a peak speed, cruise, brake to v1 over distance D.
  function profile(D, v0, v1, vmax, a) {
    let vp = vmax;
    let t1 = (vp - v0) / a, d1 = ((v0 + vp) / 2) * t1;
    let t3 = (vp - v1) / a, d3 = ((vp + v1) / 2) * t3;
    let d2 = D - d1 - d3;
    if (d2 < 0) {
      vp = Math.max(v0, v1, Math.sqrt((2 * a * D + v0 * v0 + v1 * v1) / 2));
      t1 = (vp - v0) / a; d1 = ((v0 + vp) / 2) * t1;
      t3 = (vp - v1) / a; d3 = ((vp + v1) / 2) * t3;
      d2 = Math.max(0, D - d1 - d3);
    }
    const t2 = d2 / vp;
    return { D, v0, v1, vp, a, t1, t2, t3, d1, d2, T: t1 + t2 + t3 };
  }

  function along(p, tau) {
    const { v0, vp, a, t1, t2, d1, d2 } = p;
    if (tau <= 0) return [0, v0];
    if (tau < t1) return [v0 * tau + 0.5 * a * tau * tau, v0 + a * tau];
    if (tau < t1 + t2) return [d1 + vp * (tau - t1), vp];
    const u = Math.min(tau - t1 - t2, p.t3);
    return [Math.min(p.D, d1 + d2 + vp * u - 0.5 * a * u * u), Math.max(0, vp - a * u)];
  }

  // A pattern is one service in one direction: node list with arrival/departure offsets.
  function buildPattern(svc, line, dir) {
    let nodes;
    if (svc.kind === "tram") {
      nodes = line.stations.map((s, i) => ({ d: s.d, stop: true, name: s.name, ar: s.ar, si: i }));
    } else {
      const stops = line.stations
        .map((s, i) => ({ d: s.d, stop: svc.stops.includes(s.name), name: s.name, ar: s.ar, si: i }))
        .filter((n) => n.stop);
      nodes = [{ d: 0, stop: false, name: null }, ...stops, { d: line.L, stop: false, name: null }];
    }
    if (dir < 0) nodes = nodes.slice().reverse();
    let t = 0;
    const legs = [];
    nodes.forEach((n, i) => {
      n.arr = t;
      n.dep = t + (n.stop && i > 0 && i < nodes.length - 1 ? svc.dwell : 0);
      t = n.dep;
      if (i < nodes.length - 1) {
        const m = nodes[i + 1];
        const p = profile(Math.abs(m.d - n.d), n.stop ? 0 : svc.vmax, m.stop ? 0 : svc.vmax, svc.vmax, svc.acc);
        legs.push(p);
        t += p.T;
      }
    });
    const T = nodes[nodes.length - 1].arr;
    const trainLen = svc.car.n * svc.car.len;
    return {
      svc, line, dir, nodes, legs, T,
      pre: svc.kind === "tram" ? svc.layover : 0,
      post: svc.kind === "tram" ? 60 : (trainLen * 4) / svc.vmax + 5,
      dest: svc.kind === "tram" ? nodes[nodes.length - 1].name : svc.dest[dir],
      origin: svc.kind === "tram" ? nodes[0].name : svc.dest[-dir],
    };
  }

  // Position of a trip tau seconds after its first departure.
  function positionAt(pat, tau) {
    const { nodes, legs, dir } = pat;
    if (tau <= 0) return { d: nodes[0].d, v: 0, i: 0, dwelling: true };
    const last = nodes[nodes.length - 1];
    if (tau >= last.arr) {
      const extra = last.stop ? 0 : pat.svc.vmax * (tau - last.arr);
      return { d: last.d + dir * extra, v: last.stop ? 0 : pat.svc.vmax, i: nodes.length - 1, dwelling: last.stop };
    }
    for (let i = 0; i < nodes.length - 1; i++) {
      const n = nodes[i];
      if (tau < n.dep) return { d: n.d, v: 0, i, dwelling: true };
      if (tau < nodes[i + 1].arr) {
        const [s, v] = along(legs[i], tau - n.dep);
        return { d: n.d + dir * s, v, i, dwelling: false };
      }
    }
    return { d: last.d, v: 0, i: nodes.length - 1, dwelling: true };
  }

  // Trip start times (seconds of the local day) for one pattern.
  function tripStarts(pat, weekend) {
    const svc = pat.svc;
    const out = [];
    if (svc.kind === "tram") {
      const hw = weekend ? TRAM_HEADWAYS.weekend : TRAM_HEADWAYS.weekday;
      let t = hw[0][0] + svc.dirOffset[pat.dir];
      while (t <= TRAM_LAST) {
        out.push(t);
        let h = hw[0][1];
        for (const [from, m] of hw) if (t >= from) h = m;
        t += h * 60;
      }
    } else {
      const off = svc.offset[pat.dir];
      const hw = svc.headway * (weekend && svc.id === "TNR" ? 2 : 1);
      for (let t = Math.ceil((svc.first - off) / hw) * hw + off; t <= svc.last; t += hw) out.push(t);
    }
    return out;
  }

  let tripCache = { key: null, trips: [] };
  function tripsFor(info) {
    const key = `${info.dayKey}:${info.weekend}`;
    if (tripCache.key !== key) {
      const trips = [];
      for (const pat of patterns) for (const start of tripStarts(pat, info.weekend)) {
        trips.push({ pat, start, id: `${pat.svc.id}:${pat.dir}:${start}` });
      }
      tripCache = { key, trips };
    }
    return tripCache.trips;
  }

  // ----------------------------------------------------------- stations
  function buildStations() {
    const byKey = new Map();
    for (const line of lines) {
      line.stations.forEach((s, i) => {
        const p = pointAt(line, s.d);
        const lngLat = toLngLat(p.x, p.y);
        const key = s.name;
        if (!byKey.has(key)) byKey.set(key, { key, name: s.name, ar: s.ar, kind: line.type, points: [], serves: [] });
        const st = byKey.get(key);
        st.points.push({ lngLat, line: line.id });
        st.serves.push({ line: line.id, si: i });
        if (line.type === "rail") st.kind = "rail";
      });
    }
    for (const st of byKey.values()) {
      const n = st.points.length;
      st.lngLat = [st.points.reduce((a, p) => a + p.lngLat[0], 0) / n, st.points.reduce((a, p) => a + p.lngLat[1], 0) / n];
      st.colors = [...new Set(st.serves.map((s) => s.line))];
    }
    return [...byKey.values()];
  }

  // Upcoming departures at a station, grouped by direction.
  function departures(st, info, limit = 4) {
    const groups = new Map();
    for (const trip of tripsFor(info)) {
      const { pat } = trip;
      if (state.hidden.has(pat.svc.id)) continue;
      const serve = st.serves.find((s) => s.line === pat.line.id);
      if (!serve) continue;
      const idx = pat.nodes.findIndex((n) => n.stop && n.si === serve.si);
      if (idx < 0 || idx === pat.nodes.length - 1) continue; // terminating here: no departure
      const t = trip.start + pat.nodes[idx].dep;
      if (t < info.sod - 20) continue;
      const gkey = pat.svc.kind === "tram" ? `${pat.svc.id}:${pat.dir}` : `rail:${pat.dir}`;
      if (!groups.has(gkey)) {
        groups.set(gkey, {
          title: pat.svc.kind === "tram" ? `${pat.svc.label} to ${pat.dest}` : pat.dir > 0 ? "Northbound · Salé, Kénitra" : "Southbound · Témara, Casablanca",
          items: [],
        });
      }
      groups.get(gkey).items.push({ t, svc: pat.svc, dest: pat.dest, id: trip.id });
    }
    return [...groups.values()].map((g) => ({ ...g, items: g.items.sort((a, b) => a.t - b.t).slice(0, limit) }));
  }

  // --------------------------------------------------------- vehicles
  function vehicleScale(zoom) {
    // Keep vehicles at least a few pixels wide when zoomed out, like Mini Tokyo 3D does.
    const mpp = (78271.517 * Math.cos((ORIGIN[1] * Math.PI) / 180)) / 2 ** zoom;
    return mpp;
  }

  function computeVehicles(info) {
    const out = [];
    for (const trip of tripsFor(info)) {
      const { pat } = trip;
      if (state.hidden.has(pat.svc.id)) continue;
      const tau = info.sod - trip.start;
      if (tau < -pat.pre || tau > pat.T + pat.post) continue;
      const pos = positionAt(pat, tau);
      out.push({ id: trip.id, trip, pat, tau, ...pos });
    }
    return out;
  }

  function vehicleCars(v, mpp) {
    const { svc, line, dir } = v.pat;
    const c = svc.car;
    const kW = Math.max(1, (5.5 * mpp) / c.w);
    const minLenPx = svc.kind === "tram" ? 16 : 26;
    const kL = Math.max(1, (minLenPx * mpp) / (c.n * c.len));
    const w = c.w * kW, h = c.h * Math.max(1, kW * 0.75), len = c.len * kL, gap = Math.max(0.8, 0.9 * kL);
    const lat = Math.max(c.lat, w * 0.62);
    const cars = [];
    for (let i = 0; i < c.n; i++) {
      let a = v.d - dir * i * len;
      let b = v.d - dir * ((i + 1) * len - gap);
      a = Math.min(Math.max(a, 0), line.L);
      b = Math.min(Math.max(b, 0), line.L);
      if (Math.abs(a - b) < 1) continue;
      const P = pointAt(line, a), Q = pointAt(line, b);
      let ux = P.x - Q.x, uy = P.y - Q.y;
      const m = Math.hypot(ux, uy) || 1;
      ux /= m; uy /= m;
      const nx = uy, ny = -ux; // right-hand normal: trams and trains keep right
      const o1 = lat - w / 2, o2 = lat + w / 2;
      cars.push({
        v,
        head: i === 0,
        height: h,
        polygon: [
          toLngLat(P.x + nx * o1, P.y + ny * o1), toLngLat(P.x + nx * o2, P.y + ny * o2),
          toLngLat(Q.x + nx * o2, Q.y + ny * o2), toLngLat(Q.x + nx * o1, Q.y + ny * o1),
        ],
      });
    }
    // Camera target and heading for follow mode.
    const P = pointAt(line, Math.min(Math.max(v.d, 0), line.L));
    const off = lat;
    v.lngLat = toLngLat(P.x + dir * P.ty * off, P.y - dir * P.tx * off);
    v.heading = (Math.atan2(dir * P.tx, dir * P.ty) * 180) / Math.PI;
    return cars;
  }

  // ------------------------------------------------------------ colors
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const mix = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
  const css = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  const lighten = (c, t) => mix(c, [255, 255, 255], t);

  const PALETTE = {
    background: ["#eceee9", "#0c0e13"],
    landcover: ["#dde9d3", "#101812"],
    residential: ["#e5e5df", "#12141a"],
    water: ["#a6cbe3", "#0a1726"],
    waterway: ["#9cc4de", "#0c1a2b"],
    minor: ["#ffffff", "#1d222b"],
    major: ["#fff1cc", "#2f3542"],
    motorway: ["#fbd98a", "#3d4452"],
    casing: ["#d9d6cc", "#0c0e13"],
    building: ["#dcd8cf", "#1a1e27"],
    label: ["#4d4d48", "#8f98a8"],
    halo: ["#f7f7f3", "#0c0e13"],
    railTrack: ["#8d9197", "#565c66"],
  };
  const palRgb = (k, n) => mix(hex(PALETTE[k][0]), hex(PALETTE[k][1]), n);
  const pal = (k, n) => css(palRgb(k, n));

  // Sun position (after suncalc); returns altitude and azimuth (from south, radians).
  function sunPosition(ms, lat, lng) {
    const rad = Math.PI / 180, d = ms / 864e5 - 10957.5;
    const M = rad * (357.5291 + 0.98560028 * d);
    const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    const L = M + C + rad * 102.9372 + Math.PI, e = rad * 23.4397;
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L));
    const H = rad * (280.16 + 360.9856235 * d) + lng * rad - ra, phi = lat * rad;
    return {
      alt: Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)),
      az: Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)),
    };
  }

  function nightFactor(ms) {
    const alt = (sunPosition(ms, ORIGIN[1], ORIGIN[0]).alt * 180) / Math.PI;
    const t = Math.min(1, Math.max(0, (6 - alt) / 14)); // +6° → day, −8° → night
    return t * t * (3 - 2 * t);
  }

  // --------------------------------------------------------- basemap
  function baseStyle() {
    const name = ["coalesce", ["get", "name:fr"], ["get", "name:latin"], ["get", "name"]];
    return {
      version: 8,
      glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
      sources: {
        omt: { type: "vector", url: "https://tiles.openfreemap.org/planet", attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank">© OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>' },
      },
      layers: [
        { id: "background", type: "background", paint: { "background-color": pal("background", 0) } },
        { id: "landcover", type: "fill", source: "omt", "source-layer": "landcover", filter: ["in", ["get", "class"], ["literal", ["wood", "grass", "farmland"]]], paint: { "fill-color": pal("landcover", 0), "fill-opacity": 0.7 } },
        { id: "park", type: "fill", source: "omt", "source-layer": "park", paint: { "fill-color": pal("landcover", 0), "fill-opacity": 0.8 } },
        { id: "residential", type: "fill", source: "omt", "source-layer": "landuse", filter: ["in", ["get", "class"], ["literal", ["residential", "suburb", "neighbourhood"]]], paint: { "fill-color": pal("residential", 0), "fill-opacity": 0.6 } },
        { id: "water", type: "fill", source: "omt", "source-layer": "water", paint: { "fill-color": pal("water", 0) } },
        { id: "waterway", type: "line", source: "omt", "source-layer": "waterway", paint: { "line-color": pal("waterway", 0), "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 16, 3] } },
        {
          id: "road-minor", type: "line", source: "omt", "source-layer": "transportation", minzoom: 12,
          filter: ["in", ["get", "class"], ["literal", ["minor", "service", "track"]]],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": pal("minor", 0), "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 12, 0.4, 16, 5, 18, 14] },
        },
        {
          id: "road-major", type: "line", source: "omt", "source-layer": "transportation",
          filter: ["in", ["get", "class"], ["literal", ["primary", "secondary", "tertiary", "trunk"]]],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": pal("major", 0), "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 9, 0.5, 14, 3, 16, 9, 18, 24] },
        },
        {
          id: "road-motorway", type: "line", source: "omt", "source-layer": "transportation",
          filter: ["==", ["get", "class"], "motorway"],
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": pal("motorway", 0), "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 8, 0.8, 14, 4, 18, 28] },
        },
        {
          id: "buildings", type: "fill-extrusion", source: "omt", "source-layer": "building", minzoom: 13,
          paint: {
            "fill-extrusion-color": pal("building", 0),
            "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 13, 0, 13.6, ["coalesce", ["get", "render_height"], 6]],
            "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
            "fill-extrusion-opacity": 0.88,
          },
        },
        {
          id: "water-name", type: "symbol", source: "omt", "source-layer": "water_name",
          layout: { "text-field": name, "text-font": ["Noto Sans Italic"], "text-size": 12, "symbol-placement": "point" },
          paint: { "text-color": pal("waterway", 0.3), "text-halo-color": pal("halo", 0), "text-halo-width": 1 },
        },
        {
          id: "place", type: "symbol", source: "omt", "source-layer": "place",
          filter: ["in", ["get", "class"], ["literal", ["city", "town", "suburb", "quarter", "neighbourhood"]]],
          layout: {
            "text-field": name, "text-font": ["Noto Sans Regular"],
            "text-size": ["match", ["get", "class"], "city", 17, "town", 15, "suburb", 13, 11.5],
            "text-transform": ["match", ["get", "class"], ["suburb", "quarter"], "uppercase", "none"],
            "text-letter-spacing": ["match", ["get", "class"], ["suburb", "quarter"], 0.08, 0],
            "text-max-width": 8,
          },
          paint: { "text-color": pal("label", 0), "text-halo-color": pal("halo", 0), "text-halo-width": 1.4 },
        },
      ],
    };
  }

  function applyNight(n) {
    if (!state.styleReady || Math.abs(n - state.night) < 0.01) return;
    state.night = n;
    const set = (layer, prop, value) => map.getLayer(layer) && map.setPaintProperty(layer, prop, value);
    set("background", "background-color", pal("background", n));
    set("landcover", "fill-color", pal("landcover", n));
    set("park", "fill-color", pal("landcover", n));
    set("residential", "fill-color", pal("residential", n));
    set("water", "fill-color", pal("water", n));
    set("waterway", "line-color", pal("waterway", n));
    set("road-minor", "line-color", pal("minor", n));
    set("road-major", "line-color", pal("major", n));
    set("road-motorway", "line-color", pal("motorway", n));
    set("buildings", "fill-extrusion-color", pal("building", n));
    for (const id of ["place", "water-name"]) {
      set(id, "text-color", id === "place" ? pal("label", n) : pal("waterway", 0.3 + n * 0.4));
      set(id, "text-halo-color", pal("halo", n));
    }
    set("carto-fallback", "raster-brightness-max", 1 - n * 0.75);
    document.documentElement.style.setProperty("--night", n.toFixed(2));
  }

  // If OpenFreeMap is unreachable, fall back to CARTO raster tiles so the map still has context.
  let fallbackAdded = false, pendingFallback = false;
  function addFallback() {
    if (fallbackAdded || !state.styleReady) return;
    fallbackAdded = true;
    map.addSource("carto", {
      type: "raster", tileSize: 256,
      tiles: ["a", "b", "c"].map((s) => `https://${s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png`),
      attribution: '© <a href="https://carto.com/attributions">CARTO</a>',
    });
    map.addLayer({ id: "carto-fallback", type: "raster", source: "carto", paint: { "raster-brightness-max": 1 } }, "landcover");
    state.night = -1;
  }

  // ------------------------------------------------------------ layers
  function buildLayers(info) {
    const zoom = map.getZoom();
    const mpp = vehicleScale(zoom);
    const n = Math.max(0, state.night);
    const sel = state.selected;
    const cars = [];
    for (const v of vehicles) for (const c of vehicleCars(v, mpp)) cars.push(c);

    const trackData = lines.filter((l) =>
      l.type === "rail" ? SERVICES.some((s) => s.kind === "rail" && !state.hidden.has(s.id)) : !state.hidden.has(l.id));

    const stationPoints = [];
    for (const st of stations) for (const p of st.points) {
      if (p.line !== "ONCF" && state.hidden.has(p.line)) continue;
      stationPoints.push({ st, lngLat: p.lngLat, line: p.line });
    }
    const labelZoomTram = 14.2; // below this, tram stop names crowd each other
    const labels = stations.filter((s) => s.kind === "rail" || zoom >= labelZoomTram)
      .filter((s) => s.serves.some((x) => x.line === "ONCF" || !state.hidden.has(x.line)));

    const selV = sel && sel.type === "vehicle" ? vehicleById.get(sel.id) : null;
    const pulse = (performance.now() % 1600) / 1600;

    return [
      new deck.PathLayer({
        id: "tracks-casing",
        data: trackData,
        getPath: (l) => l.coords,
        getColor: () => (n > 0.5 ? [0, 0, 0, 150] : [255, 255, 255, 200]),
        getWidth: (l) => (l.type === "rail" ? 14 : 9),
        widthUnits: "meters", widthMinPixels: 4, capRounded: true, jointRounded: true,
        updateTriggers: { getColor: n > 0.5, getPath: trackData.length },
        parameters: { depthCompare: "always" },
      }),
      new deck.PathLayer({
        id: "tracks",
        data: trackData,
        getPath: (l) => l.coords,
        getColor: (l) => (l.type === "rail" ? palRgb("railTrack", n) : hex(l.color)),
        getWidth: (l) => (l.type === "rail" ? 8 : 5),
        widthUnits: "meters", widthMinPixels: 2.2, capRounded: true, jointRounded: true,
        // L1 and L2 share track over the Hassan II bridge: draw them side by side.
        getOffset: (l) => (l.id === "T1" ? -0.5 : l.id === "T2" ? 0.5 : 0),
        extensions: [PATH_OFFSET],
        updateTriggers: { getColor: Math.round(n * 10), getPath: trackData.length },
        parameters: { depthCompare: "always" },
      }),
      new deck.ScatterplotLayer({
        id: "stations",
        data: stationPoints,
        getPosition: (d) => d.lngLat,
        getRadius: (d) => (d.st.kind === "rail" ? 34 : 13),
        radiusUnits: "meters", radiusMinPixels: 3.2, radiusMaxPixels: 16,
        stroked: true, lineWidthUnits: "pixels", getLineWidth: 2,
        getFillColor: [255, 255, 255, 255],
        getLineColor: (d) => (d.st.kind === "rail" ? [60, 64, 72] : hex(lines.find((l) => l.id === d.line).color)),
        pickable: true,
        parameters: { depthCompare: "always" },
        updateTriggers: { getPosition: stationPoints.length },
      }),
      // An extruded polygon layer with no data issues an invalid instanced draw; skip it at night.
      cars.length > 0 && new deck.SolidPolygonLayer({
        id: "vehicles",
        data: cars,
        getPolygon: (c) => c.polygon,
        extruded: true,
        getElevation: (c) => c.height,
        getFillColor: (c) => {
          const base = hex(c.v.pat.svc.color);
          const hot = (selV && c.v.id === selV.id) || (state.hover && state.hover === c.v.id);
          const lit = lighten(base, hot ? 0.28 : c.head ? 0.08 : 0);
          return n > 0.4 ? mix(lit, [255, 255, 255], 0.12) : lit;
        },
        material: { ambient: 0.55, diffuse: 0.6, shininess: 24, specularColor: [60, 60, 60] },
        pickable: true,
        updateTriggers: { getFillColor: [selV && selV.id, state.hover, n > 0.4] },
      }),
      selV && new deck.ScatterplotLayer({
        id: "selection-ring",
        data: [selV],
        getPosition: (v) => v.lngLat,
        getRadius: 1,
        radiusUnits: "pixels",
        radiusMinPixels: 14 + pulse * 16,
        filled: false, stroked: true, lineWidthUnits: "pixels", getLineWidth: 2,
        getLineColor: [...hex(selV.pat.svc.color), Math.round(220 * (1 - pulse))],
        parameters: { depthCompare: "always" },
        updateTriggers: { getLineColor: pulse },
      }),
      new deck.TextLayer({
        id: "station-labels",
        data: labels,
        getPosition: (s) => s.lngLat,
        getText: (s) => s.name,
        characterSet: "auto",
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontWeight: 600,
        getSize: (s) => (s.kind === "rail" ? 13 : 11.5),
        getColor: n > 0.5 ? [236, 238, 242, 255] : [34, 36, 40, 255],
        outlineWidth: 3, outlineColor: n > 0.5 ? [12, 14, 19, 230] : [255, 255, 255, 230],
        fontSettings: { sdf: true, fontSize: 64, buffer: 6 },
        getPixelOffset: [0, -16],
        getTextAnchor: "middle", getAlignmentBaseline: "bottom",
        billboard: true,
        parameters: { depthCompare: "always" },
        updateTriggers: { getColor: n > 0.5 },
      }),
    ].filter(Boolean);
  }

  // ------------------------------------------------------------- UI
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const badge = (svc) => `<span class="line-badge" style="background:${svc.color}">${esc(svc.label)}</span>`;
  const lineColor = (id) => (SERVICE_BY_ID[id] ? SERVICE_BY_ID[id].color : "#8a8f98");

  function initLegend() {
    const list = $("line-list");
    list.innerHTML = SERVICES.map((s) => {
      const line = lines.find((l) => l.id === s.line);
      const sub = s.kind === "tram" ? `${line.from} ↔ ${line.to}` : `${s.dest[-1]} ↔ ${s.dest[1]}`;
      return `<li><button class="line-item" data-svc="${s.id}" aria-pressed="true">
        ${badge(s)}<span class="line-text"><span class="line-name">${esc(s.long || s.name)}</span><span class="line-sub">${esc(sub)}</span></span>
        <span class="line-count" data-count="${s.id}">0</span></button></li>`;
    }).join("");
    list.addEventListener("click", (e) => {
      const b = e.target.closest(".line-item");
      if (!b) return;
      const id = b.dataset.svc;
      if (state.hidden.has(id)) state.hidden.delete(id); else state.hidden.add(id);
      b.setAttribute("aria-pressed", String(!state.hidden.has(id)));
    });
    $("legend-toggle").addEventListener("click", () => {
      const el = $("legend");
      const c = el.dataset.collapsed === "true";
      el.dataset.collapsed = String(!c);
      $("legend-toggle").setAttribute("aria-expanded", String(c));
    });
    if (matchMedia("(max-width: 720px)").matches) {
      $("legend").dataset.collapsed = "true";
      $("legend-toggle").setAttribute("aria-expanded", "false");
    }
  }

  function updateCounts() {
    const counts = Object.fromEntries(SERVICES.map((s) => [s.id, 0]));
    for (const v of vehicles) counts[v.pat.svc.id]++;
    for (const s of SERVICES) {
      const el = document.querySelector(`[data-count="${s.id}"]`);
      if (el) el.textContent = counts[s.id];
    }
    $("total-count").textContent = vehicles.length;
  }

  // ---- speed controls
  function initControls() {
    document.querySelectorAll(".seg[data-speed]").forEach((b) =>
      b.addEventListener("click", () => {
        const sp = b.dataset.speed;
        if (sp === "live") { state.live = true; state.speed = 1; state.simMs = Date.now(); }
        else { state.live = false; state.speed = +sp; }
        state.paused = false;
        syncControls();
      }));
    $("pause-btn").addEventListener("click", () => {
      state.paused = !state.paused;
      if (state.paused) state.live = false;
      syncControls();
    });
    const scrub = $("scrub");
    scrub.addEventListener("pointerdown", () => (state.scrubbing = true));
    scrub.addEventListener("input", () => {
      const info = localInfo(state.simMs);
      state.simMs = info.dayStart + scrub.value * 60000;
      if (state.live) { state.live = false; state.speed = 1; }
      syncControls();
    });
    const endScrub = () => (state.scrubbing = false);
    scrub.addEventListener("pointerup", endScrub);
    scrub.addEventListener("change", endScrub);
    $("about-btn").addEventListener("click", () => $("about").showModal());
    $("about").addEventListener("click", (e) => { if (e.target === $("about")) $("about").close(); });
    $("banner-btn").addEventListener("click", () => {
      const info = localInfo(state.simMs);
      const target = info.sod > 12 * 3600 ? info.dayStart + 864e5 + 8 * 3600e3 : info.dayStart + 8 * 3600e3;
      state.simMs = target;
      state.live = false; state.speed = 1; state.paused = false;
      syncControls();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("about").open) {
        if (state.follow) setFollow(false); else select(null);
      }
      if (e.key === " " && e.target === document.body) { e.preventDefault(); $("pause-btn").click(); }
    });
  }

  function syncControls() {
    document.querySelectorAll(".seg[data-speed]").forEach((b) => {
      const on = b.dataset.speed === "live" ? state.live && !state.paused : !state.live && !state.paused && state.speed === +b.dataset.speed;
      b.setAttribute("aria-pressed", String(on));
    });
    $("pause-btn").setAttribute("aria-pressed", String(state.paused));
    $("pause-btn").setAttribute("aria-label", state.paused ? "Play" : "Pause");
    const chip = $("live-chip");
    chip.dataset.live = String(state.live && !state.paused);
    chip.lastElementChild.textContent = state.live && !state.paused ? "Live" : state.paused ? "Paused" : state.speed === 1 ? "Replay" : `${state.speed}× speed`;
  }

  // ---- search
  const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  function initSearch() {
    const input = $("search"), results = $("search-results");
    let items = [], active = 0;
    const render = () => {
      results.innerHTML = items.map((s, i) => `<li role="option" data-i="${i}" aria-selected="${i === active}">
        <span>${esc(s.name)}</span><span class="dots">${s.colors.map((c) => `<i style="background:${lineColor(c)}"></i>`).join("")}</span></li>`).join("");
    };
    input.addEventListener("input", () => {
      const q = norm(input.value.trim());
      items = q ? stations.filter((s) => norm(s.name).includes(q) || (s.ar && s.ar.includes(input.value.trim()))).slice(0, 8) : [];
      active = 0;
      render();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { active = Math.min(items.length - 1, active + 1); render(); e.preventDefault(); }
      if (e.key === "ArrowUp") { active = Math.max(0, active - 1); render(); e.preventDefault(); }
      if (e.key === "Enter" && items[active]) choose(items[active]);
      if (e.key === "Escape") { input.value = ""; items = []; render(); input.blur(); }
    });
    results.addEventListener("pointerdown", (e) => {
      const li = e.target.closest("li");
      if (li) { e.preventDefault(); choose(items[+li.dataset.i]); }
    });
    function choose(st) {
      input.value = ""; items = []; render(); input.blur();
      select({ type: "station", key: st.key });
    }
  }

  // ---- detail panel
  function select(sel) {
    state.selected = sel;
    const panel = $("detail");
    if (!sel) {
      panel.hidden = true;
      document.body.classList.remove("has-detail");
      setFollow(false);
      map.easeTo({ padding: panelPadding(), duration: REDUCED_MOTION ? 0 : 300 });
      return;
    }
    panel.hidden = false;
    document.body.classList.add("has-detail");
    panel.dataset.state = "enter";
    requestAnimationFrame(() => requestAnimationFrame(() => (panel.dataset.state = "")));
    if (sel.type === "vehicle") {
      renderVehiclePanel();
      map.setPadding(panelPadding());
      setFollow(true);
    } else {
      setFollow(false);
      const st = stations.find((s) => s.key === sel.key);
      renderStationPanel(st);
      map.flyTo({ padding: panelPadding(), center: st.lngLat, zoom: Math.max(map.getZoom(), 15), pitch: 55, duration: REDUCED_MOTION ? 0 : 1400, essential: true });
    }
  }

  // Keep the camera target clear of the detail panel (right on desktop, bottom sheet on mobile).
  function panelPadding() {
    const panel = $("detail");
    if (panel.hidden) return { top: 0, right: 0, bottom: 0, left: 0 };
    if (matchMedia("(max-width: 720px)").matches) return { top: 150, right: 0, bottom: panel.offsetHeight + 12, left: 0 };
    return { top: 0, right: panel.offsetWidth + 16, bottom: 0, left: 320 };
  }

  function setFollow(on) {
    state.follow = on;
    state.lockBearing = on;
    state.approach = on;
    const btn = $("follow-btn");
    if (btn) {
      btn.textContent = on ? "Stop following" : "Follow";
      $("follow-state").textContent = on ? "Camera is following this vehicle" : "Camera is free";
    }
  }

  function renderVehiclePanel() {
    const v = vehicleById.get(state.selected.id);
    if (!v) return;
    const { pat, trip } = v;
    const svc = pat.svc;
    const stops = pat.nodes.map((n, i) => ({ n, i })).filter((x) => x.n.stop);
    $("detail").innerHTML = `
      <div class="detail-head">
        <div class="detail-top">${badge(svc)}<span class="detail-sub">${esc(svc.long || svc.name)}</span>
          <button class="close" id="detail-close" aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg></button></div>
        <h2 class="detail-title">→ ${esc(pat.dest)}</h2>
        <p class="detail-sub">From ${esc(pat.origin)} · ${svc.kind === "rail" ? "enters the map" : "departs"} ${hhmm(trip.start)}</p>
        <div class="stats">
          <div class="stat"><b id="st-speed">–</b><span>km/h</span></div>
          <div class="stat"><b id="st-next">–</b><span id="st-next-label">Next stop</span></div>
          <div class="stat"><b id="st-eta">–</b><span>Arrives</span></div>
        </div>
        <div class="follow-row"><span id="follow-state"></span><button id="follow-btn"></button></div>
      </div>
      <div class="detail-body"><ol class="stops" style="--c:${svc.color}">
        ${stops.map(({ n, i }) => `<li class="stop" data-i="${i}"><span>${esc(n.name)}</span><span class="t">${hhmm(trip.start + n.arr)}</span></li>`).join("")}
      </ol></div>`;
    $("detail-close").addEventListener("click", () => select(null));
    $("follow-btn").addEventListener("click", () => setFollow(!state.follow));
    setFollow(state.follow);
  }

  function updateVehiclePanel(info) {
    const v = vehicleById.get(state.selected.id);
    if (!v) {
      $("st-speed").textContent = "0";
      $("st-next").textContent = "Arrived";
      $("st-eta").textContent = "–";
      setFollow(false);
      return;
    }
    const { pat } = v;
    $("st-speed").textContent = Math.round(v.v * 3.6);
    let next = pat.nodes.findIndex((n, i) => n.stop && (i > v.i || (i === v.i && v.dwelling)));
    const tau = v.tau;
    if (next >= 0 && pat.nodes[next].arr < tau && !(v.dwelling && next === v.i)) next = -1;
    const nn = next >= 0 ? pat.nodes[next] : null;
    const atStop = nn && v.dwelling && next === v.i;
    $("st-next-label").textContent = atStop ? (tau < 0 ? "Waiting at" : "At stop") : "Next stop";
    $("st-next").textContent = nn ? nn.name : pat.svc.kind === "rail" ? "Leaving map" : "–";
    const eta = nn ? nn.arr - tau : null;
    $("st-eta").textContent = !nn ? "–" : atStop ? (tau < 0 ? `${Math.ceil(-tau / 60)} min` : "Now") : eta < 60 ? `${Math.max(0, Math.round(eta))} s` : `${Math.round(eta / 60)} min`;
    document.querySelectorAll("#detail .stop").forEach((li) => {
      const i = +li.dataset.i;
      li.classList.toggle("passed", i < (next >= 0 ? next : Infinity) && pat.nodes[i].arr <= tau);
      const isNext = i === next;
      if (isNext && !li.classList.contains("next")) scrollStopIntoView(li);
      li.classList.toggle("next", isNext);
    });
  }

  // Keep the upcoming stop visible, a couple of rows below the top of the list.
  function scrollStopIntoView(li) {
    const body = li.closest(".detail-body");
    const top = li.offsetTop - body.offsetTop - li.offsetHeight * 2;
    body.scrollTo({ top: Math.max(0, top), behavior: REDUCED_MOTION ? "auto" : "smooth" });
  }

  function renderStationPanel(st) {
    const svcs = [...new Set(st.serves.flatMap((s) => SERVICES.filter((x) => x.line === s.line && (x.kind === "tram" || x.stops.includes(st.name)))))];
    $("detail").innerHTML = `
      <div class="detail-head">
        <div class="detail-top">${svcs.map(badge).join("")}
          <button class="close" id="detail-close" aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg></button></div>
        <h2 class="detail-title">${esc(st.name)}</h2>
        <p class="detail-sub">${st.ar ? `<span lang="ar" dir="rtl">${esc(st.ar)}</span> · ` : ""}${st.kind === "rail" ? "ONCF station" : "Tram stop"}</p>
      </div>
      <div class="detail-body" id="deps"></div>`;
    $("detail-close").addEventListener("click", () => select(null));
    updateStationPanel(localInfo(state.simMs));
  }

  function updateStationPanel(info) {
    const st = stations.find((s) => s.key === state.selected.key);
    const groups = departures(st, info);
    const el = $("deps");
    if (!groups.length || groups.every((g) => !g.items.length)) {
      el.innerHTML = `<p class="empty">No more departures today.</p>`;
      return;
    }
    el.innerHTML = groups.filter((g) => g.items.length).map((g) => `<ul class="deps"><h4>${esc(g.title)}</h4>
      ${g.items.map((d) => {
        const mins = Math.round((d.t - info.sod) / 60);
        return `<li class="dep">${badge(d.svc)}<span class="dest">${esc(d.dest)}</span><span class="t">${hhmm(d.t)}</span>
          <span class="in">${mins <= 0 ? "Now" : `${mins} min`}</span></li>`;
      }).join("")}</ul>`).join("");
  }

  // ---- banner
  function updateBanner(info) {
    const banner = $("banner");
    const quiet = vehicles.length === 0;
    if (quiet) {
      $("banner-text").textContent = info.sod < 12 * 3600
        ? "It's night in Rabat: trams start around 06:00."
        : "Service has ended for tonight in Rabat.";
      $("banner-btn").textContent = info.sod < 12 * 3600 ? "Jump to 08:00" : "Jump to tomorrow 08:00";
    }
    banner.hidden = !quiet;
  }

  // ---- tooltip
  function onHover(info) {
    const tip = $("tooltip");
    const obj = info.object;
    state.hover = obj && obj.v ? obj.v.id : null;
    if (!obj || matchMedia("(hover: none)").matches) { tip.style.display = "none"; return; }
    if (obj.v) {
      const { svc, dest } = obj.v.pat;
      tip.innerHTML = `${badge(svc)} → ${esc(dest)}<div class="tt-sub">${Math.round(obj.v.v * 3.6)} km/h · click to follow</div>`;
    } else if (obj.st) {
      tip.innerHTML = `<b>${esc(obj.st.name)}</b>${obj.st.ar ? ` <span class="tt-sub" lang="ar">${esc(obj.st.ar)}</span>` : ""}<div class="tt-sub">Click for departures</div>`;
    }
    tip.style.display = "block";
    tip.style.left = `${info.x + 14}px`;
    tip.style.top = `${info.y + 14}px`;
  }

  function onClick(info) {
    const obj = info.object;
    if (!obj) return;
    if (obj.v) select({ type: "vehicle", id: obj.v.id });
    else if (obj.st) select({ type: "station", key: obj.st.key });
  }

  // ------------------------------------------------------------- loop
  let lastUi = 0;
  function frame(now) {
    const dt = Math.min(now - state.lastFrame, 250);
    state.lastFrame = now;
    if (state.live && !state.paused) state.simMs = Date.now();
    else if (!state.paused) state.simMs += dt * state.speed;

    const info = localInfo(state.simMs);
    vehicles = computeVehicles(info);
    vehicleById = new Map(vehicles.map((v) => [v.id, v]));

    applyNight(nightFactor(state.simMs));
    if (sun) {
      sun.timestamp = state.simMs;
      ambient.intensity = 1.0 + Math.max(0, state.night) * 0.6;
    }
    overlay.setProps({ layers: buildLayers(info) });
    followCamera();

    if (now - lastUi > 200) {
      lastUi = now;
      $("clock-time").textContent = hhmmss(info.sod);
      if (dateFmt) $("clock-date").textContent = `${dateFmt.format(new Date(state.simMs))} · Rabat time`;
      if (!state.scrubbing) $("scrub").value = Math.min(1440, Math.max(300, info.sod / 60));
      updateCounts();
      updateBanner(info);
      if (state.selected) {
        if (state.selected.type === "vehicle") updateVehiclePanel(info);
        else if (now - (frame.lastDeps || 0) > 1000) { frame.lastDeps = now; updateStationPanel(info); }
      }
    }
    requestAnimationFrame(frame);
  }

  function followCamera() {
    if (!state.follow || !state.selected || state.selected.type !== "vehicle") return;
    const v = vehicleById.get(state.selected.id);
    if (!v || !v.lngLat) return;
    // Lock onto the vehicle (it never drifts off-screen, even at 300×); ease only zoom, pitch and bearing.
    const opts = { center: v.lngLat };
    if (state.approach) {
      const z = map.getZoom(), p = map.getPitch();
      opts.zoom = z + (FOLLOW_ZOOM - z) * (REDUCED_MOTION ? 1 : 0.08);
      opts.pitch = p + (62 - p) * (REDUCED_MOTION ? 1 : 0.08);
      if (Math.abs(FOLLOW_ZOOM - opts.zoom) < 0.03 && Math.abs(62 - opts.pitch) < 0.5) state.approach = false;
    }
    if (state.lockBearing && v.v > 0.5) {
      const b = map.getBearing();
      let delta = ((v.heading - 30 - b + 540) % 360) - 180; // look slightly across the direction of travel
      opts.bearing = b + delta * (REDUCED_MOTION ? 1 : 0.03);
    }
    map.jumpTo(opts);
  }

  // ------------------------------------------------------------- boot
  async function boot() {
    network = await (await fetch("data/network.json")).json();
    lines = network.lines.map(prepLine);
    const lineById = Object.fromEntries(lines.map((l) => [l.id, l]));
    patterns = SERVICES.flatMap((svc) => [1, -1].map((dir) => buildPattern(svc, lineById[svc.line], dir)));
    stations = buildStations();

    map = new maplibregl.Map({
      container: "map",
      style: baseStyle(),
      center: [-6.826, 34.012],
      zoom: REDUCED_MOTION ? 13.3 : 11.2,
      pitch: REDUCED_MOTION ? 58 : 0,
      bearing: REDUCED_MOTION ? -28 : 0,
      maxPitch: 75,
      minZoom: 9,
      maxBounds: [[-7.3, 33.7], [-6.4, 34.35]],
      antialias: true,
      attributionControl: { compact: true, customAttribution: 'Transit © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · timetable simulated' },
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new maplibregl.FullscreenControl(), "top-right");

    ambient = new deck.AmbientLight({ color: [255, 255, 255], intensity: 1.0 });
    sun = new deck._SunLight({ timestamp: state.simMs, color: [255, 244, 229], intensity: 1.1 });
    lighting = new deck.LightingEffect({ ambient, sun });

    overlay = new deck.MapboxOverlay({
      interleaved: true,
      layers: [],
      effects: [lighting],
      onHover,
      onClick,
      getCursor: ({ isHovering, isDragging }) => (isDragging ? "grabbing" : isHovering ? "pointer" : "grab"),
    });
    map.addControl(overlay);

    // Manual camera moves release the follow lock.
    map.on("dragstart", (e) => { if (e.originalEvent && state.follow) setFollow(false); });
    map.on("rotatestart", (e) => { if (e.originalEvent) state.lockBearing = false; });
    map.on("pitchstart", (e) => { if (e.originalEvent) state.approach = false; });
    map.on("wheel", () => { state.approach = false; });
    map.on("error", (e) => {
      const msg = String((e.error && e.error.message) || "");
      if (e.sourceId === "omt" || /openfreemap/i.test(msg)) {
        if (state.styleReady) addFallback(); else pendingFallback = true;
      }
    });
    // "style.load" fires once the style is parsed, even if the tile server is slow or down.
    map.once("style.load", () => {
      state.styleReady = true;
      state.night = -1;
      if (pendingFallback) addFallback();
      if (!REDUCED_MOTION) {
        map.flyTo({ center: [-6.826, 34.018], zoom: 13.5, pitch: 58, bearing: -28, duration: 4200, curve: 1.2, essential: true });
      }
    });

    initLegend();
    initControls();
    initSearch();
    syncControls();
    window.__rabat3d = { state, get vehicles() { return vehicles; }, stations, patterns, select, map: () => map };
    requestAnimationFrame(frame);
  }

  boot().catch((err) => {
    console.error(err);
    document.body.insertAdjacentHTML("beforeend", `<p style="position:absolute;top:50%;width:100%;text-align:center">Could not load the network: ${esc(err.message)}</p>`);
  });
})();
