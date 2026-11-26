// Still pictures of the game from a given view, and frame timings, driven from the console or a test:
// the game is stepped by fixed amounts first so that the result does not depend on this machine's speed.
//
// (In manhattan-free-roam this file also records shots to video frame by exact frame, through a capture
// endpoint on its Vite dev server and ffmpeg. This site is static, so shots are recorded in the browser
// instead, as they play: see recordShot() in main.js.)

import * as THREE from 'three';
import { env } from './shaders.js';

// tick(dt, pose): advance the whole game by dt with the camera at pose ({ pos, quat, fov }), without drawing
// viewport(w, h): draw at exactly w x h pixels; returns a function that puts the window's own size back
// night(v): read the game's day (0) or night (1) with no argument, or switch to it at once
// post: the picture pipeline (post.js): render() for one sample, renderExposure() for a frame exposed over time
export function createRecorder({ renderer, scene, camera, tick, viewport, night, lightShow, post }) {
  const self = {
    busy: false,
    // One picture of the game from a given view, as a PNG data URL: for checking how things look without
    // a screen (tools/still.mjs). view: { pos: [x, y, z], yaw, pitch (degrees), fov, night: true|false,
    // bursts: [[x, z, seconds ago], ...] for a light show already under way;
    // drones: { ...as planDrones() in showfx.js, ago: seconds since they left } for a formation in the sky }.
    // settle: seconds the city runs at that view first, so nearby detail has been swapped in.
    async still(view, { width = 1600, height = 900, settle = 1.5 } = {}) {
      if (self.busy) throw new Error('busy');
      const rad = THREE.MathUtils.degToRad;
      const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(rad(view.pitch || 0), -rad(view.yaw || 0), 0, 'YXZ'));
      const pose = { pos: view.pos, quat: turn.toArray(), fov: view.fov || 60 };
      self.busy = true;
      const before = night(), restore = viewport(width, height);
      try {
        night(view.night ? 1 : 0);
        lightShow.reset();
        const steps = Math.round(settle * 60);
        if (view.drones) lightShow.startDrones(view.drones, env.uTime.value + settle - (view.drones.ago || 0));
        for (let i = steps; i > 0; i--) {
          tick(1 / 60, pose);
          for (const b of view.bursts || []) if (Math.round(b[2] * 60) === i) lightShow.burst(b[0], b[1]);
        }
        // sixteen jittered renders of the still scene: smooth edges and calm window grids
        post.renderExposure(16, () => {});
        return renderer.domElement.toDataURL('image/png');
      } finally {
        restore();
        night(before);
        self.busy = false;
      }
    },

    // How long the game takes to draw a frame from a given view, in milliseconds (the median of `frames`
    // frames drawn the way the game draws them, each forced to finish before the clock is read).
    // samples, scale: the game's picture quality to time it at (see `quality` in main.js).
    bench(view, { width = 1920, height = 1080, frames = 120, samples = 4, scale = 1 } = {}) {
      const rad = THREE.MathUtils.degToRad;
      const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(rad(view.pitch || 0), -rad(view.yaw || 0), 0, 'YXZ'));
      const pose = { pos: view.pos, quat: turn.toArray(), fov: view.fov || 60 };
      self.busy = true;
      const before = night(), restore = viewport(width, height), gl = renderer.getContext(), px = new Uint8Array(4), times = [], thinking = [];
      try {
        night(view.night ? 1 : 0);
        post.samples = samples;
        post.scale = scale;
        for (let i = 0; i < 60; i++) tick(1 / 60, pose);
        for (let i = 0; i < frames + 10; i++) {
          const t0 = performance.now();
          tick(1 / 60, pose);
          const t1 = performance.now();
          post.render();
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          if (i >= 10) {
            times.push(performance.now() - t0);
            thinking.push(t1 - t0);
          }
        }
      } finally {
        restore();
        night(before);
        self.busy = false;
      }
      times.sort((x, y) => x - y);
      thinking.sort((x, y) => x - y);
      // update: the part of each frame spent moving the world on, before any drawing
      return { median: times[times.length >> 1], update: thinking[thinking.length >> 1], p95: times[Math.floor(times.length * 0.95)], calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
    },
  };
  return self;
}
