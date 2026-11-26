// Finding your way: the round minimap, place search, and a route with a light beam at the destination.

import * as THREE from 'three';
import { env } from './shaders.js';

const S = 0.4; // map pixels per metre in the pre-drawn city map
const MARGIN = 400;
const AREA_FILL = { water: '#1b3c58', pier: '#3d434c', plaza: '#363c45' };

export class Nav {
  constructor(city, graph, scene) {
    this.city = city;
    this.graph = graph;
    this.dest = null;
    this.route = null;
    this.routeAge = 9;
    this.arrived = 0;
    this.searching = false;
    this.onOpen = () => {};
    this.onClose = () => {};

    this.canvas = document.getElementById('minimap');
    const px = Math.round(this.canvas.clientWidth * Math.min(window.devicePixelRatio || 1, 2)) || 380;
    this.canvas.width = this.canvas.height = px;
    this.ctx = this.canvas.getContext('2d');
    this.frame = 0;
    this._drawCityMap();
    this._makeBeacon(scene);
    this._wireSearch();
  }

  // ---------------------------------------------------------------- the city, drawn once from above
  _drawCityMap() {
    const b = this.city.meta.bounds;
    this.x0 = b.x0 - MARGIN;
    this.z0 = b.z0 - MARGIN;
    const map = document.createElement('canvas');
    map.width = Math.ceil((b.x1 - b.x0 + 2 * MARGIN) * S);
    map.height = Math.ceil((b.z1 - b.z0 + 2 * MARGIN) * S);
    const c = map.getContext('2d');
    c.fillStyle = '#2a2f37';
    c.fillRect(0, 0, map.width, map.height);
    const ring = (p) => {
      c.moveTo((p[0] - this.x0) * S, (p[1] - this.z0) * S);
      for (let i = 2; i < p.length; i += 2) c.lineTo((p[i] - this.x0) * S, (p[i + 1] - this.z0) * S);
      c.closePath();
    };
    const fill = (p, holes) => {
      c.beginPath();
      ring(p);
      if (holes) for (const h of holes) ring(h);
      c.fill('evenodd');
    };
    for (const a of this.city.areas) {
      c.fillStyle = AREA_FILL[a.k] || '#2b5236';
      fill(a.p, a.o);
    }
    c.fillStyle = '#434b58';
    for (const bd of this.city.buildings) if (!bd.m) fill(bd.p, bd.o);
    c.lineCap = c.lineJoin = 'round';
    for (const pass of [1, 0]) {
      // footpaths faintly first, then streets on top
      c.strokeStyle = pass ? 'rgba(170, 178, 190, 0.25)' : '#a3adbd';
      for (const r of this.city.roads) {
        if ((r.k === 0) === !!pass || r.k === 2) continue;
        c.lineWidth = pass ? 0.7 : Math.max(1.2, r.w * S * 0.75);
        c.beginPath();
        c.moveTo((r.p[0] - this.x0) * S, (r.p[1] - this.z0) * S);
        for (let i = 2; i < r.p.length; i += 2) c.lineTo((r.p[i] - this.x0) * S, (r.p[i + 1] - this.z0) * S);
        c.stroke();
      }
    }
    this.map = map;
  }

  // ---------------------------------------------------------------- destination beam
  _makeBeacon(scene) {
    const geo = new THREE.CylinderGeometry(7, 7, 900, 20, 1, true);
    geo.translate(0, 450, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: env.uTime },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        varying float vH;
        void main() {
          vH = position.y / 900.0;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying float vH;
        void main() {
          float pulse = 0.75 + 0.25 * sin(uTime * 3.0 - vH * 30.0);
          float a = (0.12 + 0.5 * pow(1.0 - vH, 2.0)) * pulse;
          gl_FragColor = vec4(vec3(1.0, 0.8, 0.3) * a, 1.0);
        }`,
    });
    this.beacon = new THREE.Mesh(geo, mat);
    this.beacon.visible = false;
    this.beacon.frustumCulled = false;
    scene.add(this.beacon);
  }

  // ---------------------------------------------------------------- search
  find(query) {
    // typed without accents or apostrophes, "mausolee" still finds "Mausolée"
    const plain = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/['’-]/g, ' ').replace(/\s+/g, ' ').trim();
    const q = plain(query);
    if (!q) return [];
    const hits = [];
    for (const p of this.city.places) {
      const en = p.plain || (p.plain = plain(p.n));
      let score = 0;
      if (en.startsWith(q)) score = 100;
      else if (en.includes(' ' + q)) score = 70;
      else if (en.includes(q)) score = 50;
      if (p.ar && p.ar.includes(query.trim())) score = Math.max(score, p.ar.startsWith(query.trim()) ? 100 : 60);
      if (!score) continue;
      // well-known places and tall towers first, short names before long ones
      hits.push({ p, score: score + (p.star ? 45 : 0) + Math.min(p.h || 0, 450) / 12 - en.length * 0.15 });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, 8).map((h) => h.p);
  }

  _wireSearch() {
    const box = (this.box = document.getElementById('search'));
    const input = (this.input = document.getElementById('search-input'));
    const list = (this.list = document.getElementById('search-results'));
    let results = [], index = 0;
    const render = () => {
      list.innerHTML = '';
      results.forEach((p, i) => {
        const li = document.createElement('li');
        if (i === index) li.className = 'on';
        const name = document.createElement('b');
        name.textContent = p.ar ? `${p.n}  ·  ${p.ar}` : p.n;
        const info = document.createElement('span');
        info.textContent = p.h ? `${Math.round(p.h)} m` : '';
        li.append(name, info);
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          this.closeSearch(p);
        });
        list.append(li);
      });
      if (!results.length && input.value.trim()) list.innerHTML = '<li class="none">Nothing found. Try “Hassan”, “Oudayas”, “Chellah”, “Bab”…</li>';
    };
    input.addEventListener('input', () => {
      results = this.find(input.value);
      index = 0;
      render();
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.closeSearch(null);
      else if (e.key === 'Enter') this.closeSearch(results[index] || null);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        index = (index + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % Math.max(results.length, 1);
        render();
      }
    });
    input.addEventListener('keyup', (e) => e.stopPropagation());
    this._resetSearch = () => {
      results = [];
      index = 0;
      input.value = '';
      render();
    };
  }

  openSearch() {
    if (this.searching) return;
    this.searching = true;
    this.onOpen();
    this._resetSearch();
    this.box.classList.add('show');
    // focus after the key that opened the box has finished, so its letter is not typed into it
    setTimeout(() => this.input.focus(), 0);
  }

  closeSearch(place) {
    if (!this.searching) return;
    this.searching = false;
    this.box.classList.remove('show');
    this.input.blur();
    if (place) this.setDestination(place);
    this.onClose();
  }

  // ---------------------------------------------------------------- destination and route
  setDestination(place) {
    this.dest = place;
    this.route = null;
    this.routeAge = 9;
    this.arrived = 0;
    this.beacon.visible = !!place;
    if (place) this.beacon.position.set(place.x, 0, place.z);
  }

  _nearestNode(x, z) {
    let best = null, bd = Infinity;
    for (const n of this.graph.nodes) {
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  // Shortest way along the streets. Driving obeys one-way streets; on foot or in the air it need not.
  _route(from, to, driving) {
    const nodes = this.graph.nodes, n = nodes.length;
    const a = this._nearestNode(from.x, from.z), b = this._nearestNode(to.x, to.z);
    if (!a || !b) return null;
    const dist = new Float32Array(n).fill(Infinity), done = new Uint8Array(n), via = new Array(n), prev = new Int32Array(n).fill(-1);
    dist[a.id] = 0;
    for (;;) {
      let u = -1, best = Infinity;
      for (let i = 0; i < n; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
      if (u < 0 || u === b.id) break;
      done[u] = 1;
      for (const link of driving ? nodes[u].out : nodes[u].adj) {
        const v = link.to.id, d = best + link.edge.len;
        if (d < dist[v]) { dist[v] = d; prev[v] = u; via[v] = link; }
      }
    }
    if (dist[b.id] === Infinity) return null;
    const links = [];
    for (let v = b.id; v !== a.id; v = prev[v]) links.push(via[v]);
    links.reverse();
    const pts = [from.x, from.z];
    for (const link of links) {
      const p = link.edge.pts, count = p.length / 3;
      for (let i = 0; i < count; i++) {
        const j = link.forward ? i : count - 1 - i;
        pts.push(p[3 * j], p[3 * j + 1]);
      }
    }
    pts.push(to.x, to.z);
    return { pts, length: dist[b.id] };
  }

  // focus: { x, z } where the player (or their car) is. heading: which way "up" on the map should be.
  update(dt, focus, heading, altitude, driving, hudDest) {
    if (this.dest) {
      const d = Math.hypot(this.dest.x - focus.x, this.dest.z - focus.z);
      this.routeAge += dt;
      if (this.routeAge > 2.5) {
        this.routeAge = 0;
        this.route = this._route(focus, this.dest, driving);
      }
      const name = this.dest.n;
      hudDest.row.hidden = false;
      hudDest.text.textContent = `${name} · ${d >= 1000 ? (d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m'}`;
      if (d < 45) {
        this.arrived = 4;
        this.arrivedName = name;
        this.setDestination(null);
      }
    } else if (this.arrived > 0) {
      this.arrived -= dt;
      hudDest.row.hidden = false;
      hudDest.text.textContent = `Arrived: ${this.arrivedName}`;
    } else hudDest.row.hidden = true;

    if (++this.frame % 2 === 0) this._drawMinimap(focus, heading, altitude);
  }

  _drawMinimap(focus, heading, altitude) {
    const ctx = this.ctx, size = this.canvas.width, c = size / 2, rim = c - 3;
    const range = Math.min(1300, 230 + altitude * 1.3); // metres from the centre to the rim
    const k = rim / (range * S);
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, rim, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#2a2f37';
    ctx.fillRect(0, 0, size, size);
    ctx.translate(c, c);
    ctx.rotate(-heading);
    ctx.scale(k, k);
    ctx.drawImage(this.map, -(focus.x - this.x0) * S, -(focus.z - this.z0) * S);
    if (this.route) {
      const p = this.route.pts;
      ctx.beginPath();
      ctx.moveTo((p[0] - focus.x) * S, (p[1] - focus.z) * S);
      for (let i = 2; i < p.length; i += 2) ctx.lineTo((p[i] - focus.x) * S, (p[i + 1] - focus.z) * S);
      ctx.strokeStyle = '#ffd76a';
      ctx.lineWidth = (size / 60) / k;
      ctx.lineJoin = ctx.lineCap = 'round';
      ctx.stroke();
    }
    ctx.restore();

    // things drawn the right way up: destination pin (held at the rim when far), north mark, player arrow
    const cos = Math.cos(-heading), sin = Math.sin(-heading);
    if (this.dest) {
      const dx = (this.dest.x - focus.x) * S * k, dz = (this.dest.z - focus.z) * S * k;
      let sx = dx * cos - dz * sin, sy = dx * sin + dz * cos;
      const len = Math.hypot(sx, sy), max = rim - size * 0.045;
      if (len > max) { sx *= max / len; sy *= max / len; }
      ctx.beginPath();
      ctx.arc(c + sx, c + sy, size * 0.035, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd76a';
      ctx.fill();
      ctx.lineWidth = size * 0.012;
      ctx.strokeStyle = '#1a1f27';
      ctx.stroke();
    }
    ctx.font = `700 ${Math.round(size * 0.075)}px -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ff7a6a';
    ctx.fillText('N', c + sin * (rim - size * 0.07), c - cos * (rim - size * 0.07));
    ctx.beginPath();
    ctx.moveTo(c, c - size * 0.06);
    ctx.lineTo(c + size * 0.04, c + size * 0.045);
    ctx.lineTo(c, c + size * 0.022);
    ctx.lineTo(c - size * 0.04, c + size * 0.045);
    ctx.closePath();
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = size * 0.01;
    ctx.strokeStyle = '#1a1f27';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c, c, rim, 0, Math.PI * 2);
    ctx.lineWidth = size * 0.014;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.stroke();
  }
}
