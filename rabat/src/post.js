// The picture after the scene is drawn: glow round bright lights, highlights that roll off instead of
// clipping, a touch of grading and a vignette. For recordings it can also expose each frame for a real
// stretch of time (several renders averaged), which is what gives fast camera moves their motion blur.
//
// Everything in the game writes display-space colour directly (see shaders.js). The scene is drawn into
// a floating-point buffer, so lights can be brighter than white there: the glow feeds on exactly those.
//
// The glow: the bright parts of the scene at half size, shrunk again and again (each step a wider,
// softer copy), then added back together on the way up. One pass over the full picture at the end
// adds the glow and grades. The scene itself may be drawn smaller than the picture (`scale`) and
// enlarged in that last pass: that is how the game holds its frame rate on a slow graphics card.

import * as THREE from 'three';
import { env } from './shaders.js';

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`;

// how many times the bright parts are halved, and how much of each size goes into the glow:
// from a tight halo (a quarter of the picture's size) to a haze as wide as the picture
const LEVELS = 8;
const WEIGHTS = [0, 0.5, 0.35, 0.4, 0.35, 0.4, 0.5, 0.5];

// what is brighter than the threshold, at half size (each of the four pixels judged on its own, so a
// single bright lamp is not lost among dark neighbours); uWeight < 1 when several renders are summed
const BRIGHT = /* glsl */ `
  uniform sampler2D tMap;
  uniform vec2 uTexel;
  uniform float uThreshold, uWeight;
  varying vec2 vUv;
  vec3 bright(vec2 at) {
    vec3 c = max(texture2D(tMap, at).rgb, 0.0);
    return c * smoothstep(uThreshold, uThreshold + 0.01, dot(c, vec3(0.2126, 0.7152, 0.0722)));
  }
  void main() {
    vec2 o = uTexel * 0.5;
    vec3 c = bright(vUv + vec2(-o.x, -o.y)) + bright(vUv + vec2(o.x, -o.y)) + bright(vUv + vec2(-o.x, o.y)) + bright(vUv + o);
    gl_FragColor = vec4(c * 0.25 * uWeight, 1.0);
  }`;

// to half size, through a wide soft filter (thirteen taps), so nothing flickers as it moves
const SHRINK = /* glsl */ `
  uniform sampler2D tMap;
  uniform vec2 uTexel;
  varying vec2 vUv;
  vec3 at(float x, float y) {
    return texture2D(tMap, vUv + vec2(x, y) * uTexel).rgb;
  }
  void main() {
    vec3 c = at(0.0, 0.0) * 0.125;
    c += (at(-1.0, -1.0) + at(1.0, -1.0) + at(-1.0, 1.0) + at(1.0, 1.0)) * 0.125;
    c += (at(-2.0, 0.0) + at(2.0, 0.0) + at(0.0, -2.0) + at(0.0, 2.0)) * 0.0625;
    c += (at(-2.0, -2.0) + at(2.0, -2.0) + at(-2.0, 2.0) + at(2.0, 2.0)) * 0.03125;
    gl_FragColor = vec4(c, 1.0);
  }`;

// back up one size, smoothly; it is laid over what is already there, of which uKeep is kept
const GROW = /* glsl */ `
  uniform sampler2D tMap;
  uniform vec2 uTexel;
  uniform float uGain, uKeep;
  varying vec2 vUv;
  vec3 at(float x, float y) {
    return texture2D(tMap, vUv + vec2(x, y) * uTexel).rgb;
  }
  void main() {
    vec3 c = at(0.0, 0.0) * 0.25;
    c += (at(-1.0, 0.0) + at(1.0, 0.0) + at(0.0, -1.0) + at(0.0, 1.0)) * 0.125;
    c += (at(-1.0, -1.0) + at(1.0, -1.0) + at(-1.0, 1.0) + at(1.0, 1.0)) * 0.0625;
    gl_FragColor = vec4(c * uGain, uKeep);
  }`;

// one render added into a running sum
const BLEND = /* glsl */ `
  uniform sampler2D tMap;
  uniform float uWeight;
  varying vec2 vUv;
  void main() {
    gl_FragColor = vec4(texture2D(tMap, vUv).rgb * uWeight, 1.0);
  }`;

// the finished picture: scene plus glow, graded
const GRADE = /* glsl */ `
  uniform sampler2D tScene, tGlow;
  uniform vec2 uTexel;
  uniform float uStrength, uSharp, uNight, uTime, uAspect;
  varying vec2 vUv;
  void main() {
    vec3 c = max(texture2D(tScene, vUv).rgb, 0.0);
    if (uSharp > 0.0) {
      // the scene was drawn smaller than the picture: give back some of the crispness enlarging costs
      vec3 around = texture2D(tScene, vUv + vec2(uTexel.x, 0.0)).rgb + texture2D(tScene, vUv - vec2(uTexel.x, 0.0)).rgb
        + texture2D(tScene, vUv + vec2(0.0, uTexel.y)).rgb + texture2D(tScene, vUv - vec2(0.0, uTexel.y)).rgb;
      c = max(c + (c - max(around, 0.0) * 0.25) * uSharp, 0.0);
    }
    c += texture2D(tGlow, vUv).rgb * uStrength;
    // highlights: leave everything up to 0.8 alone, then ease towards white instead of clipping
    vec3 over = max(c - 0.8, 0.0);
    c = min(c, 0.8) + 0.2 * (1.0 - exp(-over * 3.2));
    // a little more contrast and colour than the raw frame
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, 1.1);
    c = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
    // warm the lights and cool the shadows, more at night
    c *= mix(vec3(0.985, 0.995, 1.03), vec3(1.03, 1.0, 0.96), smoothstep(0.1, 0.75, l));
    // the corners fall off a little, as through a lens
    vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0);
    c *= 1.0 - (0.2 + 0.1 * uNight) * smoothstep(0.35, 1.05, length(d));
    // fine grain hides banding in skies and night gradients
    float g = fract(sin(dot(vUv * 1000.0 + fract(uTime) * 61.0, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
    c += g * 0.012;
    gl_FragColor = vec4(c, 1.0);
  }`;

export function createPost(renderer, scene, camera) {
  const size = new THREE.Vector2(); // the picture, in real pixels
  const drawn = new THREE.Vector2(); // what the scene is drawn at: the picture times `scale`
  renderer.getDrawingBufferSize(size);
  let scale = 1, samples = 4;
  const target = (w, h, options) => new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, ...options });
  // the scene itself: multisampled for the game; plain for exposures, whose many jittered renders do that job
  let sceneRT = null, plainRT = null, sumRT = null, levels = [];
  const build = () => {
    for (const t of [sceneRT, plainRT, sumRT, ...levels]) if (t) t.dispose();
    drawn.set(Math.max(2, Math.round(size.x * scale)), Math.max(2, Math.round(size.y * scale)));
    sceneRT = target(drawn.x, drawn.y, { samples, depthBuffer: true });
    plainRT = sumRT = null; // made when a recording first needs them
    levels = [];
    for (let i = 0, w = drawn.x, h = drawn.y; i < LEVELS; i++) {
      w = Math.max(1, Math.round(w / 2));
      h = Math.max(1, Math.round(h / 2));
      levels.push(target(w, h));
    }
  };
  build();

  const material = (fragmentShader, uniforms, options) =>
    new THREE.ShaderMaterial({ vertexShader: VERTEX, fragmentShader, uniforms, depthTest: false, depthWrite: false, ...options });
  const texel = () => ({ value: new THREE.Vector2() });
  const bright = material(BRIGHT, { tMap: { value: null }, uTexel: texel(), uThreshold: { value: 1 }, uWeight: { value: 1 } });
  const shrink = material(SHRINK, { tMap: { value: null }, uTexel: texel() });
  // what is drawn + what was there * the alpha that is drawn
  const grow = material(GROW, { tMap: { value: null }, uTexel: texel(), uGain: { value: 1 }, uKeep: { value: 1 } },
    { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.SrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor });
  const blend = material(BLEND, { tMap: { value: null }, uWeight: { value: 1 } });
  const grade = material(GRADE, {
    tScene: { value: null }, tGlow: { value: null }, uTexel: texel(), uStrength: { value: 0 }, uSharp: { value: 0 },
    uNight: env.uNight, uTime: env.uTime, uAspect: { value: 16 / 9 },
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blend);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene(), quadCam = new THREE.Camera();
  quadScene.add(quad);
  // draws one of the above over the whole of `into` (null: the screen); every pass either replaces all of
  // it or adds to it, so nothing is cleared first
  const pass = (mat, into, adding = false) => {
    if (mat !== grow) mat.blending = adding ? THREE.AdditiveBlending : THREE.NoBlending;
    quad.material = mat;
    renderer.setRenderTarget(into);
    renderer.render(quadScene, quadCam);
  };

  // the bright parts of one render, into the first glow level (added to what is there if not `first`)
  const gather = (texture, weight, first) => {
    bright.uniforms.tMap.value = texture;
    bright.uniforms.uTexel.value.set(1 / drawn.x, 1 / drawn.y);
    // glow: gentle by day (sun on glass and pale stone), generous at night (windows, signs, screens)
    bright.uniforms.uThreshold.value = 0.97 - 0.17 * env.uNight.value;
    bright.uniforms.uWeight.value = weight;
    pass(bright, levels[0], !first);
  };
  // from the gathered bright parts and the scene to the finished picture on screen
  const finish = (texture) => {
    for (let i = 1; i < LEVELS; i++) {
      shrink.uniforms.tMap.value = levels[i - 1].texture;
      shrink.uniforms.uTexel.value.set(1 / levels[i - 1].width, 1 / levels[i - 1].height);
      pass(shrink, levels[i]);
    }
    for (let i = LEVELS - 2; i >= 0; i--) {
      grow.uniforms.tMap.value = levels[i + 1].texture;
      grow.uniforms.uTexel.value.set(1 / levels[i + 1].width, 1 / levels[i + 1].height);
      grow.uniforms.uGain.value = i === LEVELS - 2 ? WEIGHTS[LEVELS - 1] : 1;
      grow.uniforms.uKeep.value = WEIGHTS[i];
      pass(grow, levels[i]);
    }
    grade.uniforms.tScene.value = texture;
    grade.uniforms.tGlow.value = levels[0].texture;
    grade.uniforms.uTexel.value.set(1 / drawn.x, 1 / drawn.y);
    grade.uniforms.uStrength.value = 0.15 + 0.24 * env.uNight.value;
    grade.uniforms.uSharp.value = scale < 0.99 ? 0.6 * Math.min(1, (1 - scale) * 4) : 0;
    grade.uniforms.uAspect.value = size.x / Math.max(size.y, 1);
    pass(grade, null);
  };
  // the passes above must not clear, whatever the renderer is set to
  const quietly = (work) => {
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    try {
      work();
    } finally {
      renderer.autoClear = auto;
      renderer.setRenderTarget(null);
    }
  };

  const halton = (i, base) => {
    let f = 1, r = 0;
    while (i > 0) {
      f /= base;
      r += f * (i % base);
      i = Math.floor(i / base);
    }
    return r;
  };

  return {
    enabled: true,
    // w, h: the size of the picture in real pixels. The scene is drawn at `scale` times that.
    setSize(w, h, s = scale) {
      if (w === size.x && h === size.y && s === scale) return;
      size.set(w, h);
      scale = s;
      build();
    },
    // the size the scene is drawn at, as a fraction of the picture's (1: every pixel)
    get scale() {
      return scale;
    },
    set scale(s) {
      this.setSize(size.x, size.y, s);
    },
    // how many samples per pixel smooth the game's edges (0, 2 or 4)
    get samples() {
      return samples;
    },
    set samples(n) {
      if (n === samples) return;
      samples = n;
      build();
    },
    // one frame, as the game draws it
    render() {
      if (!this.enabled) {
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
        return;
      }
      renderer.setRenderTarget(sceneRT);
      renderer.render(scene, camera);
      quietly(() => {
        gather(sceneRT.texture, 1, true);
        finish(sceneRT.texture);
      });
    },
    // One frame exposed over time: step(i) is called before each of the `count` renders to move the world
    // on a little, and the renders are averaged. A recording's motion blur. Each render's bright parts are
    // gathered before averaging, so a light that streaks across the frame keeps its glow.
    renderExposure(count, step) {
      if (!plainRT) {
        plainRT = target(drawn.x, drawn.y, { depthBuffer: true });
        sumRT = target(drawn.x, drawn.y);
      }
      for (let i = 0; i < count; i++) {
        step(i);
        // each render looks through the pixel grid shifted by a different fraction of a pixel
        camera.setViewOffset(drawn.x, drawn.y, halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5, drawn.x, drawn.y);
        renderer.setRenderTarget(plainRT);
        renderer.render(scene, camera);
        quietly(() => {
          blend.uniforms.tMap.value = plainRT.texture;
          blend.uniforms.uWeight.value = 1 / count;
          pass(blend, sumRT, i > 0);
          gather(plainRT.texture, 1 / count, i === 0);
        });
      }
      camera.clearViewOffset();
      quietly(() => finish(sumRT.texture));
    },
  };
}
