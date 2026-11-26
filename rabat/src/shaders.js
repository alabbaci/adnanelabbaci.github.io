// All materials share one small lighting model (hemisphere ambient + one sun/moon + distance haze)
// so that day and night can be blended with a single number, env.uNight.
// Colours are authored and lit directly in display space; nothing here uses three's colour management.

import * as THREE from 'three';

const V = (r, g, b) => new THREE.Vector3(r, g, b);

const DAY = {
  sunDir: V(-0.38, 0.7, 0.6).normalize(),
  sun: V(0.8, 0.73, 0.62),
  sky: V(0.5, 0.56, 0.66),
  gnd: V(0.34, 0.33, 0.32),
  fog: V(0.76, 0.84, 0.93),
  zenith: V(0.2, 0.43, 0.8),
};
const NIGHT = {
  sunDir: V(0.42, 0.55, -0.72).normalize(),
  sun: V(0.07, 0.09, 0.15),
  sky: V(0.05, 0.06, 0.1),
  gnd: V(0.11, 0.085, 0.06),
  fog: V(0.082, 0.07, 0.088),
  zenith: V(0.012, 0.018, 0.05),
};

export const env = {
  uSunDir: { value: DAY.sunDir.clone() },
  uSunCol: { value: DAY.sun.clone() },
  uSkyCol: { value: DAY.sky.clone() },
  uGndCol: { value: DAY.gnd.clone() },
  uFogCol: { value: DAY.fog.clone() },
  uZenith: { value: DAY.zenith.clone() },
  uFogDensity: { value: 0.00019 },
  uNight: { value: 0 },
  uTime: { value: 0 },
  uShadowMap: { value: null },
  uShadowMatrix: { value: new THREE.Matrix4() },
  uShadowInfo: { value: new THREE.Vector4(0, 0, 700, 0) },
  // light-show shock waves: x, z of the impact and the time it happened (see lightshow.js)
  uWaves: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, 0, -1000, 0)) },
  // the show's colours: 1 = one palette for the whole city (cyan through violet to pink, a few towers in gold),
  // 0 = every tower its own colour of the rainbow
  uShowPalette: { value: 1 },
};
export const SUN_DIR = DAY.sunDir; // where the daytime sun is, for the shadow pass

// The cloud layer is slow to work out and the same wherever it is seen (the sky dome, every pane of glass
// that mirrors it), so it is drawn once into a texture that repeats: red = how much cloud there is, before
// its edge is cut; green = how dense its body. CLOUD_PERIOD: the size of one repeat, in the sky's own units.
const CLOUD_PERIOD = 16;
const cloudTarget = new THREE.WebGLRenderTarget(2048, 2048, {
  depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
  wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
});
env.uClouds = { value: cloudTarget.texture };
// Call once, before anything is drawn.
export function bakeClouds(renderer) {
  const material = new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      float hash21(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }
      // smooth noise that repeats every 'period' units, so the texture tiles without a seam
      float vnoise(vec2 p, float period) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash21(mod(i, period)), b = hash21(mod(i + vec2(1.0, 0.0), period));
        float c = hash21(mod(i + vec2(0.0, 1.0), period)), d = hash21(mod(i + vec2(1.0, 1.0), period));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
      float fbm(vec2 p, float period) {
        float a = 0.5, s = 0.0;
        for (int i = 0; i < 4; i++) {
          s += a * vnoise(p, period);
          p = p * 2.0 + 17.0;
          period *= 2.0;
          a *= 0.5;
        }
        return s;
      }
      void main() {
        const float P = ${CLOUD_PERIOD.toFixed(1)};
        vec2 p = vUv * P;
        float amount = fbm(p, P) * 0.8 + 0.2 * fbm(p * 3.0 + 9.0, P * 3.0);
        float body = fbm(p * 2.0 + 5.0, P * 2.0);
        gl_FragColor = vec4(amount, body, 0.0, 1.0);
      }`,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const before = renderer.getRenderTarget();
  renderer.setRenderTarget(cloudTarget);
  renderer.render(quad, new THREE.Camera());
  renderer.setRenderTarget(before);
  material.dispose();
  quad.geometry.dispose();
}

export function setNight(t) {
  env.uNight.value = t;
  env.uSunDir.value.lerpVectors(DAY.sunDir, NIGHT.sunDir, t).normalize();
  env.uSunCol.value.lerpVectors(DAY.sun, NIGHT.sun, t);
  env.uSkyCol.value.lerpVectors(DAY.sky, NIGHT.sky, t);
  env.uGndCol.value.lerpVectors(DAY.gnd, NIGHT.gnd, t);
  env.uFogCol.value.lerpVectors(DAY.fog, NIGHT.fog, t);
  env.uZenith.value.lerpVectors(DAY.zenith, NIGHT.zenith, t);
}

const COMMON = /* glsl */ `
uniform vec3 uSunDir, uSunCol, uSkyCol, uGndCol, uFogCol;
uniform float uFogDensity, uNight, uTime;
uniform highp sampler2DShadow uShadowMap; // compared and filtered by the GPU
uniform mat4 uShadowMatrix;
uniform vec4 uShadowInfo; // centre x, centre z, radius covered (m), strength 0..1
uniform vec4 uWaves[4];
uniform float uShowPalette;
uniform sampler2D uStreet;
uniform vec4 uStreetBox;
vec3 applyFog(vec3 col, float dist) {
  float f = dist * uFogDensity;
  return mix(col, uFogCol, 1.0 - exp(-f * f));
}
// 1 where the sun reaches this point, 0 where a building or tree is in the way (see shadows.js)
float sunShadow(vec3 wp, vec3 n) {
  if (uShadowInfo.w <= 0.0) return 1.0;
  float r = uShadowInfo.z;
  vec3 sc = (uShadowMatrix * vec4(wp + n * (0.6 * r / 700.0), 1.0)).xyz;
  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return 1.0;
  float depth = sc.z - 0.7 / (2.0 * r + 450.0);
  float lit = 0.0;
  for (int i = -1; i <= 1; i++)
    for (int j = -1; j <= 1; j++)
      lit += texture(uShadowMap, vec3(sc.xy + vec2(float(i), float(j)) * (1.0 / 4096.0), depth));
  lit /= 9.0;
  float edge = smoothstep(0.8, 1.0, distance(wp.xz, uShadowInfo.xy) / r);
  return mix(1.0, mix(lit, 1.0, edge), uShadowInfo.w);
}
// Light show: x = how strongly a shock front is passing this spot, y = how switched-on the spot is behind it.
vec2 showAt(vec2 xz) {
  float front = 0.0, on = 0.0;
  for (int i = 0; i < 4; i++) {
    float age = uTime - uWaves[i].z;
    if (age < 0.0 || age > 42.0) continue;
    float d = distance(xz, uWaves[i].xy), r = age * 230.0;
    front = max(front, (1.0 - smoothstep(0.0, 34.0, abs(d - r))) * exp(-age * 0.1));
    on = max(on, step(d, r) * (1.0 - smoothstep(28.0, 42.0, age)));
  }
  return vec2(front, on);
}
// Light from street lamps, signs and screens at night (bakeStreetLight). It comes from lamp height: full on
// the ground, fading up the walls, weaker on faces that do not look up.
vec3 streetLight(vec3 wp, vec3 n) {
  if (uNight <= 0.001) return vec3(0.0);
  vec3 l = texture2D(uStreet, (wp.xz - uStreetBox.xy) * uStreetBox.zw).rgb;
  l /= 1.0 + 0.55 * max(l.r, max(l.g, l.b)); // where many lamps overlap (junctions, squares) the eye has adapted: no burnt-out patches
  return l * (uNight * exp(-max(wp.y - 5.0, 0.0) / 7.0) * (0.5 + 0.5 * n.y));
}
vec3 lambert(vec3 n, vec3 wp) {
  float sun = max(dot(n, uSunDir), 0.0);
  if (sun > 0.0) sun *= sunShadow(wp, n);
  return mix(uGndCol, uSkyCol, n.y * 0.5 + 0.5) + uSunCol * sun + streetLight(wp, n);
}
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + 17.1;
    a *= 0.5;
  }
  return s;
}
`;

// ---------- light from street lamps, signs and screens at night ----------
// It is drawn once into a map of the city seen from above (red, green, blue: the light arriving on the
// ground at that spot); everything that stands in the streets is lit from it (streetLight() below).
const streetTarget = new THREE.WebGLRenderTarget(2048, 2048, { type: THREE.HalfFloatType, depthBuffer: false });
env.uStreet = { value: streetTarget.texture };
env.uStreetBox = { value: new THREE.Vector4(0, 0, 1, 1) }; // the map's corner (x, z) and 1 / its size
// bounds: { x0, x1, z0, z1 } in metres. lights: [x, z, height above the ground (m), red, green, blue, ...]:
// a lamp lights the ground under it at its colour and less further out, as a bare lamp at that height would.
export function bakeStreetLight(renderer, bounds, lights) {
  const count = lights.length / 6, margin = 80;
  const x0 = bounds.x0 - margin, z0 = bounds.z0 - margin, w = bounds.x1 - bounds.x0 + 2 * margin, d = bounds.z1 - bounds.z0 + 2 * margin;
  env.uStreetBox.value.set(x0, z0, 1 / w, 1 / d);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const data = new THREE.InstancedInterleavedBuffer(new Float32Array(lights), 6);
  geometry.setAttribute('aPlace', new THREE.InterleavedBufferAttribute(data, 3, 0));
  geometry.setAttribute('aColour', new THREE.InterleavedBufferAttribute(data, 3, 3));
  geometry.instanceCount = count;
  const material = new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, transparent: true,
    uniforms: { uBox: { value: new THREE.Vector4(x0, z0, 1 / w, 1 / d) } },
    vertexShader: /* glsl */ `
      attribute vec3 aPlace, aColour;
      uniform vec4 uBox;
      varying vec2 vAt;
      varying vec3 vColour;
      void main() {
        vAt = position.xy * 6.0;                       // in lamp heights from the foot of the lamp
        vColour = aColour;
        vec2 xz = aPlace.xy + vAt * aPlace.z;
        gl_Position = vec4((xz - uBox.xy) * uBox.zw * 2.0 - 1.0, 0.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vAt;
      varying vec3 vColour;
      void main() {
        float d2 = dot(vAt, vAt);
        float edge = max(1.0 - d2 / 36.0, 0.0);
        gl_FragColor = vec4(vColour * pow(1.0 + d2, -1.5) * edge * edge, 1.0);
      }`,
  });
  const quads = new THREE.Mesh(geometry, material);
  quads.frustumCulled = false;
  const before = renderer.getRenderTarget(), colour = renderer.getClearColor(new THREE.Color()), alpha = renderer.getClearAlpha();
  renderer.setRenderTarget(streetTarget);
  renderer.setClearColor(0x000000, 1);
  renderer.clear();
  renderer.render(quads, new THREE.Camera());
  renderer.setClearColor(colour, alpha);
  renderer.setRenderTarget(before);
  geometry.dispose();
  material.dispose();
}

// ---------- the sky, as a function: the dome draws it and glass mirrors it ----------
const SKY = /* glsl */ `
uniform vec3 uZenith;
uniform sampler2D uClouds; // the cloud layer, drawn once (bakeClouds)
// The sky in direction d: the gradient, the glow round the sun or moon, and a drifting layer of
// fair-weather cloud that thins and flattens towards the horizon. (The discs and the stars are
// added by the dome itself.)
vec3 skyAt(vec3 d) {
  vec3 col = mix(uFogCol, uZenith, pow(clamp(d.y, 0.0, 1.0), 0.5));
  float sd = max(dot(d, uSunDir), 0.0);
  col += mix(vec3(1.0, 0.93, 0.78) * pow(sd, 12.0) * 0.16, vec3(0.85, 0.9, 1.0) * pow(sd, 80.0) * 0.07, uNight);
  vec2 p = d.xz / (d.y + 0.14) * 2.1 + vec2(uTime * 0.0035, uTime * 0.0012);
  vec2 cloud = texture2D(uClouds, p / ${CLOUD_PERIOD.toFixed(1)}).rg;
  float cover = smoothstep(0.5, 0.7, cloud.r) * smoothstep(0.015, 0.2, d.y);
  float body = cloud.g;
  vec3 lit = mix(vec3(1.0, 0.98, 0.94) * (0.86 + 0.24 * pow(sd, 3.0)), vec3(0.17, 0.145, 0.15), uNight);
  vec3 shade = mix(vec3(0.66, 0.71, 0.8), vec3(0.06, 0.06, 0.085), uNight);
  return mix(col, mix(lit, shade, body * 0.75), cover * 0.94);
}
`;

// ---------- buildings: facades drawn in the shader ----------
// Every wall is a flat quad; all its detail is drawn here from a few numbers per vertex. Six styles
// (tools/build-city.mjs chooses one per building): 0 pre-war masonry, 1 brick walk-up, 2 art deco
// tower, 3 glass curtain wall, 4 ribbon windows, 5 dark metal grid; plus a shop-front ground floor,
// cornices, and the louvred plant floors at the top of modern towers. Windows are set back into the
// wall (the reveal slides with the viewpoint), glass mirrors the sky and a rough skyline, and behind
// it are rooms with depth, lit at night.
export function buildingMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { ...env },
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute vec4 aUv;    // x: bays along the wall, y: height above ground (m), z, w: this tier's base and top (m)
      attribute vec4 aInfo;  // x: per-building seed, y: 1 = roof, z: 1 = glass facade, w: style (+8 plant-floor screen, +16 a house of the Kasbah), over 255
      attribute vec2 aB;     // x: the whole building's top (m), y: width of one bay (m)
      varying vec3 vWorld, vNormal, vColor;
      varying vec4 vUv4, vInfo;
      varying vec2 vB;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz; vNormal = normal; vColor = aColor; vUv4 = aUv; vInfo = aInfo; vB = aB;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      ${SKY}
      varying vec3 vWorld, vNormal, vColor;
      varying vec4 vUv4, vInfo;
      varying vec2 vB;

      // 1 inside the rectangle lo..hi, with edges softened by aa
      float box(vec2 p, vec2 lo, vec2 hi, vec2 aa) {
        vec2 m = smoothstep(lo - aa, lo + aa, p) * (1.0 - smoothstep(hi - aa, hi + aa, p));
        return m.x * m.y;
      }
      // a line of half-width w at x = at
      float line(float x, float at, float w, float aa) {
        return 1.0 - smoothstep(w - aa, w + aa, abs(x - at));
      }
      vec3 hue(float h) {
        return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
      }

      // What a pane mirrors: the sky above; near and below the horizon, other buildings.
      vec3 mirrored(vec3 r, float seed) {
        float level = max(length(r.xz), 1e-3), elev = r.y / level;
        vec3 sky = skyAt(normalize(vec3(r.x, max(r.y, 0.03 * level), r.z)));
        float az = atan(r.z, r.x) * 7.0 + seed * 40.0;
        float blockId = floor(az), inBlock = fract(az);
        float tall = 0.03 + 0.55 * pow(hash21(vec2(blockId, 3.0 + floor(seed * 9.0))), 2.4);
        float there = (1.0 - smoothstep(tall - 0.012, tall + 0.012, elev)) * step(0.06, inBlock);
        float shadeSide = hash21(vec2(blockId, 11.0));
        vec3 wall = mix(vec3(0.34, 0.33, 0.33), vec3(0.62, 0.58, 0.52), shadeSide) * (uSkyCol * 1.05 + uSunCol * 0.55 * shadeSide);
        // their windows: a faint grid by day, scattered lights at night
        vec2 g = vec2(az * 9.0, elev * 60.0);
        float pane = step(0.35, fract(g.x)) * step(0.4, fract(g.y));
        wall *= 1.0 - 0.28 * pane * (1.0 - uNight);
        wall += vec3(1.0, 0.8, 0.5) * pane * step(0.72, hash21(floor(g) + blockId)) * uNight * 0.55;
        wall *= smoothstep(-1.2, 0.05, elev) * 0.5 + 0.5; // darker towards the street
        return mix(sky, wall, there);
      }

      // A room behind a window. p: where the view ray crosses the glass, 0..1 across the pane.
      // vt: direction to the eye in the wall's own frame (x along the wall, y up, z out of it).
      // Returns the room's colour: x, y, z, and in w how lit it is (for the glow at night).
      vec4 room(vec2 p, vec3 vt, vec2 id, float seed, float lit, vec3 tone, float office) {
        vec3 rd = -vt;
        rd.z = min(rd.z, -0.12);
        vec3 ro = vec3(p * 2.0 - 1.0, 0.0);
        const float deep = 2.4, wide = 1.5;
        vec3 inv = 1.0 / (rd + vec3(1e-4, 1e-4, 0.0));
        float tx = (sign(rd.x) * wide - ro.x) * inv.x;
        float ty = (sign(rd.y) - ro.y) * inv.y;
        float tz = -deep * inv.z;
        float t = min(tz, min(tx, ty));
        vec3 q = ro + rd * t;
        float pick = hash21(id + seed * 7.0 + 0.7);
        vec3 wallCol = mix(vec3(0.78, 0.74, 0.68), vec3(0.6, 0.66, 0.72), pick);
        vec3 c;
        float glow = 0.55;
        if (t == tz) {
          // the far wall, with something dark standing against it: shelves, a doorway, a desk
          c = wallCol * 0.82;
          float thing = step(0.45, hash21(floor(vec2(q.x * 1.5 + 9.0, 0.0)) + id * 3.1));
          c *= 1.0 - 0.45 * thing * step(q.y, -0.1 + 0.5 * hash21(id + floor(q.x * 1.5)));
        } else if (t == ty) {
          if (rd.y > 0.0) {
            // the ceiling: bright, with rows of fittings in offices
            c = wallCol;
            glow = 1.0;
            float fit = step(0.72, fract(q.z * 1.6)) * step(0.3, fract(q.x * 1.1));
            c += vec3(0.5) * fit * office;
          } else {
            c = vec3(0.3, 0.26, 0.22);
            glow = 0.3;
          }
        } else {
          c = wallCol * 0.7;
          glow = 0.45;
        }
        float fall = 1.0 - 0.3 * clamp(-q.z / deep, 0.0, 1.0);
        vec3 dayCol = c * 0.2 * fall;                       // by day a room is a dim place behind the glass
        vec3 nightCol = c * tone * glow * fall * lit * 2.3; // at night it is the light source
        return vec4(mix(dayCol, nightCol, uNight), lit * glow);
      }

      void main() {
        vec3 n = normalize(vNormal);
        vec3 toCam = cameraPosition - vWorld;
        float dist = length(toCam);
        vec3 view = toCam / dist;
        float seed = vInfo.x, roof = vInfo.y, glass = vInfo.z;
        float code = floor(vInfo.w * 255.0 + 0.5);
        float kasbah = step(15.5, code);
        code -= 16.0 * kasbah;
        float plant = step(7.5, code), style = code - 8.0 * plant;
        float sunFace = max(dot(n, uSunDir), 0.0);
        float lit0 = sunFace > 0.0 ? sunShadow(vWorld, n) : 0.0;
        vec3 ambient = mix(uGndCol, uSkyCol, n.y * 0.5 + 0.5);
        vec3 light = ambient + uSunCol * sunFace * lit0 + streetLight(vWorld, n);
        vec3 col;
        float win = 0.0; // how much of this pixel is window: the light show plays on it
        if (roof > 0.5) {
          // roofing felt and gravel, in a few greys, a little stained; the grain shows up close only
          float tone = 0.86 + 0.24 * hash21(vec2(seed * 61.0, 4.0));
          float stain = vnoise(vWorld.xz * 0.11 + seed * 20.0);
          float grain = hash21(floor(vWorld.xz * 2.0)) - 0.5;
          col = vColor * tone * (0.9 + 0.16 * stain + 0.04 * grain * clamp(1.0 - dist / 120.0, 0.0, 1.0)) * light;
          col += vec3(0.45, 0.8, 1.0) * showAt(vWorld.xz).x * 0.45;
        } else {
          float u = vUv4.x, y = vUv4.y, base = vUv4.z, top = vUv4.w, crownY = vB.x, bayM = max(vB.y, 0.5);
          vec3 T = vec3(-n.z, 0.0, n.x);
          vec3 vt = vec3(dot(view, T), view.y, max(dot(view, n), 0.05));
          // the building's own numbers
          // (6: a rampart, 7: a house of the old town; both are masonry, and are finished further down)
          float rampart = step(5.5, style) * (1.0 - step(6.5, style)), oldHouse = step(6.5, style);
          // battlements: merlons with gaps between them, cut out of the top of the wall
          if (rampart > 0.5 && y > top - 1.1 && fract(u * bayM / 2.7) > 0.6) discard;
          float fh = style < 0.5 ? 3.3 : style < 1.5 ? 3.0 : style < 2.5 ? 3.5 : style < 3.5 ? 4.0 : style < 4.5 ? 3.6 : style < 6.5 ? 3.8 : 3.1;
          float gf = oldHouse > 0.5 ? 3.0 : style < 0.5 ? 4.6 : style < 1.5 ? 3.4 : 5.2;
          float recess = style < 0.5 ? 0.26 : style < 1.5 ? 0.2 : style < 2.5 ? 0.3 : style < 3.5 ? 0.04 : style < 4.5 ? 0.12 : style < 6.5 ? 0.14 : 0.24;
          float masonry = max(1.0 - step(2.5, style), step(5.5, style));
          vec2 cell = vec2(u, (y - gf) / fh);
          vec2 id = floor(cell), f = fract(cell);
          vec2 fw = fwidth(cell), aa = fw * 0.75 + 0.0015;
          float lod = clamp((max(fw.x, fw.y) - 0.3) * 2.5, 0.0, 1.0);
          float near = 1.0 - lod;
          float r1 = hash21(id + seed * 91.7), r2 = hash21(vec2(id.y, seed * 173.3) + 3.1), r3 = hash21(id * 1.7 + seed * 37.1 + 11.0);

          // ---- the wall's own material
          float ao = mix(0.62, 1.0, smoothstep(0.0, 30.0, y));
          float blotch = vnoise(vec2(u * bayM * 0.11, y * 0.07) + seed * 23.0);
          vec3 wallCol = vColor * (0.93 + 0.14 * blotch);
          // brick courses or stone joints, close up
          float fine = clamp(1.0 - dist / 70.0, 0.0, 1.0);
          if (fine > 0.0 && masonry > 0.5) {
            // rendered and lime-washed walls: the faintest trace of the blocks under the plaster
            vec2 bs = vec2(0.9, 0.45);
            vec2 bc = vec2(u * bayM, y) / bs;
            bc.x += 0.5 * mod(floor(bc.y), 2.0);
            vec2 bf = fract(bc), bw = fwidth(bc) + 0.02;
            float joint = max(1.0 - smoothstep(0.0, bw.x * 1.5, min(bf.x, 1.0 - bf.x)), 1.0 - smoothstep(0.0, bw.y * 1.5, min(bf.y, 1.0 - bf.y)));
            joint *= clamp(1.0 - max(fwidth(bc.x), fwidth(bc.y)) * 1.6, 0.0, 1.0);
            wallCol *= 1.0 - fine * (0.05 * joint - 0.05 * (hash21(floor(bc) + seed * 3.0) - 0.5));
          }
          // rain streaks under the top of masonry walls
          wallCol *= 1.0 - 0.1 * masonry * vnoise(vec2(u * bayM * 1.3, y * 0.05) + seed * 5.0) * smoothstep(top - 14.0, top, y);

          // ---- where the openings are, by style
          vec2 lo = vec2(0.27, 0.2), hi = vec2(0.73, 0.8);
          float pierX = 0.0;
          if (style > 0.5 && style < 1.5) { lo = vec2(0.3, 0.22); hi = vec2(0.7, 0.78); }
          else if (style > 1.5 && style < 2.5) { lo = vec2(0.24, 0.3); hi = vec2(0.76, 1.02); pierX = 1.0; }
          else if (style > 2.5 && style < 3.5) { lo = vec2(0.035, 0.03); hi = vec2(0.965, 0.985); }
          else if (style > 3.5 && style < 4.5) { lo = vec2(0.03, 0.36); hi = vec2(0.97, 0.86); }
          else if (style > 6.5) { lo = vec2(0.36, 0.34); hi = vec2(0.64, 0.8); }
          else if (style > 4.5) { lo = vec2(0.1, 0.22); hi = vec2(0.9, 0.96); }
          // the glass sits back from the face of the wall: seen from the side the reveal slides into view
          vec2 slide = vt.xy / vt.z * recess / vec2(bayM, fh) * near;
          vec2 fr = f - slide;
          float opening = box(f, lo, hi, aa);
          float pane = box(fr, lo, hi, aa);
          float body = step(y, top - 0.9) * step(gf, y) * (1.0 - plant);  // parapets, the ground floor and plant floors have none
          body *= 1.0 - rampart;
          body *= mix(1.0, step(0.52, r1), oldHouse);                     // the houses of the medina look inwards: few windows on the lane
          float cover = (hi.x - lo.x) * (min(hi.y, 1.0) - lo.y);
          win = mix(opening * pane, cover, lod) * body;
          float reveal = opening * (1.0 - pane) * body * near;

          // ---- the wall face around the openings
          vec3 face = wallCol;
          if (style < 1.5 || oldHouse > 0.5) {
            // sills and lintels of lighter stone
            float trim = box(f, vec2(lo.x - 0.05, lo.y - 0.075), vec2(hi.x + 0.05, lo.y), aa) + box(f, vec2(lo.x - 0.04, hi.y), vec2(hi.x + 0.04, hi.y + 0.07), aa);
            face = mix(face, mix(vColor, vec3(0.8, 0.77, 0.7), 0.6), min(trim, 1.0) * near * 0.85);
            // a band of stone between the storeys every few floors
            float course = line(f.y, 0.0, 0.035, aa.y) * step(mod(id.y, 4.0), 0.5);
            face = mix(face, face * 1.16, course * near);
          } else if (pierX > 0.5) {
            // piers running the full height, fluted; dark metal spandrels between the windows
            float flute = 0.94 + 0.1 * smoothstep(0.0, 0.5, abs(fract(f.x * 4.0 + 0.5) - 0.5) * 2.0);
            face *= mix(1.0, flute, near);
            float strip = box(vec2(f.x, 0.5), vec2(lo.x, 0.0), vec2(hi.x, 1.0), aa);
            float span = strip * (1.0 - step(lo.y, f.y));
            vec3 metal = mix(vec3(0.2, 0.2, 0.2), vColor * 0.45, 0.4) * (0.85 + 0.3 * line(f.y, 0.15, 0.03, aa.y));
            face = mix(face, metal, mix(span, strip * lo.y, lod));
          } else if (style > 3.5 && style < 4.5) {
            // panels with a joint at every bay
            face *= 1.0 - 0.14 * line(f.x, 0.0, 0.012, aa.x) * near - 0.05 * (hash21(vec2(id.x, seed * 5.0)) - 0.5);
          } else if (style > 4.5 && style < 5.5) {
            // the frame itself: mullions proud of the glass
            face = mix(face, face * 1.5 + 0.03, line(f.x, 0.0, 0.035, aa.x) * near);
          } else if (style > 2.5) {
            // aluminium mullions and transoms
            face = mix(vec3(0.5, 0.52, 0.55), vColor, 0.35);
          }
          face *= ao * light;
          // the cornice: a pale band catching the light, a line of shadow under it
          if (masonry > 0.5) {
            float edge = smoothstep(top - 1.25, top - 1.1, y);
            float under = smoothstep(top - 2.1, top - 1.9, y) * (1.0 - edge);
            face = mix(face, wallCol * 1.18 * light, edge);
            face *= 1.0 - 0.38 * under;
          }
          // the reveal: the side or underside of the opening, usually in shade
          vec3 rn = fr.y > hi.y ? vec3(0.0, -1.0, 0.0) : fr.y < lo.y ? vec3(0.0, 1.0, 0.0) : fr.x < lo.x ? T : -T;
          vec3 revealCol = wallCol * 0.8 * (mix(uGndCol, uSkyCol, rn.y * 0.5 + 0.5) * 0.75 + uSunCol * max(dot(rn, uSunDir), 0.0) * lit0 * step(0.01, sunFace));

          // ---- the glass and what is behind it
          vec2 inPane = clamp((fr - lo) / (hi - lo), 0.0, 1.0);
          // no two panes are quite in one plane: each mirrors a slightly different piece of sky
          vec3 gn = normalize(n + (T * (r1 - 0.5) + vec3(0.0, r3 - 0.5, 0.0)) * (0.02 + 0.03 * glass) * near);
          vec3 refl = mirrored(reflect(-view, gn), seed);
          float fres = pow(1.0 - max(dot(gn, view), 0.0), 5.0);
          float mirror = clamp(mix(0.13, 0.4, glass) + 0.9 * fres, 0.0, 1.0);
          // rooms: some lit at night, the odd whole floor burning late
          float frac = 0.16 + 0.4 * fract(seed * 13.7);
          float lit = max(step(1.0 - frac, r1), step(0.9, r2));
          vec3 tone = mix(vec3(1.0, 0.77, 0.45), vec3(0.82, 0.9, 1.0), step(0.62, fract(seed * 5.1 + r2 * 0.37))) * (0.6 + 0.5 * hash21(id + 7.7));
          vec3 flatRoom = mix(vec3(0.045, 0.05, 0.055), tone * 1.25 * min(frac + 0.1, 1.0), uNight);
          vec3 point = mix(vec3(0.045, 0.05, 0.055), tone * lit * 1.5, uNight);
          float far = clamp((max(fw.x, fw.y) - 0.08) * 6.0, 0.0, 1.0); // rooms too small to see into
          vec3 inside = point;
          if (far < 1.0) inside = room(inPane, vt, id, seed, lit, tone, step(1.5, style)).rgb;
          vec3 behind = mix(mix(inside, point, far), flatRoom, lod);
          // blinds drawn to different heights (by day they are what you see of most offices)
          float blind = step(0.42, r3) * step(1.0 - (0.15 + 0.6 * fract(r3 * 7.0)), inPane.y);
          vec3 blindCol = vec3(0.62, 0.6, 0.55) * (ambient * 0.9 + uSunCol * sunFace * lit0 * 0.6) * (0.9 + 0.1 * step(0.5, fract(inPane.y * 22.0)));
          blindCol = mix(blindCol, blindCol * 0.25 + tone * 0.55 * lit, uNight);
          behind = mix(behind, blindCol, blind * near * (1.0 - glass * 0.6));
          vec3 tint = mix(vec3(1.0), mix(vec3(0.62, 0.74, 0.8), vColor * 1.25, 0.5), glass);
          vec3 glassCol = mix(behind * tint, refl * mix(vec3(1.0), tint, 0.5), mirror * mix(1.0, 0.75, uNight));
          // spandrel glass on curtain walls: the opaque band at each floor
          if (style > 2.5 && style < 3.5) {
            float band = 1.0 - smoothstep(0.24, 0.27, fr.y);
            glassCol = mix(glassCol, refl * tint * 0.55 + vColor * 0.16 * light, band * 0.75);
            // a louvred plant floor every twenty storeys or so
            float mech = step(mod(id.y + floor(seed * 20.0), 23.0), 0.5) * step(9.5, id.y);
            glassCol = mix(glassCol, vec3(0.12, 0.13, 0.14) * (0.7 + 0.6 * step(0.5, fract(y * 3.0))) * light, mech);
          }
          // glazing bars: a sash in old windows, thin mullions in ribbon windows
          float bars = 0.0;
          if (style < 1.5 || oldHouse > 0.5) bars = max(line(inPane.y, 0.5, 0.03, aa.y / max(hi.y - lo.y, 0.1)), line(inPane.x, 0.5, 0.02, aa.x / max(hi.x - lo.x, 0.1)) * step(0.5, r3));
          else if (style > 1.5 && style < 2.5) bars = line(inPane.x, 0.5, 0.03, aa.x * 2.0);
          glassCol = mix(glassCol, face * 0.55 + 0.02, bars * near * 0.9);
          // sunlight flashing off the glass
          float spec = pow(max(dot(reflect(-uSunDir, gn), view), 0.0), 90.0);
          glassCol += uSunCol * spec * (0.5 + 1.6 * glass) * lit0 * (1.0 - uNight);

          col = mix(face, revealCol, reveal);
          col = mix(col, glassCol, win);

          // ---- plant floors at the top of modern towers: louvres, and a wash of light at night
          if (plant > 0.5) {
            float slat = step(0.45, fract(y * 2.6));
            col = mix(vec3(0.32, 0.34, 0.36), vColor * 0.5, 0.4) * (0.62 + 0.38 * mix(slat, 0.55, clamp(fwidth(y * 2.6), 0.0, 1.0))) * light;
          }

          // ---- the ground floor: shop fronts, signs, doors, lobbies
          // a house's own front, where there is no shop: a studded door or a small barred window to each bay
          float houseFront = max(oldHouse, style > 0.5 && style < 1.5 ? step(hash21(vec2(seed * 31.0, 2.0)), 0.66) : 0.0) * (1.0 - rampart);
          if (y < gf && base < 0.5 && houseFront > 0.5) {
            float yy = y / gf, sid = floor(u), sf = fract(u);
            vec2 sa = vec2(fwidth(u), fwidth(yy)) * 0.75 + 0.0015;
            float hd = hash21(vec2(sid, seed * 71.0));
            float isDoor = step(0.6, hd);
            float doorW = 0.6 / max(bayM, 1.2);                          // a door about 1.2 m wide, whatever the bay
            float door = box(vec2(sf, yy), vec2(0.5 - doorW, -0.1), vec2(0.5 + doorW, 0.76), sa) * isDoor;
            float arch = box(vec2(sf, yy), vec2(0.5 - doorW - 0.03, -0.1), vec2(0.5 + doorW + 0.03, 0.82), sa) * isDoor;
            vec3 paintCol = hd > 0.88 ? vec3(0.17, 0.36, 0.6) : hd > 0.78 ? vec3(0.2, 0.38, 0.3) : hd > 0.7 ? vec3(0.5, 0.2, 0.14) : vec3(0.36, 0.25, 0.16);
            vec2 stud = fract(vec2(sf * bayM, y) * 5.0) - 0.5;
            paintCol *= 0.85 + 0.25 * step(0.5, fract(sf * bayM * 2.5)) + 0.3 * (1.0 - smoothstep(0.08, 0.14, length(stud))) * near;
            float grille = box(vec2(sf, yy), vec2(0.38, 0.5), vec2(0.62, 0.8), sa) * (1.0 - isDoor) * step(0.28, hd);
            vec3 wallG = wallCol * ao * light;
            // the Kasbah of the Udayas: the foot of every wall painted blue
            wallG = mix(wallG, vec3(0.2, 0.43, 0.78) * (0.92 + 0.16 * blotch) * ao * light, kasbah * (1.0 - smoothstep(0.52, 0.56, yy)));
            vec3 ground = mix(wallG, mix(wallCol, vec3(0.78, 0.74, 0.66), 0.5) * ao * light, arch * (1.0 - door));
            ground = mix(ground, paintCol * ao * light, door);
            vec3 dark = mix(vec3(0.05, 0.055, 0.06), vec3(1.0, 0.8, 0.5) * 0.7 * step(0.6, fract(hd * 13.0)), uNight);
            ground = mix(ground, dark * (0.6 + 0.4 * step(0.25, fract(sf * bayM * 6.0))), grille);
            col = ground;
            win = 0.0;
          } else if (y < gf && base < 0.5 && rampart < 0.5) {
            float yy = y / gf;
            float unit = u * 0.5, sid = floor(unit), sf = fract(unit);
            vec2 sa = vec2(fwidth(unit), fwidth(yy)) * 0.75 + 0.0015;
            float h1 = hash21(vec2(sid, seed * 71.0)), h2 = hash21(vec2(sid + 13.0, seed * 29.0));
            float lobby = step(0.78, h1);
            vec3 stone = mix(wallCol, vec3(0.3, 0.29, 0.28), 0.35 * masonry + 0.5 * (1.0 - masonry)) * ao * light;
            float shopGlass = box(vec2(sf, yy), vec2(0.07, 0.09), vec2(0.93, mix(0.66, 0.8, lobby)), sa);
            float door = box(vec2(sf, yy), vec2(0.4, 0.02), vec2(0.6, 0.58), sa);
            // a sign board or an awning over each shop, in the shop's own colour
            float board = box(vec2(sf, yy), vec2(0.07, 0.7), vec2(0.93, 0.9), sa) * (1.0 - lobby);
            float pickC = hash21(vec2(sid, 5.0));
            vec3 brand = pickC < 0.2 ? vec3(0.09, 0.1, 0.11) : pickC < 0.36 ? vec3(0.1, 0.24, 0.16) : pickC < 0.5 ? vec3(0.4, 0.09, 0.1) : pickC < 0.62 ? vec3(0.1, 0.15, 0.32) : pickC < 0.76 ? vec3(0.78, 0.76, 0.7) : pickC < 0.88 ? vec3(0.55, 0.36, 0.12) : mix(vec3(0.3), hue(h2), 0.55);
            float stripes = step(0.5, h2) * step(0.5, fract(sf * 14.0)) * 0.25;
            vec3 boardCol = brand * (1.0 - stripes) * (ambient + uSunCol * sunFace * lit0);
            boardCol += (brand * 0.9 + 0.12) * uNight * 1.3 * step(0.3, h2);     // lit signs
            // inside the shop: bright at night, a dim interior with goods by day
            vec3 shopRefl = mirrored(reflect(-view, n), seed);
            vec4 shop = room(vec2(sf, yy / 0.7), vt, vec2(sid, -1.0), seed, 1.0, mix(vec3(1.0, 0.9, 0.72), vec3(0.9, 0.95, 1.0), step(0.5, h2)), 0.0);
            float goods = step(0.5, hash21(floor(vec2(sf * 9.0, yy * 5.0)) + sid)) * step(yy, 0.4);
            vec3 inShop = shop.rgb * (1.0 + 0.9 * uNight) + mix(vec3(0.04), mix(vec3(0.3, 0.27, 0.22), hue(h2 + 0.3), 0.3) * 0.5, goods) * (0.35 + 0.65 * uNight);
            float shopFres = pow(1.0 - max(dot(n, view), 0.0), 5.0);
            vec3 shopCol = mix(inShop, shopRefl, clamp(0.1 + shopFres, 0.0, 1.0) * mix(1.0, 0.4, uNight));
            shopCol = mix(shopCol, shopCol * 0.6, door * (1.0 - box(vec2(sf, yy), vec2(0.42, 0.04), vec2(0.58, 0.56), sa)));
            float frame = max(line(sf, 0.5, 0.012, sa.x) * step(0.6, h2), line(yy, 0.52, 0.012, sa.y) * lobby);
            shopCol = mix(shopCol, vec3(0.08), frame * 0.8);
            vec3 ground = mix(stone, shopCol, shopGlass);
            ground = mix(ground, boardCol, board);
            // a line of shadow under the first-floor band
            ground *= 1.0 - 0.3 * smoothstep(0.9, 0.97, yy);
            float lodG = clamp((max(sa.x, sa.y) - 0.12) * 6.0, 0.0, 1.0);
            vec3 flatGround = mix(stone, mix(vec3(0.1), vec3(1.0, 0.86, 0.62) * 0.9, uNight), 0.5);
            col = mix(ground, flatGround, lodG);
            win = 0.0;
          }

          // ---- ramparts: rammed earth laid in lifts, the holes of the shuttering, weather from the top down
          if (rampart > 0.5) {
            float along = u * bayM;
            float liftJoint = 1.0 - smoothstep(0.015, 0.05, abs(fract(y / 0.85 + 0.5) - 0.5));
            vec2 hf = fract(vec2(along / 1.7, y / 0.85 + 0.5)) - 0.5;
            float hole = 1.0 - smoothstep(0.035, 0.06, max(abs(hf.x) * 1.7, abs(hf.y) * 0.85));
            float streak = vnoise(vec2(along * 0.9, y * 0.06) + seed * 9.0) * smoothstep(top - 7.0, top, y);
            float foot = 1.0 - smoothstep(0.0, 1.6, y);                 // the foot of the wall, worn pale
            vec3 earth = vColor * (0.86 + 0.26 * blotch) * (1.0 - 0.22 * streak);
            earth = mix(earth, earth * 1.12 + 0.03, foot * 0.6);
            earth *= 1.0 - fine * (0.12 * liftJoint + 0.45 * hole);
            col = earth * ao * light;
            // floodlit from the ground after dark, as the walls of Rabat are
            col += vColor * vec3(1.15, 0.8, 0.45) * uNight * 0.75 * (0.35 + 0.65 * smoothstep(top, 0.0, y)) * (0.8 + 0.2 * blotch);
            win = 0.0;
          }

          // ---- the glow at the crown of tall towers at night
          float crown = smoothstep(crownY - max(crownY * 0.07, 6.0), crownY, y) * step(110.0, crownY) * step(0.45, fract(seed * 3.3));
          vec3 crownCol = mix(vec3(1.0, 0.92, 0.75), hue(fract(seed * 11.0)) * 0.7 + 0.3, step(0.7, fract(seed * 17.0)));
          col += crownCol * crown * uNight * (0.35 + 0.5 * plant) * (1.0 - win * 0.6);

          // light show: behind the shock front every window joins in, each building with its own colour and rhythm
          vec2 show = showAt(vWorld.xz);
          if (show.x + show.y > 0.001) {
            float drift = fract(seed * 7.31 + uTime * 0.05);
            float city = fract(seed * 5.3) < 0.12 ? 0.11 : 0.53 + 0.4 * abs(2.0 * drift - 1.0);
            vec3 rgb = mix(vec3(1.0), hue(mix(fract(seed * 7.31 + uTime * 0.07), city, uShowPalette)), 0.85);
            float kind = fract(seed * 3.7), fl = (y - gf) / fh, beat;
            if (kind < 0.34) beat = 0.55 + 0.45 * sin(uTime * 4.0 + seed * 40.0);                       // whole tower pulsing
            else if (kind < 0.67) beat = smoothstep(0.3, 0.7, fract(fl / 14.0 - uTime * 0.6 + seed));   // bands climbing
            else beat = step(y / max(top, 3.4), 0.2 + 0.8 * abs(sin(uTime * (1.2 + 2.0 * hash21(vec2(id.x, seed * 9.0))) + id.x))); // equaliser bars
            float screen = max(win, plant * 0.8);
            col += (rgb * beat * show.y + vec3(0.8, 0.95, 1.0) * show.x * 1.6) * screen * 1.15 + rgb * show.x * 0.22;
          }
        }
        gl_FragColor = vec4(applyFog(col, dist), 1.0);
      }`,
  });
}

// ---------- flat-coloured geometry: ground, parks, roads, trees ----------
// marks: the geometry is a road with aMarkA/aMarkB attributes, and gets lane lines painted on it.
// surface: what the ground is made of, for close-up detail: 1 paving flags, 2 grass, 3 asphalt, 4 large pavers, 5 a path
export function flatMaterial({ emissive = [0, 0, 0], decal = false, doubleSide = false, offset = false, marks = false, surface = 0 } = {}) {
  return new THREE.ShaderMaterial({
    defines: { ...(marks ? { MARKS: 1 } : {}), SURFACE: surface },
    uniforms: { ...env, uEmissive: { value: V(...emissive) } },
    side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    depthTest: !decal,
    depthWrite: !decal,
    polygonOffset: offset,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      varying vec3 vWorld, vNormal, vColor;
      #ifdef MARKS
        attribute vec4 aMarkA, aMarkB;
        varying vec4 vMarkA, vMarkB;
      #endif
      void main() {
        vec3 p = position, n = normal, c = aColor;
        #ifdef MARKS
          vMarkA = aMarkA; vMarkB = aMarkB;
        #endif
        #ifdef USE_INSTANCING
          p = (instanceMatrix * vec4(p, 1.0)).xyz;
          n = mat3(instanceMatrix) * n;
        #endif
        #ifdef USE_INSTANCING_COLOR
          c *= instanceColor;
        #endif
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vWorld = wp.xyz; vNormal = n; vColor = c;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      uniform vec3 uEmissive;
      varying vec3 vWorld, vNormal, vColor;
      #ifdef MARKS
        varying vec4 vMarkA; // across (m, + = right of the drawing direction), along (m), stretch length (m), lane width (m)
        varying vec4 vMarkB; // lanes per direction, flags (1 one-way, 2 junction at start, 4 junction at end), parking line offset, kind (2 = crossing)
      #endif
      void main() {
        vec3 n = normalize(vNormal);
        if (!gl_FrontFacing) n = -n;
        vec3 base = vColor;
        #if SURFACE > 0
        {
          // what the ground is made of shows only on level ground and near enough to matter
          float eye = length(cameraPosition - vWorld);
          float level = step(0.9, abs(n.y));
          // across and along the streets of the ville nouvelle, which lie about 18 degrees off north
          vec2 g = vec2(vWorld.x * 0.9511 + vWorld.z * 0.309, vWorld.x * 0.309 - vWorld.z * 0.9511);
          #if SURFACE == 1 || SURFACE == 4
            // flags of concrete (or larger stone pavers): a grid of joints, each flag its own shade
            float cellSize = SURFACE == 1 ? 1.5 : 3.0;
            vec2 c = g / cellSize, cf = fract(c), cw = fwidth(c);
            float joint = max(1.0 - smoothstep(0.0, cw.x * 1.5 + 0.012, min(cf.x, 1.0 - cf.x)), 1.0 - smoothstep(0.0, cw.y * 1.5 + 0.012, min(cf.y, 1.0 - cf.y)));
            float sharp = clamp(1.0 - max(cw.x, cw.y) * 2.2, 0.0, 1.0);
            base *= 1.0 - level * sharp * (0.15 * joint - 0.07 * (hash21(floor(c)) - 0.5));
            base *= 0.95 + 0.1 * vnoise(vWorld.xz * 0.08);                    // stains and wear, at any distance
          #elif SURFACE == 2
            // grass: mottled, faintly striped by the mower, coarse blades up close
            float mottle = fbm(vWorld.xz * 0.035);
            float stripe = step(0.5, fract(g.x / 5.0)) * clamp(1.0 - fwidth(g.x / 5.0) * 2.0, 0.0, 1.0);
            float blades = (vnoise(vWorld.xz * 23.0) - 0.5) * clamp(1.0 - eye / 14.0, 0.0, 1.0);
            base *= 0.84 + 0.34 * mottle + 0.03 * stripe + 0.22 * blades;
            base = mix(base, base * vec3(1.12, 1.06, 0.78), smoothstep(0.55, 0.8, fbm(vWorld.xz * 0.012 + 7.0)) * 0.5); // drier patches
          #elif SURFACE == 3
            // asphalt: grain, darker and lighter patches, a few sealed cracks
            float grain = (vnoise(vWorld.xz * 31.0) - 0.5) * clamp(1.0 - eye / 22.0, 0.0, 1.0);
            float patches = vnoise(g * vec2(0.5, 0.07)) * 0.6 + vnoise(vWorld.xz * 0.045) * 0.4;
            base *= 0.9 + 0.2 * patches + 0.14 * grain;
            // long cracks, sealed with tar, running with the grain of the grid
            float crack = 1.0 - smoothstep(0.0, 0.008, abs(vnoise(g * vec2(0.55, 0.035) + 3.0) - 0.5));
            base *= 1.0 - 0.1 * crack * clamp(1.0 - eye / 40.0, 0.0, 1.0) * level;
          #elif SURFACE == 5
            // a made path: fine gravel in the surface
            float grit = (vnoise(vWorld.xz * 27.0) - 0.5) * clamp(1.0 - eye / 22.0, 0.0, 1.0);
            base *= 0.93 + 0.12 * vnoise(vWorld.xz * 0.12) + 0.13 * grit;
          #elif SURFACE == 6
            // sand: drifts, and wind ripples up close. A cemetery (the greyer of the two colours this layer
            // carries) is bare ground under close rows of low whitewashed graves, all facing one way.
            float drift = fbm(vWorld.xz * 0.03);
            float ripple = (vnoise(vec2(g.x * 0.6, g.y * 9.0)) - 0.5) * clamp(1.0 - eye / 30.0, 0.0, 1.0);
            float graveyard = step(vColor.g * 1.07, vColor.b + vColor.r * 0.24);
            base *= 0.9 + 0.18 * drift + 0.1 * ripple;
            vec2 gc = vec2(g.x / 1.5, g.y / 2.9), gf2 = fract(gc), gw = fwidth(gc);
            float tomb = step(0.22, gf2.x) * step(gf2.x, 0.78) * step(0.14, gf2.y) * step(gf2.y, 0.86) * step(0.25, hash21(floor(gc)));
            float seen = clamp(1.0 - max(gw.x, gw.y) * 1.4, 0.0, 1.0);
            base = mix(base, vec3(0.93, 0.92, 0.88) * (0.9 + 0.1 * hash21(floor(gc) + 3.0)), graveyard * mix(0.42, tomb, seen) * level);
          #elif SURFACE == 7
            // a track bed: sleepers across it, seen close
            float sleeper = step(0.55, fract(vnoise(vWorld.xz * 2.2) * 3.0)) * clamp(1.0 - eye / 60.0, 0.0, 1.0);
            base *= 0.92 + 0.1 * vnoise(vWorld.xz * 0.3) - 0.08 * sleeper;
          #endif
        }
        #endif
        #ifdef MARKS
        {
          float across = vMarkA.x, along = vMarkA.y, len = vMarkA.z, lw = vMarkA.w;
          float lanes = vMarkB.x, flags = vMarkB.y, park = vMarkB.z;
          float ax = fwidth(across) + 0.001, ay = fwidth(along) + 0.001;
          float paint = 0.0;
          vec3 paintCol = vec3(0.86, 0.86, 0.83);
          if (vMarkB.w > 1.5) {
            // zebra crossing: bars across the direction people walk
            float s = fract(along / 1.3);
            paint = smoothstep(0.0, ay / 1.3, s) * (1.0 - smoothstep(0.5, 0.5 + ay / 1.3, s));
          } else if (lanes > 0.5) {
            float oneWay = mod(flags, 2.0);
            float j0 = mod(floor(flags / 2.0), 2.0), j1 = mod(floor(flags / 4.0), 2.0);
            // nothing is painted inside a junction
            float open = smoothstep(8.5, 9.5, min(mix(1000.0, along, j0), mix(1000.0, len - along, j1)));
            // dashed dividers between lanes going the same way
            float u = oneWay > 0.5 ? across / lw + lanes * 0.5 : abs(across) / lw;
            float k = floor(u + 0.5);
            float divider = 1.0 - smoothstep(0.07, 0.07 + ax, abs(u - k) * lw);
            divider *= step(0.5, k) * step(k, lanes - 0.5);
            divider *= 1.0 - smoothstep(0.33, 0.33 + ay / 9.0, fract(along / 9.0));
            // solid edge of the kerbside parking lane
            float edge = park > 0.0 ? 0.8 * (1.0 - smoothstep(0.06, 0.06 + ax, abs(abs(across) - park))) : 0.0;
            paint = max(divider, edge) * open;
            // a solid white centre line on two-way streets
            float centre = (1.0 - oneWay) * open * (1.0 - smoothstep(0.07, 0.07 + ax, abs(across)));
            if (centre > paint) paint = centre;
            // stop lines just short of a junction, on the half of the road driving towards it
            float inLanes = step(abs(across), oneWay > 0.5 ? lanes * lw * 0.5 : lanes * lw);
            float stopEnd = j1 * (1.0 - smoothstep(0.25, 0.25 + ay, abs(len - along - 9.3))) * max(oneWay, step(0.0, across));
            float stopStart = (1.0 - oneWay) * j0 * (1.0 - smoothstep(0.25, 0.25 + ay, abs(along - 9.3))) * step(across, 0.0);
            float stop = max(stopEnd, stopStart) * inLanes;
            if (stop > paint) { paint = stop; paintCol = vec3(0.86, 0.86, 0.83); }
          }
          // once a line is thinner than a pixel, fade it out rather than let it shimmer
          paint *= clamp(1.5 - max(ax, ay) * 3.0, 0.0, 1.0);
          base = mix(base, paintCol, paint * 0.9);
        }
        #endif
        vec3 col = base * lambert(n, vWorld) + uEmissive * uNight;
        col += vec3(0.35, 0.7, 1.0) * showAt(vWorld.xz).x * 0.55;
        gl_FragColor = vec4(applyFog(col, length(cameraPosition - vWorld)), 1.0);
      }`,
  });
}

// ---------- water ----------
export function waterMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { ...env },
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      varying vec3 vWorld;
      void main() {
        vec3 toCam = cameraPosition - vWorld;
        float dist = length(toCam);
        vec3 view = toCam / dist;
        vec2 p = vWorld.xz;
        float near = clamp(1.0 - dist / 2200.0, 0.0, 1.0);
        float w = sin(p.x * 0.09 + uTime * 0.9) * sin(p.y * 0.12 - uTime * 0.7)
                + 0.5 * sin((p.x + p.y) * 0.33 + uTime * 1.6);
        vec3 deep = vec3(0.13, 0.27, 0.36), shallow = vec3(0.2, 0.37, 0.46);
        vec3 col = mix(deep, shallow, 0.5 + 0.22 * w * near) * (uSkyCol * 1.5 + uSunCol * 0.35);
        float fres = pow(1.0 - max(view.y, 0.0), 4.0);
        col = mix(col, uFogCol, fres * 0.55);
        vec3 nrm = normalize(vec3(0.05 * w * near, 1.0, 0.05 * w * near));
        float glint = pow(max(dot(reflect(-uSunDir, nrm), view), 0.0), 180.0);
        col += uSunCol * glint * 0.9;
        gl_FragColor = vec4(applyFog(col, dist), 1.0);
      }`,
  });
}

// ---------- street lights (night only) ----------
export function lightsMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { ...env, uScale: { value: 600 }, uSize: { value: 7 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      uniform float uScale, uSize, uFogDensity;
      varying float vFade;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = max(-mv.z, 0.1);
        gl_PointSize = clamp(uSize * uScale / d, 2.4, 30.0);
        float f = d * uFogDensity;
        vFade = exp(-f * f);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uNight;
      varying float vFade;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.0, r);
        gl_FragColor = vec4(vec3(1.0, 0.72, 0.4) * a * (0.35 + a) * uNight * vFade, 1.0);
      }`,
  });
}

// ---------- textured car models (instanced; the texture is multiplied by the car's paint) ----------
// Works instanced (cars, trees) or as a plain mesh (landmarks). glow: how brightly it is floodlit at night.
export function carMaterial(map, gloss = 0.25, glow = 0) {
  return new THREE.ShaderMaterial({
    uniforms: { ...env, uMap: { value: map }, uGloss: { value: gloss }, uGlow: { value: glow } },
    vertexShader: /* glsl */ `
      varying vec3 vWorld, vNormal, vColor;
      varying vec2 vUv;
      void main() {
        vec3 p = position;
        vNormal = normal;
        #ifdef USE_INSTANCING
          p = (instanceMatrix * vec4(p, 1.0)).xyz;
          vNormal = mat3(instanceMatrix) * normal;
        #endif
        vColor = vec3(1.0);
        #ifdef USE_INSTANCING_COLOR
          vColor = instanceColor;
        #endif
        vUv = uv;
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      uniform sampler2D uMap;
      uniform float uGloss, uGlow;
      varying vec3 vWorld, vNormal, vColor;
      varying vec2 vUv;
      void main() {
        vec3 n = normalize(vNormal);
        vec3 toCam = cameraPosition - vWorld;
        float dist = length(toCam);
        vec3 albedo = texture2D(uMap, vUv).rgb * vColor;
        vec3 col = albedo * lambert(n, vWorld) + albedo * vec3(1.0, 0.9, 0.72) * (uGlow * uNight);
        // a touch of paint gloss from the sun (none for trees)
        float spec = pow(max(dot(reflect(-uSunDir, n), toCam / dist), 0.0), 40.0);
        col += uSunCol * spec * uGloss * (1.0 - uNight);
        gl_FragColor = vec4(applyFog(col, dist), 1.0);
      }`,
  });
}

// ---------- landmark models ----------
// By day like any textured model. At night: floodlights wash the building, strongest at its crown (in the
// accent colour at the very top), and some of its windows (the dark openings in its texture) are lit.
// ground, height: where the building stands and how tall it is (m); accent: the colour of the light at the top.
// windows: how brightly lit windows show (0 for buildings whose texture has dark ornament rather than plain openings).
export function landmarkMaterial(map, { ground = 0, height = 100, accent = [1, 0.9, 0.72], seed = 0, windows = 0 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { ...env, uMap: { value: map }, uSpan: { value: new THREE.Vector3(ground, height, seed) }, uAccent: { value: V(...accent) }, uWindows: { value: windows } },
    vertexShader: /* glsl */ `
      varying vec3 vWorld, vNormal;
      varying vec2 vUv;
      void main() {
        vNormal = normal;
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      uniform sampler2D uMap;
      uniform vec3 uSpan, uAccent;
      uniform float uWindows;
      varying vec3 vWorld, vNormal;
      varying vec2 vUv;
      void main() {
        vec3 n = normalize(vNormal);
        vec3 toCam = cameraPosition - vWorld;
        float dist = length(toCam);
        vec3 albedo = texture2D(uMap, vUv).rgb;
        vec3 col = albedo * lambert(n, vWorld);
        float spec = pow(max(dot(reflect(-uSunDir, n), toCam / dist), 0.0), 40.0);
        col += uSunCol * spec * 0.08 * (1.0 - uNight);
        if (uNight > 0.001) {
          float h = clamp((vWorld.y - uSpan.x) / uSpan.y, 0.0, 1.0);
          // floodlights stand on the setbacks and shine up: the shaft is dim, the crown bright
          float wash = 0.2 + 1.05 * smoothstep(0.42, 0.9, h);
          vec3 washCol = mix(vec3(1.0, 0.9, 0.72), uAccent, smoothstep(0.78, 0.9, h));
          col += albedo * washCol * wash * uNight;
          // windows: one in three or so still lit, floor by floor
          float lum = dot(albedo, vec3(0.3, 0.59, 0.11));
          float opening = smoothstep(0.3, 0.17, lum);
          vec3 cell = floor(vec3(vWorld.x / 3.4, vWorld.y / 3.7, vWorld.z / 3.4));
          float lit = step(0.66, hash21(cell.xz * 1.3 + cell.y * 17.7 + uSpan.z));
          vec3 lamp = mix(vec3(1.0, 0.78, 0.46), vec3(0.85, 0.92, 1.0), step(0.75, hash21(cell.xz + cell.y * 3.1 + 5.0)));
          col += lamp * opening * lit * uNight * uWindows * (1.0 - 0.6 * smoothstep(0.8, 0.95, h));
        }
        gl_FragColor = vec4(applyFog(col, dist), 1.0);
      }`,
  });
}

// ---------- stand-in people: a blocky figure whose arms and legs swing in the vertex shader ----------
export function figureMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { ...env },
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute vec3 aPart; // x: 0 body, 1 left leg, 2 right leg, 3 left arm, 4 right arm; y: height of the joint it swings from; z: 1 if the clothing tint applies
      attribute vec3 aAnim; // per person: walk phase (radians), swing amount 0..1, unused
      varying vec3 vWorld, vNormal, vColor;
      void main() {
        float swing = sin(aAnim.x) * aAnim.y * 0.62;
        float id = aPart.x;
        // left leg and right arm go forward together, and the other pair opposite
        float ang = (id > 0.5 && id < 1.5) || id > 3.5 ? swing : (id > 1.5 && id < 3.5 ? -swing : 0.0);
        float c = cos(ang), s = sin(ang);
        vec3 p = position, n = normal;
        p.y -= aPart.y;
        p.yz = vec2(c * p.y - s * p.z, s * p.y + c * p.z);
        n.yz = vec2(c * n.y - s * n.z, s * n.y + c * n.z);
        p.y += aPart.y + abs(sin(aAnim.x)) * 0.03 * aAnim.y;
        vec3 tint = vec3(1.0);
        #ifdef USE_INSTANCING_COLOR
          tint = instanceColor;
        #endif
        vColor = aColor * mix(vec3(1.0), tint, aPart.z);
        vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
        vWorld = wp.xyz;
        vNormal = mat3(instanceMatrix) * n;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      varying vec3 vWorld, vNormal, vColor;
      void main() {
        vec3 n = normalize(vNormal);
        vec3 col = vColor * lambert(n, vWorld);
        gl_FragColor = vec4(applyFog(col, length(cameraPosition - vWorld)), 1.0);
      }`,
  });
}

// ---------- real character models: animation read from a texture (one texel per vertex per frame) ----------
// See people.js for how the textures are baked. Instanced, so a whole crowd is one draw call per character.
export function vatMaterial(map, posTex, norTex, verts, width) {
  return new THREE.ShaderMaterial({
    uniforms: { ...env, uMap: { value: map }, uPosTex: { value: posTex }, uNorTex: { value: norTex }, uVerts: { value: verts }, uWidth: { value: width } },
    vertexShader: /* glsl */ `
      uniform highp sampler2D uPosTex;
      uniform highp sampler2D uNorTex;
      uniform int uVerts, uWidth;
      attribute vec3 aAnim; // first frame of the clip, number of frames in it, position within it 0..1
      varying vec3 vWorld, vNormal, vColor;
      varying vec2 vUv;
      ivec2 cell(int frame) {
        int i = frame * uVerts + gl_VertexID;
        return ivec2(i % uWidth, i / uWidth);
      }
      void main() {
        int count = max(int(aAnim.y), 1), first = int(aAnim.x);
        float f = fract(aAnim.z) * float(count);
        int f0 = min(int(f), count - 1), f1 = (f0 + 1) % count;
        float k = fract(f);
        vec3 p = mix(texelFetch(uPosTex, cell(first + f0), 0).xyz, texelFetch(uPosTex, cell(first + f1), 0).xyz, k);
        vec3 n = mix(texelFetch(uNorTex, cell(first + f0), 0).xyz, texelFetch(uNorTex, cell(first + f1), 0).xyz, k) * 2.0 - 1.0;
        vColor = vec3(1.0);
        #ifdef USE_INSTANCING_COLOR
          vColor = instanceColor;
        #endif
        vUv = uv;
        vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
        vWorld = wp.xyz;
        vNormal = mat3(instanceMatrix) * n;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      uniform sampler2D uMap;
      varying vec3 vWorld, vNormal, vColor;
      varying vec2 vUv;
      void main() {
        vec3 n = normalize(vNormal);
        vec3 col = texture2D(uMap, vUv).rgb * vColor * lambert(n, vWorld);
        gl_FragColor = vec4(applyFog(col, length(cameraPosition - vWorld)), 1.0);
      }`,
  });
}

// ---------- car head- and tail-lights (night only, unlit) ----------
export function glowMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { ...env },
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      varying vec3 vColor;
      varying float vDist;
      void main() {
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        vColor = aColor;
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      varying vec3 vColor;
      varying float vDist;
      void main() {
        float f = vDist * uFogDensity;
        gl_FragColor = vec4(vColor * (exp(-f * f) * uNight), 1.0);
      }`,
  });
}

// ---------- sky dome ----------
export function skyMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { ...env },
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      ${SKY}
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 col = skyAt(d);
        float sd = max(dot(d, uSunDir), 0.0);
        col += mix(vec3(1.0, 0.93, 0.78) * pow(sd, 900.0) * 3.0, vec3(0.9, 0.93, 1.0) * (smoothstep(0.99982, 0.9999, sd) * (0.95 + 0.5 * vnoise(d.xz * 70.0 + d.y * 31.0)) + pow(sd, 700.0) * 0.1), uNight);
        vec3 g = floor(d * 420.0);
        float s = fract(sin(dot(g, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        col += vec3(0.9, 0.95, 1.0) * step(0.9985, s) * smoothstep(0.06, 0.35, d.y) * uNight * (0.4 + 0.6 * fract(s * 91.0));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}
