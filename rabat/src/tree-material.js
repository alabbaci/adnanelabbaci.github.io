import * as THREE from 'three';
import { carMaterial } from './shaders.js';
import {
  TREE_SPECIES, AZIMUTHS, ELEVATIONS, TILE, SPRAY_COLUMNS, IMPOSTOR_HEIGHT, IMPOSTOR_RADIUS,
} from './tree-geometry.js';

export const CORE_RANGE = [42, 69];
export const DETAIL_RANGE = [15, 29];
export const FAR_RANGE = [3150, 3550];
export const lodScale = (height) => Math.max(0.65, Math.sqrt(height / 11));
const f = (v) => Number.isInteger(v) ? v + '.0' : String(v);

const instances = /* glsl */ `
  attribute vec4 aPlace; // x, z, size, yaw (radians)
  attribute vec4 aTone; // brightness, yellow, seed, species
  uniform vec3 uPalette[${TREE_SPECIES.length}];
  uniform float uHeight[${TREE_SPECIES.length}];
  vec3 rotateY(vec3 p, vec2 turn) {
    return vec3(turn.x * p.x + turn.y * p.z, p.y, turn.x * p.z - turn.y * p.x);
  }
  vec3 treeTint(int kind) {
    return uPalette[kind] * aTone.x * vec3(1.0 + aTone.y * 0.20, 1.0 + aTone.y * 0.05, 1.0 - aTone.y * 0.32);
  }
  float lod(float d, float h, vec2 range) {
    return smoothstep(range.x, range.y, d / max(0.65, sqrt(h / 11.0)));
  }
`;

const lighting = /* glsl */ `
  vec3 foliage(vec3 base, vec3 n, float shadow, vec3 wp) {
    float incidence = dot(n, uSunDir);
    vec3 ambient = mix(uGndCol, uSkyCol, 0.5 + 0.5 * n.y);
    // Thin leaves transmit some sunlight at grazing and back-facing angles.
    vec3 transmission = uSunCol * vec3(0.64, 0.77, 0.36) * (0.12 + 0.26 * max(0.0, -incidence));
    // (street lamps at night reach the leaves from below and beside, whichever way they face)
    return base * (ambient + uSunCol * max(0.0, incidence) * shadow + transmission * (0.57 + 0.43 * shadow) + streetLight(wp, vec3(0.0, 0.3, 0.0)));
  }
  float coverage(float a) {
    return clamp((a - 0.38) / max(fwidth(a), 0.06) + 0.5, 0.0, 1.0);
  }
  vec3 bark(float shade) { return vec3(0.35, 0.305, 0.241) * shade; }

`;

const leafShadow = /* glsl */ `
  // The shared map already does a bilinear depth comparison in hardware. One tap is enough
  // at leaf scale; the full shared PCF remains on the larger bark surfaces.
  float leafShadow(vec3 world, vec3 n) {
    if (uShadowInfo.w <= 0.0) return 1.0;
    float radius = uShadowInfo.z;
    vec3 sc = (uShadowMatrix * vec4(world + n * (0.6 * radius / 700.0), 1.0)).xyz;
    if (any(lessThan(sc, vec3(0.0))) || any(greaterThan(sc, vec3(1.0)))) return 1.0;
    float lit = texture(uShadowMap, vec3(sc.xy, sc.z - 0.7 / (2.0 * radius + 450.0)));
    float edge = smoothstep(0.8, 1.0, distance(world.xz, uShadowInfo.xy) / radius);
    return 1.0 - (1.0 - lit) * uShadowInfo.w * (1.0 - edge);
  }
`;

export function treeMaterial(tier, map) {
  // carMaterial already carries the scene's shared GLSL and live uniform references.
  const material = carMaterial(map, 0);
  const shared = material.fragmentShader.split('uniform sampler2D uMap;')[0];
  material.uniforms.uPalette = { value: TREE_SPECIES.map((s) => new THREE.Vector3(...s.colour)) };
  material.uniforms.uHeight = { value: TREE_SPECIES.map((s) => s.height) };
  material.side = THREE.DoubleSide;
  material.alphaToCoverage = true;
  material.name = 'Trees ' + tier;
  if (tier === 'impostor') {
    material.side = THREE.FrontSide;
    material.vertexShader = /* glsl */ `
      ${instances}
      uniform highp sampler2DShadow uShadowMap;
      uniform mat4 uShadowMatrix;
      uniform vec4 uShadowInfo;
      ${leafShadow}
      varying vec3 vPlane;
      varying vec2 vUv, vTopUv;
      flat varying vec3 vTint;
      flat varying float vTopShadow;
      flat varying vec2 vTurn, vBlend;
      flat varying vec4 vCells;
      flat varying float vFade, vFar, vTop, vTopRow, vDistance;
      void main() {
        int kind = int(aTone.w);
        float h = uHeight[kind] * aPlace.z;
        vec3 origin = (modelMatrix * vec4(aPlace.x, h * ${f(IMPOSTOR_HEIGHT)}, aPlace.y, 1.0)).xyz;
        vec3 eye = cameraPosition - origin;
        float d = length(eye);
        vFade = lod(d, h, vec2(${CORE_RANGE.map(f)}));
        vFar = smoothstep(${FAR_RANGE.map(f)}, d);
        if (vFade <= 0.0 || vFar >= 1.0) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          return;
        }
        vec3 view = eye / d;
        float horizontal = length(view.xz);
        vec3 right = horizontal > 0.00002 ? vec3(view.z, 0.0, -view.x) / horizontal : vec3(1.0, 0.0, 0.0);
        float angle = (horizontal > 0.00002 ? atan(view.x, view.z + 0.000001) : 0.0) - aPlace.w;
        vec2 viewIndex = vec2(mod(angle * ${f(AZIMUTHS / (2 * Math.PI))}, ${f(AZIMUTHS)}),
          clamp(asin(view.y) * ${f((ELEVATIONS - 1) * 2 / Math.PI)}, 0.0, ${f(ELEVATIONS - 1)}));
        vec2 cell = floor(viewIndex);
        float row = aTone.w * ${f(ELEVATIONS)};
        vCells = vec4(cell.x, mod(cell.x + 1.0, ${f(AZIMUTHS)}),
          row + cell.y, row + min(cell.y + 1.0, ${f(ELEVATIONS - 1)}));
        vBlend = fract(viewIndex);
        vTurn = vec2(cos(aPlace.w), sin(aPlace.w));
        vTint = treeTint(kind);
        // A crown only a few pixels wide can use the tilted overhead projection from lower
        // angles. The richer side projections stay in the low flyover range.
        float small = smoothstep(165.0, 465.0, d);
        vTop = smoothstep(mix(0.80, 0.57, small), mix(0.91, 0.72, small), view.y);
        vTopRow = row + ${f(ELEVATIONS - 1)};
        vDistance = d;
        vTopShadow = vTop > 0.0
          ? leafShadow(origin + vec3(0.0, h * 0.31, 0.0), vec3(0.0, 1.0, 0.0)) : 1.0;
        // The vertical view needs only the crown footprint. The silhouette near the horizon
        // includes the trunk and needs the whole tile.
        vec2 p = position.xy * mix(1.0, 0.86, vTop);
        if (kind == 3) p *= mix(1.0, 0.79, vTop);
        float c = cos(angle), s = sin(angle);
        vTopUv = mat2(c, s, -s, c) * p;
        p.y *= mix(1.0, view.y, vTop);
        vUv = p;
        vPlane = origin + (right * p.x + cross(view, right) * p.y) * (h * ${f(IMPOSTOR_RADIUS)});
        gl_Position = projectionMatrix * viewMatrix * vec4(vPlane, 1.0);
      }`;
    material.fragmentShader = shared + lighting + leafShadow + /* glsl */ `
      uniform sampler2D uMap;
      varying vec3 vPlane;
      varying vec2 vUv, vTopUv;
      flat varying vec3 vTint;
      flat varying float vTopShadow;
      flat varying vec2 vTurn, vBlend;
      flat varying vec4 vCells;
      flat varying float vFade, vFar, vTop, vTopRow, vDistance;
      const vec2 atlasSize = vec2(${f(AZIMUTHS)}, ${f(ELEVATIONS * TREE_SPECIES.length)});
      vec4 viewAt(vec2 cell, vec2 uv, vec2 dx, vec2 dy) {
        vec2 p = clamp(uv, vec2(${f(0.5 / TILE)}), vec2(${f(1 - 0.5 / TILE)}));
        return textureGrad(uMap, (cell + p) / atlasSize, dx, dy);
      }
      vec3 unpack(vec2 oct) {
        oct = oct * 2.0 - 1.0;
        vec3 n = vec3(oct, 1.0 - abs(oct.x) - abs(oct.y));
        n.xy += mix(vec2(clamp(-n.z, 0.0, 1.0)), -vec2(clamp(-n.z, 0.0, 1.0)), step(0.0, n.xy));
        return n;
      }
      // Weight by coverage when blending so a transparent neighbouring view contributes no colour.
      vec4 combine(vec4 a, vec4 b, float t) {
        float alpha = mix(a.a, b.a, t);
        return vec4(mix(a.rgb * a.a, b.rgb * b.a, t) / max(alpha, 0.001), alpha);
      }
      void main() {
        vec2 uv = vUv * vec2(0.5, -0.5) + 0.5;
        vec2 topUv = vTopUv * vec2(0.5, -0.5) + 0.5;
        // Mip selection follows the projection rather than the locations of tiles in the atlas.
        vec2 dx = dFdx(uv) / atlasSize, dy = dFdy(uv) / atlasSize;
        vec2 topDx = dFdx(topUv) / atlasSize, topDy = dFdy(topUv) / atlasSize;
        vec4 sampleView;
        if (vTop >= 1.0) {
          // One vertical projection, rotated with the tree. No azimuth switches near the zenith.
          sampleView = viewAt(vec2(0.0, vTopRow), topUv, topDx, topDy);
        } else {
          vec4 a = viewAt(vCells.xz, uv, dx, dy), b = viewAt(vCells.yz, uv, dx, dy);
          sampleView = combine(a, b, vBlend.x);
          if (vBlend.y > 0.0001) {
            vec4 c = viewAt(vCells.xw, uv, dx, dy), d = viewAt(vCells.yw, uv, dx, dy);
            sampleView = combine(sampleView, combine(c, d, vBlend.x), vBlend.y);
          }
          if (vTop > 0.0)
            sampleView = combine(sampleView, viewAt(vec2(0.0, vTopRow), topUv, topDx, topDy), vTop);
        }
        // Overlap the coverage ramps so the silhouette stays filled through the handoff.
        float alpha = coverage(sampleView.a) * min(1.0, 1.75 * vFade) * (1.0 - vFar);
        if (alpha < 0.025) discard;
        vec3 n = normalize(unpack(sampleView.gb));
        n.xz = vec2(vTurn.x * n.x + vTurn.y * n.z, vTurn.x * n.z - vTurn.y * n.x);
        float shadow = vTopShadow;
        if (vTop < 1.0) shadow = mix(leafShadow(vPlane + n * 1.5, n), shadow, vTop);
        float tone = sampleView.r;
        vec3 lit = tone < 0.275 ? bark(tone * 255.0 / 43.0) * lambert(n, vPlane) :
          foliage(vTint * (tone * 255.0 / 143.0), n, shadow, vPlane);
        gl_FragColor = vec4(applyFog(lit, vDistance), alpha);
      }`;
    return material;
  }

  const range = tier === 'core' ? CORE_RANGE : DETAIL_RANGE;
  material.vertexShader = /* glsl */ `
    ${instances}
    uniform float uTime;
    uniform highp sampler2DShadow uShadowMap;
    uniform mat4 uShadowMatrix;
    uniform vec4 uShadowInfo;
    ${leafShadow}
    attribute vec3 aSurface, aAnchor;
    varying vec3 vWorld, vNormal, vSurface;
    varying float vLeafShadow;
    varying vec2 vUv;
    flat varying vec3 vTint;
    flat varying float vLod, vKind;
    void main() {
      int kind = int(aTone.w);
      float h = uHeight[kind] * aPlace.z;
      vec3 origin = (modelMatrix * vec4(aPlace.x, 0.0, aPlace.y, 1.0)).xyz;
      float d = distance(cameraPosition, origin + vec3(0.0, h * ${f(IMPOSTOR_HEIGHT)}, 0.0));
      vLod = lod(d, h, vec2(${range.map(f)}));
      if (vLod >= 1.0) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
      }
      vec2 turn = vec2(cos(aPlace.w), sin(aPlace.w));
      vec3 p = rotateY(position, turn) * aPlace.z;
      vec3 root = rotateY(aAnchor, turn) * aPlace.z;
      float gust = sin(uTime * 1.6 + dot(origin.xz + root.xz, vec2(0.125, 0.084)));
      float flutter = sin(uTime * 3.2 + aTone.z * 8.0 + dot(aAnchor, vec3(1.7, 0.8, -2.2)));
      p.xz += vec2(gust * 0.25 + flutter * 0.07, gust * 0.14 + flutter * 0.047) * aSurface.z * aPlace.z;
      vWorld = origin + p;
      vNormal = rotateY(normal, turn);
      vLeafShadow = aSurface.x >= 0.0 ? leafShadow(origin + root, vNormal) : 1.0;
      vSurface = aSurface;
      vTint = treeTint(kind);
      vKind = aTone.w;
      vUv = uv;
      gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
    }`;
  material.fragmentShader = shared + lighting + /* glsl */ `
    uniform sampler2D uMap;
    varying vec3 vWorld, vNormal, vSurface;
    varying float vLeafShadow;
    varying vec2 vUv;
    flat varying vec3 vTint;
    flat varying float vLod, vKind;
    void main() {
      vec3 n = normalize(vNormal);
      float alpha = 1.0;
      vec3 lit;
      if (vSurface.x >= 0.0) {
        vec2 uv = (vec2(vSurface.x, vKind) + vec2(vUv.x, 1.0 - vUv.y)) / vec2(${f(SPRAY_COLUMNS)}, ${f(TREE_SPECIES.length)});
        vec4 leaf = texture2D(uMap, uv);
        alpha = coverage(leaf.a);
        if (alpha < 0.025) discard;
        lit = foliage(vTint * vSurface.y * (0.62 + 0.57 * leaf.r), n, vLeafShadow, vWorld);
      } else {
        float grain = vUv.x * 58.0 + sin(vUv.y * 3.3 + vUv.x * 16.0) * 0.8;
        float cracks = 0.54 + 0.46 * smoothstep(0.09, 0.39, fract(grain * 0.81));
        float flecks = hash21(floor(vec2(grain, vUv.y * 22.0)));
        float knots = sin(vUv.x * 18.85 + sin(vUv.y * 2.2)) * sin(vUv.y * 7.7 - vUv.x * 30.0);
        float detail = 0.78 + 0.34 * mix(cracks, flecks, 0.37) + 0.09 * knots;
        lit = bark(vSurface.y * detail) * lambert(n, vWorld);
      }
      alpha *= min(1.0, 1.75 * (1.0 - vLod));
      gl_FragColor = vec4(applyFog(lit, distance(cameraPosition, vWorld)), alpha);
    }`;
  return material;
}
