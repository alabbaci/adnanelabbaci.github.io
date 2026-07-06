/* Casablanca // night grid — runtime.
   Decodes the packed payload P, builds one merged building mesh +
   road LineSegments, renders with bloom + custom sci-fi shaders. */
(function () {
  'use strict';

  // ---------- decode payload ----------
  function dec(s, T) {
    var b = atob(s), u = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return new T(u.buffer);
  }
  var SC = P.meta.scale;
  var bLens = dec(P.bldRingLens, Uint16Array),
      bRole = dec(P.bldRingRole, Uint8Array),
      bPer  = dec(P.bldRingsPer, Uint8Array),
      bStart = dec(P.bldStarts, Int32Array),
      bDelta = dec(P.bldDeltas, Int16Array),
      bH = dec(P.bldHeights, Float32Array),
      rLens = dec(P.roadLens, Uint16Array),
      rStart = dec(P.roadStarts, Int32Array),
      rDelta = dec(P.roadDeltas, Int16Array);

  // ---------- reconstruct absolute vertices (meters) ----------
  function unpack(lens, starts, deltas) {
    var total = 0, i;
    for (i = 0; i < lens.length; i++) total += lens[i];
    var xs = new Float64Array(total), ys = new Float64Array(total);
    var off = new Uint32Array(lens.length + 1);
    var v = 0, d = 0;
    for (i = 0; i < lens.length; i++) {
      off[i] = v;
      var qx = starts[2 * i], qy = starts[2 * i + 1];
      xs[v] = qx / SC; ys[v] = qy / SC; v++;
      for (var k = 1; k < lens[i]; k++) {
        qx += deltas[d++]; qy += deltas[d++];
        xs[v] = qx / SC; ys[v] = qy / SC; v++;
      }
    }
    off[lens.length] = v;
    return { xs: xs, ys: ys, off: off };
  }
  var B = unpack(bLens, bStart, bDelta);
  var R = unpack(rLens, rStart, rDelta);

  // center scene on the buildings' bounding-box midpoint
  var minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (var i = 0; i < B.xs.length; i++) {
    if (B.xs[i] < minx) minx = B.xs[i];
    if (B.xs[i] > maxx) maxx = B.xs[i];
    if (B.ys[i] < miny) miny = B.ys[i];
    if (B.ys[i] > maxy) maxy = B.ys[i];
  }
  var cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
  // map (x, y) -> three.js (x, -y); height on +Y
  function WX(x) { return x - cx; }
  function WZ(y) { return -(y - cy); }

  // ---------- height color ramp (log scale) ----------
  var STOPS = [
    [0.00, 0x1b, 0x2b, 0x4a],
    [0.45, 0x74, 0x84, 0xa6],
    [0.75, 0x9f, 0xd8, 0xe8],
    [1.00, 0xea, 0xff, 0xff]
  ];
  var LOG_DEN = Math.log(320 / 6);
  function ramp(h, out) {
    var t = Math.log(Math.max(h, 6) / 6) / LOG_DEN;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    for (var s = 1; s < STOPS.length; s++) {
      if (t <= STOPS[s][0] || s === STOPS.length - 1) {
        var a = STOPS[s - 1], b = STOPS[s];
        var f = (t - a[0]) / (b[0] - a[0]);
        out[0] = a[1] + (b[1] - a[1]) * f;
        out[1] = a[2] + (b[2] - a[2]) * f;
        out[2] = a[3] + (b[3] - a[3]) * f;
        return;
      }
    }
  }

  // ---------- build merged building geometry ----------
  // pass 1: earcut every polygon (outer ring + following holes), count roof tris
  var nRings = bLens.length;
  var roofIdx = [], roofPoly = [], roofTriTotal = 0;
  var ring = 0;
  for (var b = 0; b < P.meta.nBld; b++) {
    var last = ring + bPer[b];
    while (ring < last) {
      // polygon group: outer at `ring`, holes follow until next role 0
      var pStart = ring, pEnd = ring + 1;
      while (pEnd < last && bRole[pEnd] === 1) pEnd++;
      var flat = [], holes = [], vcount = 0, rr;
      for (rr = pStart; rr < pEnd; rr++) {
        if (rr > pStart) holes.push(vcount);
        for (var vv = B.off[rr]; vv < B.off[rr + 1]; vv++) {
          flat.push(WX(B.xs[vv]), WZ(B.ys[vv]));
          vcount++;
        }
      }
      var idx = earcut(flat, holes.length ? holes : null);
      roofIdx.push(idx);
      roofPoly.push([pStart, flat]);
      roofTriTotal += idx.length / 3;
      ring = pEnd;
    }
  }

  var wallVerts = 0;
  for (i = 0; i < nRings; i++) wallVerts += bLens[i] * 6; // 2 tris per edge
  var roofVerts = roofTriTotal * 3;
  var NV = wallVerts + roofVerts;

  var pos = new Float32Array(NV * 3);
  var colA = new Uint8Array(NV * 3);
  var nrmA = new Int8Array(NV * 3);

  // sun direction in plan (x, y) = (-0.55, 0.75) -> world (x, z) = (-0.55, -0.75)
  var sl = Math.hypot(0.55, 0.75), sunX = -0.55 / sl, sunZ = -0.75 / sl;
  var base = [0, 0, 0];
  var p = 0; // vertex cursor

  function put(x, y, z, r, g, bl, nx, ny, nz) {
    var p3 = p * 3;
    pos[p3] = x; pos[p3 + 1] = y; pos[p3 + 2] = z;
    colA[p3] = r; colA[p3 + 1] = g; colA[p3 + 2] = bl;
    nrmA[p3] = nx; nrmA[p3 + 1] = ny; nrmA[p3 + 2] = nz;
    p++;
  }

  // pass 2a: walls
  ring = 0;
  for (b = 0; b < P.meta.nBld; b++) {
    var h = bH[b]; if (!(h > 0.5)) h = 8;
    ramp(h, base);
    var lastR = ring + bPer[b];
    for (; ring < lastR; ring++) {
      var v0 = B.off[ring], L = bLens[ring];
      for (var e = 0; e < L; e++) {
        var ia = v0 + e, ib = v0 + ((e + 1) % L);
        var ax = WX(B.xs[ia]), az = WZ(B.ys[ia]);
        var bx = WX(B.xs[ib]), bz = WZ(B.ys[ib]);
        var dx = bx - ax, dz = bz - az;
        var len = Math.hypot(dx, dz);
        if (len < 1e-9) continue;
        // outward wall normal in the ground plane
        var nx = -dz / len, nz = dx / len;
        var lam = 0.42 + 0.58 * Math.max(0, nx * sunX + nz * sunZ);
        var r = Math.min(255, base[0] * lam) | 0,
            g = Math.min(255, base[1] * lam) | 0,
            bb = Math.min(255, base[2] * lam) | 0;
        var n8x = Math.round(nx * 127), n8z = Math.round(nz * 127);
        put(ax, 0, az, r, g, bb, n8x, 0, n8z);
        put(bx, 0, bz, r, g, bb, n8x, 0, n8z);
        put(bx, h, bz, r, g, bb, n8x, 0, n8z);
        put(ax, 0, az, r, g, bb, n8x, 0, n8z);
        put(bx, h, bz, r, g, bb, n8x, 0, n8z);
        put(ax, h, az, r, g, bb, n8x, 0, n8z);
      }
    }
  }

  // pass 2b: roofs (face up)
  // map ring index -> building height: rebuild per-building cursor
  var ringHeights = new Float32Array(nRings);
  ring = 0;
  for (b = 0; b < P.meta.nBld; b++) {
    var hh = bH[b]; if (!(hh > 0.5)) hh = 8;
    for (var q = 0; q < bPer[b]; q++) ringHeights[ring++] = hh;
  }
  for (var pg = 0; pg < roofIdx.length; pg++) {
    var idx2 = roofIdx[pg];
    var startRing = roofPoly[pg][0], flat2 = roofPoly[pg][1];
    var rh = ringHeights[startRing];
    ramp(rh, base);
    var r2 = Math.min(255, base[0] * 1.15) | 0,
        g2 = Math.min(255, base[1] * 1.15) | 0,
        b2 = Math.min(255, base[2] * 1.15) | 0;
    for (var t = 0; t < idx2.length; t += 3) {
      var i0 = idx2[t], i1 = idx2[t + 1], i2 = idx2[t + 2];
      var x0 = flat2[2 * i0], z0 = flat2[2 * i0 + 1];
      var x1 = flat2[2 * i1], z1 = flat2[2 * i1 + 1];
      var x2 = flat2[2 * i2], z2 = flat2[2 * i2 + 1];
      // upward normal: cross((p1-p0),(p2-p0)).y = z1'*x2' - x1'*z2'
      var crossY = (z1 - z0) * (x2 - x0) - (x1 - x0) * (z2 - z0);
      if (crossY < 0) { var tmp = i1; i1 = i2; i2 = tmp;
        tmp = x1; x1 = x2; x2 = tmp; tmp = z1; z1 = z2; z2 = tmp; }
      put(x0, rh, z0, r2, g2, b2, 0, 127, 0);
      put(x1, rh, z1, r2, g2, b2, 0, 127, 0);
      put(x2, rh, z2, r2, g2, b2, 0, 127, 0);
    }
  }
  roofIdx = roofPoly = null;

  var bGeom = new THREE.BufferGeometry();
  bGeom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  bGeom.setAttribute('color', new THREE.BufferAttribute(colA, 3, true));
  bGeom.setAttribute('normal', new THREE.BufferAttribute(nrmA, 3, true));

  // ---------- roads geometry (line segments) ----------
  var nRoadSegs = 0;
  for (i = 0; i < rLens.length; i++) nRoadSegs += rLens[i] - 1;
  var rpos = new Float32Array(nRoadSegs * 2 * 3);
  var rp = 0;
  for (i = 0; i < rLens.length; i++) {
    for (var s2 = R.off[i], e2 = R.off[i + 1] - 1; s2 < e2; s2++) {
      rpos[rp++] = WX(R.xs[s2]); rpos[rp++] = 0.6; rpos[rp++] = WZ(R.ys[s2]);
      rpos[rp++] = WX(R.xs[s2 + 1]); rpos[rp++] = 0.6; rpos[rp++] = WZ(R.ys[s2 + 1]);
    }
  }
  var rGeom = new THREE.BufferGeometry();
  rGeom.setAttribute('position', new THREE.BufferAttribute(rpos, 3));

  // ---------- scene ----------
  var FOG = new THREE.Color(0x07090c);
  var scene = new THREE.Scene();
  scene.background = FOG.clone();
  scene.fog = new THREE.Fog(FOG.clone(), 7000, 17000);

  var renderer = new THREE.WebGLRenderer({
    antialias: true, powerPreference: 'high-performance'
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  var camera = new THREE.PerspectiveCamera(
    50, window.innerWidth / window.innerHeight, 2, 40000);
  camera.position.set(2600, 2100, 3400);
  camera.lookAt(0, 0, 0);

  var U = {
    uTime: { value: 0 },
    uScan: { value: 1 },
    uPulse: { value: 1 },
    uCam: { value: new THREE.Vector3() }
  };

  var bldMat = new THREE.ShaderMaterial({
    uniforms: U,
    vertexColors: true,
    transparent: true,
    depthWrite: true,
    side: THREE.DoubleSide,
    vertexShader: [
      'varying vec3 vC; varying vec3 vN; varying vec3 vW;',
      'void main(){',
      '  vC = color;',
      '  vN = normal;',
      '  vec4 wp = modelMatrix * vec4(position, 1.0);',
      '  vW = wp.xyz;',
      '  gl_Position = projectionMatrix * viewMatrix * wp;',
      '}'
    ].join('\n'),
    fragmentShader: [
      'uniform float uTime; uniform float uScan; uniform float uPulse;',
      'uniform vec3 uCam;',
      'varying vec3 vC; varying vec3 vN; varying vec3 vW;',
      'void main(){',
      '  vec3 col = vC;',
      '  float wall = step(abs(vN.y), 0.6);',
      // floor scanlines: lit band every 3 m of world height
      '  float fl = fract(vW.y / 3.0);',
      '  float band = smoothstep(0.55, 0.35, fl) * smoothstep(0.05, 0.25, fl);',
      '  col += uScan * wall * band * vec3(0.10, 0.22, 0.30);',
      // fresnel rim
      '  float fr = pow(1.0 - abs(dot(normalize(vN), normalize(uCam - vW))), 2.6);',
      '  col += fr * vec3(0.18, 0.55, 0.70) * 0.9;',
      // city pulse: radial wave from center, cyan<->pink drift
      '  float d = length(vW.xz);',
      '  float ph = mod(d - uTime * 220.0, 2800.0);',
      '  float w = exp(-abs(ph - 200.0) / 110.0);',
      '  col += uPulse * w * mix(vec3(0.15, 0.5, 0.6), vec3(0.65, 0.12, 0.45),',
      '                          0.5 + 0.5 * sin(uTime * 0.7)) * 0.5;',
      // distance fog toward background
      '  float fogF = smoothstep(7000.0, 17000.0, distance(uCam, vW));',
      '  col = mix(col, vec3(0.0275, 0.0353, 0.0471), fogF);',
      '  gl_FragColor = vec4(col, 0.93);',
      '}'
    ].join('\n')
  });
  var city = new THREE.Mesh(bGeom, bldMat);
  city.frustumCulled = false;
  scene.add(city);

  var roadMat = new THREE.ShaderMaterial({
    uniforms: U,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: [
      'varying vec3 vW;',
      'void main(){',
      '  vec4 wp = modelMatrix * vec4(position, 1.0);',
      '  vW = wp.xyz;',
      '  gl_Position = projectionMatrix * viewMatrix * wp;',
      '}'
    ].join('\n'),
    fragmentShader: [
      'uniform float uTime; uniform float uPulse; uniform vec3 uCam;',
      'varying vec3 vW;',
      'void main(){',
      '  float d = length(vW.xz);',
      '  float ph = mod(d - uTime * 220.0, 2800.0);',
      '  float w = exp(-abs(ph - 200.0) / 110.0);',
      '  vec3 pink = vec3(1.0, 0.176, 0.584);',  // #ff2d95
      '  vec3 col = pink * (0.55 + uPulse * 0.85 * w);',
      '  float fogF = smoothstep(7000.0, 17000.0, distance(uCam, vW));',
      '  gl_FragColor = vec4(col * (1.0 - fogF), 0.85);',
      '}'
    ].join('\n')
  });
  var roads = new THREE.LineSegments(rGeom, roadMat);
  roads.frustumCulled = false;
  scene.add(roads);

  var ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60000, 60000),
    new THREE.MeshBasicMaterial({ color: 0x0b0e13 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.6;
  scene.add(ground);

  // ---------- post-processing ----------
  var composer = new THREE.EffectComposer(renderer);
  composer.addPass(new THREE.RenderPass(scene, camera));
  var bloom = new THREE.UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.85, 0.45, 0.55);
  composer.addPass(bloom);

  // ---------- controls ----------
  var controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI / 2 - 0.02;
  controls.minDistance = 60;
  controls.maxDistance = 15000;
  controls.target.set(0, 0, 0);

  // ---------- UI ----------
  document.getElementById('nBld').textContent =
    P.meta.nBld.toLocaleString('en-US');
  document.getElementById('nRoad').textContent =
    P.meta.nRoad.toLocaleString('en-US');
  var useBloom = true;
  document.getElementById('cbBloom').addEventListener('change', function (e) {
    useBloom = e.target.checked;
  });
  document.getElementById('cbScan').addEventListener('change', function (e) {
    U.uScan.value = e.target.checked ? 1 : 0;
  });
  document.getElementById('cbPulse').addEventListener('change', function (e) {
    U.uPulse.value = e.target.checked ? 1 : 0;
  });

  window.addEventListener('resize', function () {
    var w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
  });

  // ---------- loop ----------
  var t0 = performance.now();
  function frame() {
    requestAnimationFrame(frame);
    U.uTime.value = (performance.now() - t0) / 1000;
    U.uCam.value.copy(camera.position);
    controls.update();
    if (useBloom) composer.render(); else renderer.render(scene, camera);
  }
  frame();
})();
