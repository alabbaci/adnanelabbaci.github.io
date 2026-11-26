import * as THREE from 'three';
import { env, setNight, skyMaterial, bakeClouds, bakeStreetLight } from './shaders.js';
import { buildCity } from './city.js';
import { Colliders } from './collide.js';
import { Player } from './player.js';
import { Cars, parkCars } from './cars.js';
import { RoadGraph, Traffic } from './traffic.js';
import { Vehicle } from './drive.js';
import { Nav } from './nav.js';
import { Trees } from './trees.js';
import { SunShadow } from './shadows.js';
import { LightShow } from './lightshow.js';
import { placeLaserTowers } from './showfx.js';
import { addRoofDetails } from './roofs.js';
import { addSurroundings } from './surroundings.js';
import { Surfaces } from './surfaces.js';
import { GameAudio } from './audio.js';
import { People } from './people.js';
import { Pedestrians } from './pedestrians.js';
import { placeLandmarks } from './landmarks.js';
import { addBridgeStructures } from './bridges.js';
import { Director } from './director.js';
import { createDirectorUI } from './director-ui.js';
import { createRecorder } from './recorder.js';
import { createPost } from './post.js';

const $ = (id) => document.getElementById(id);
const canvas = $('scene');
const overlay = $('overlay');
const overlayTitle = $('overlay-title');
const overlayText = $('overlay-text');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' }); // edges are smoothed in post.js, where the scene is drawn
const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
bakeClouds(renderer);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.4, 20000);
const post = createPost(renderer, scene, camera); // glow, highlights, grading; and motion blur for recordings

const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), skyMaterial());
sky.scale.setScalar(9000);
sky.renderOrder = -100;
sky.frustumCulled = false;
scene.add(sky);

let world = null; // { stats, lights, trees }
let player = null;
let city = null;
let nightTarget = 0;
let directorUI = null; // the shot-design panel (B)
let recorder = null; // takes stills and timings with the game stepped exactly (for tests)
let capture = null; // a shot being recorded to video as it plays (Z in the shot panel)
let nav = null; // minimap, search, route
let trees = null;
let shadow = null;
let people = null; // draws passers-by and the player's figure
const crowd = []; // everyone to draw this frame
let peds = null; // passers-by (simulation only; people draws them)
const movers = [], yieldTo = [];
const myCar = { x: 0, y: 0, z: 0, h: 0, v: 0 }, myFeet = { x: 0, y: 0, z: 0 }, pedFocus = { x: 0, y: 0, z: 0 };
const audio = new GameAudio(); // silent until the first click (browsers require a gesture)
let lastThud = 0;
let lightShow = null;
const aim = new THREE.Vector3();
// Fire a ball of light where the camera is looking; the show only reads at night, so night falls with the first shot.
function fireLight() {
  if (!lightShow || !player.active) return;
  if (lightShow.fire(camera.position, camera.getWorldDirection(aim))) {
    nightTarget = 1;
    audio.fire();
    if (!lightShow.formation) {
      // the drones write their word a kilometre ahead, facing whoever fired
      const yaw = Math.atan2(aim.x, -aim.z), ahead = 900;
      const centre = [camera.position.x + Math.sin(yaw) * ahead, Math.max(320, camera.position.y + 190), camera.position.z - Math.cos(yaw) * ahead];
      lightShow.startDrones({ centre, yaw: (yaw * 180) / Math.PI, from: [centre[0], centre[2]] }, env.uTime.value + 5);
    }
  }
}
let cars = null; // car meshes
let traffic = null; // self-driving cars
const loose = []; // cars the player has driven (and maybe left somewhere)
const nearby = []; // scratch list

// The closest car the player could get into from where they stand.
function carInReach() {
  const p = player.pos, feet = p.y - 1.7;
  let best = null, bd = 4.6 * 4.6;
  for (const v of loose) {
    const d = (v.x - p.x) ** 2 + (v.z - p.z) ** 2;
    if (d < bd && Math.abs(v.y - feet) < 2.5) { bd = d; best = v; }
  }
  if (feet < 2.5)
    for (const c of cars.parkedNear(p.x, p.z, 4.6, nearby)) {
      const d = (c.x - p.x) ** 2 + (c.z - p.z) ** 2;
      if (d < bd) { bd = d; best = c; }
    }
  return best;
}
function enterCar() {
  if (player.mode !== 'walk') return;
  let car = carInReach();
  if (!car) return;
  if (!(car instanceof Vehicle)) {
    // a parked car comes off the kerb and becomes a real, driveable one
    cars.removeParked(car);
    car = new Vehicle(car.type, car.tint, car.x, car.z, car.h);
    loose.push(car);
  }
  player.enter(car);
}
// Everything solid a driven car can bump into right now: each other car as two circles, nose and tail.
const solids = [];
function addSolid(c, len, r, extra) {
  const off = len * 0.26, sin = Math.sin(c.h), cos = Math.cos(c.h);
  const y = c.y || 0;
  solids.push({ x: c.x + sin * off, y, z: c.z - cos * off, r, ...extra }, { x: c.x - sin * off, y, z: c.z + cos * off, r, ...extra });
}
function solidsAround(v) {
  solids.length = 0;
  for (const c of traffic.cars) if ((c.x - v.x) ** 2 + (c.z - v.z) ** 2 < 900) addSolid(c, c.half * 2, c.half > 3 ? 1.4 : 1.1, { car: c });
  for (const c of cars.parkedNear(v.x, v.z, 14, nearby)) addSolid(c, 4.6, 1.1, { parked: c });
  for (const c of loose) if (c !== v && (c.x - v.x) ** 2 + (c.z - v.z) ** 2 < 400) addSolid(c, c.len, 1.1, { loose: c });
  return solids;
}
// Cars the player rams get knocked along: a parked one comes off the kerb, and both kinds then slide to a stop.
function applyShoves() {
  for (const s of solids) {
    if (!s.shove) continue;
    let car = s.loose;
    if (s.parked && !s.parked.gone) {
      cars.removeParked(s.parked);
      car = new Vehicle(s.parked.type, s.parked.tint, s.parked.x, s.parked.z, s.parked.h);
      loose.push(car);
    }
    if (car) {
      car.vx += s.shove.vx;
      car.vz += s.shove.vz;
    }
  }
  // keep the pile of abandoned cars bounded: the oldest ones quietly disappear
  while (loose.length > 80) loose.splice(loose[0] === player.vehicle ? 1 : 0, 1);
}
const COAST = { f: 0, r: 0, handbrake: true, boost: false };

const drawn = new THREE.Vector2();
// the street lights are points: their size on screen follows the picture's height and the lens
function scaleLights() {
  if (world) world.lights.material.uniforms.uScale.value = (renderer.getDrawingBufferSize(drawn).y * post.scale) / (2 * Math.tan((camera.fov * Math.PI) / 360));
}
function resize() {
  if (recorder && recorder.busy) return; // a recording has its own picture size; the window's comes back after it
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.getDrawingBufferSize(drawn);
  post.setSize(drawn.x, drawn.y, Math.round(quality.steps[quality.step][1] * quality.cap() * 100) / 100);
  scaleLights();
}
window.addEventListener('resize', resize);
// Draw at exactly w x h pixels whatever the window's size (for recording). Returns a function that undoes it.
function viewport(w, h) {
  const fov = camera.fov;
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  post.samples = 4;
  post.setSize(w, h, 1);
  scaleLights();
  return () => {
    renderer.setPixelRatio(pixelRatio);
    camera.fov = fov;
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.getDrawingBufferSize(drawn);
    post.samples = quality.steps[quality.step][0];
    post.setSize(drawn.x, drawn.y, Math.round(quality.steps[quality.step][1] * quality.cap() * 100) / 100);
    scaleLights();
  };
}

// ---------------------------------------------------------------- input
const locked = () => document.pointerLockElement === canvas;
function start() {
  if (!player) return;
  player.active = true;
  audio.unlock();
  overlay.classList.add('hidden');
  // Some embedded browsers refuse pointer lock; dragging with the mouse button held still works there.
  try {
    canvas.requestPointerLock?.()?.catch?.(() => $('mouse-hint').textContent = 'hold and drag to look');
  } catch {
    $('mouse-hint').textContent = 'hold and drag to look';
  }
}
overlay.addEventListener('click', start);
canvas.addEventListener('click', () => {
  if (player && !locked()) start();
});
document.addEventListener('pointerlockchange', () => {
  if (!player) return;
  if (!locked() && player.active) {
    // Esc releases the mouse; keep the world visible but say how to get back in
    overlayTitle.textContent = 'Paused';
    overlayText.textContent = 'Click to continue';
    overlay.classList.remove('hidden');
    player.active = false;
    player.keys.clear();
  }
});
let dragging = false;
canvas.addEventListener('mousedown', () => {
  dragging = true;
  if (locked()) fireLight(); // with the mouse captured, a click fires too
});
window.addEventListener('mouseup', () => (dragging = false));
window.addEventListener('mousemove', (e) => {
  if (!player) return;
  if (locked() || (dragging && player.active)) player.look(e.movementX, e.movementY);
});
window.addEventListener('keydown', (e) => {
  if (!player || e.metaKey || e.ctrlKey || e.altKey) return;
  if (recorder.busy) return e.preventDefault();
  if (directorUI.handleKey(e)) return; // the shot panel's own keys, and any key while a shot plays
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  player.keys.add(e.code);
  if (!player.active) return;
  if (e.code === 'KeyF') return nav.openSearch();
  if (e.code === 'KeyG') fireLight();
  if (e.code === 'KeyM') audio.setMuted(!audio.muted);
  if (e.code === 'KeyC' && player.mode === 'walk') player.thirdPerson = !player.thirdPerson;
  if (e.code === 'KeyV') player.toggleMode();
  if (e.code === 'KeyE') {
    const was = player.mode;
    if (was === 'walk') enterCar();
    else if (was === 'drive' && player.speed < 3) player.exit();
    if (player.mode !== was) audio.door();
  }
  if (e.code === 'KeyT') nightTarget = nightTarget ? 0 : 1;
  if (e.code === 'KeyH') document.body.classList.toggle('no-hud');
});
window.addEventListener('keyup', (e) => player?.keys.delete(e.code));
window.addEventListener('blur', () => player?.keys.clear());

// ---------------------------------------------------------------- HUD
const prompt = $('prompt');
const hudDest = { row: $('row-dest'), text: $('s-dest') };
const hud = { mode: $('s-mode'), pos: $('s-pos'), alt: $('s-alt'), speed: $('s-speed'), place: $('s-place'), fps: $('s-fps') };
function nearestPlace(x, z) {
  let best = null, bd = 150 * 150;
  for (const p of city.places) {
    const d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
function updateHud(fps) {
  const m = city.meta;
  const lat = m.lat0 - player.pos.z / m.mz, lon = m.lon0 + player.pos.x / m.mx;
  hud.mode.textContent = player.mode === 'drive' ? 'Driving' : player.mode === 'fly' ? 'Flying' : player.onGround ? 'Walking' : 'Falling';
  const tip = player.mode === 'walk' && player.active && carInReach() ? 'Press E to get in' : player.mode === 'drive' && player.speed < 3 ? 'Press E to get out' : '';
  prompt.textContent = tip;
  prompt.classList.toggle('show', !!tip);
  hud.pos.textContent = `${lat.toFixed(5)}°N  ${Math.abs(lon).toFixed(5)}°W`;
  hud.alt.textContent = `${player.mode === 'drive' ? 0 : Math.max(0, player.pos.y - (player.mode === 'walk' ? 1.7 : 0)).toFixed(0)} m`;
  hud.speed.textContent = `${(player.speed * 3.6).toFixed(0)} km/h`;
  const place = nearestPlace(player.pos.x, player.pos.z);
  hud.place.textContent = place ? place.n : '—';
  hud.fps.textContent = `${fps.toFixed(0)} fps` + (post.scale < 0.995 ? ` · render ${(post.scale * 100).toFixed(0)}%` : '');
}

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
let night = 0, hudTimer = 0, frames = 0, fpsTime = 0, fps = 60;
const look = new THREE.Vector3(), filmed = new THREE.Vector3();
// Day (0) or night (1): read it with no argument, or switch at once, without the usual dusk.
function nightNow(v) {
  if (v === undefined) return nightTarget;
  night = nightTarget = v ? 1 : 0;
  setNight(night);
  if (world) world.lights.visible = night > 0.02;
  return night;
}
// Holds the frame rate on slower graphics cards by giving up picture quality a step at a time: first
// fewer samples per pixel on edges, then drawing the scene smaller than the window (post.js enlarges it).
// It climbs back when there is time to spare, and waits longer before trying a step that just failed.
const quality = {
  steps: [[4, 1], [2, 1], [2, 0.88], [2, 0.78], [2, 0.69], [2, 0.61], [2, 0.54], [2, 0.48]], // [samples, scale]
  step: 0,
  times: [],
  calm: 0, // seconds of smooth running at this step
  patience: 4, // seconds of smooth running before trying one step up
  tried: -1, // the step last climbed to, while it is still on trial
  wait: 0, // frames to ignore after a change
  // a window with very many pixels starts smaller: more than this many are never drawn
  cap: () => Math.min(1, Math.sqrt(3.2e6 / Math.max(1, renderer.getDrawingBufferSize(drawn).x * drawn.y))),
  apply() {
    const [samples, scale] = this.steps[this.step];
    post.samples = samples;
    post.scale = Math.round(scale * this.cap() * 100) / 100;
    scaleLights();
    this.times.length = 0;
    this.wait = 4;
  },
  // ms: how long the last frame took, as the screen saw it
  frame(ms) {
    if (this.wait > 0) return this.wait--;
    this.times.push(ms);
    if (this.times.length < 30) return;
    const sorted = this.times.slice().sort((x, y) => x - y), typical = sorted[15];
    this.times.length = 0;
    const seconds = (typical * 30) / 1000;
    if (typical > 21.5 && this.step < this.steps.length - 1) {
      // under about 47 frames a second: one step down (two if far under)
      if (this.tried === this.step) this.patience = Math.min(this.patience * 2, 60);
      this.step = Math.min(this.step + (typical > 30 ? 2 : 1), this.steps.length - 1);
      this.tried = -1;
      this.calm = 0;
      this.apply();
    } else if (typical < 17.6) {
      this.calm += seconds;
      if (this.calm > 2) this.tried = -1; // the step climbed to has held
      if (this.calm > this.patience && this.step > 0) {
        this.step--;
        this.tried = this.step;
        this.calm = 0;
        this.apply();
      }
    } else this.calm = 0;
  },
};
function frame() {
  requestAnimationFrame(frame);
  const elapsed = clock.getDelta(), dt = Math.min(elapsed, 0.05);
  if (recorder && recorder.busy) return; // the recorder steps and draws the game itself
  // (a long gap is the tab coming back or the city loading, not a slow frame)
  if (world && elapsed < 0.25 && !document.hidden) quality.frame(elapsed * 1000);
  tick(dt);
  post.render();
  if (capture && !directorUI.playing) capture.stop(); // the shot has ended (or was stopped): finish the file
}
// Record the current shot to a video file as it plays: the page's own picture, at the window's size and
// in real time, encoded by the browser. (No dropped-frame guarantee: a slow frame is a slow frame.)
function recordShot() {
  if (capture || !window.MediaRecorder || !canvas.captureStream) return;
  const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
  if (!type) return;
  directorUI.play();
  if (!directorUI.playing) return; // nothing to play
  const rec = new MediaRecorder(canvas.captureStream(60), { mimeType: type, videoBitsPerSecond: 20e6 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    capture = null;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob(chunks, { type }));
    link.download = `rabat-shot-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${type.startsWith('video/mp4') ? 'mp4' : 'webm'}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
  };
  rec.start();
  capture = rec;
}
// Advance everything by dt. With a pose ({ pos, quat, fov }, as director.bake() gives them) the camera is
// put there instead of following the player: that is how a recording drives the game. fine: this is one
// of many small steps within a frame (a recording's motion blur), so only what moves needs doing.
function tick(dt, pose, fine = false) {
  env.uTime.value += dt;

  if (night !== nightTarget) {
    night += Math.sign(nightTarget - night) * dt / 1.6;
    night = Math.max(0, Math.min(1, night));
    const e = night * night * (3 - 2 * night);
    setNight(e);
    if (world) world.lights.visible = e > 0.02;
  }

  if (player) {
    player.update(dt);
    // while a shot plays the director owns the camera, and the city's life gathers around what it sees
    let eye = null;
    if (pose) {
      camera.position.fromArray(pose.pos);
      camera.quaternion.fromArray(pose.quat);
      if (camera.fov !== pose.fov) {
        camera.fov = pose.fov;
        camera.updateProjectionMatrix();
        scaleLights();
      }
      camera.updateMatrixWorld();
      // ... around the ground the picture looks at, which from high up is far from the camera
      camera.getWorldDirection(look);
      const reach = Math.min(look.y < -0.02 ? camera.position.y / -look.y : Infinity, 450 + camera.position.y);
      eye = filmed.set(camera.position.x + look.x * reach, camera.position.y, camera.position.z + look.z * reach);
    } else if (directorUI.update(dt)) eye = camera.position;
    sky.position.copy(camera.position);

    // traffic lives around the player (or the car they are in), and gives way to cars the player has used
    const v = player.vehicle;
    if (v) applyShoves();
    for (const c of loose) if (c !== v && (c.vx || c.vz)) {
      c.update(dt, COAST, player.colliders, [], city.meta.bounds, player.surfaces);
      if (Math.abs(c.vx) + Math.abs(c.vz) < 0.05) c.vx = c.vz = 0;
    }
    // traffic gives way to cars the player has used, and to the player on foot
    // passers-by need to know about moving cars (to wait at the kerb)...
    movers.length = 0;
    for (const c of traffic.cars) movers.push(c);
    if (v) {
      myCar.x = v.x; myCar.y = v.y; myCar.z = v.z; myCar.h = v.h; myCar.v = Math.abs(v.speed);
      movers.push(myCar);
    }
    pedFocus.x = eye ? eye.x : v ? v.x : player.pos.x;
    pedFocus.z = eye ? eye.z : v ? v.z : player.pos.z;
    pedFocus.y = eye ? eye.y : v ? v.y : player.mode === 'fly' ? player.pos.y : player.pos.y - 1.7;
    peds.update(dt, pedFocus, movers);
    // ...and traffic gives way to cars the player has used, the player on foot, and anyone on a crossing
    yieldTo.length = 0;
    for (const c of loose) yieldTo.push(c);
    if (player.mode === 'walk') {
      myFeet.x = player.pos.x; myFeet.y = player.pos.y - 1.7; myFeet.z = player.pos.z;
      yieldTo.push(myFeet);
    }
    for (const p of peds.people) if (p.crossing) yieldTo.push(p);
    traffic.update(dt, eye || (v ? { x: v.x, y: 0, z: v.z } : player.pos), yieldTo);
    // driving into someone knocks them down
    if (v && Math.abs(v.speed) > 3) {
      const sn = Math.sin(v.h), cs = Math.cos(v.h), reach = (v.radius + 0.35) ** 2;
      for (const p of peds.people) {
        if (p.state === 'down' || Math.abs(p.y - v.y) > 2) continue;
        const dx = p.x - v.x, dz = p.z - v.z;
        if (dx * dx + dz * dz > 25) continue;
        const off = v.len * 0.27;
        if ((dx - sn * off) ** 2 + (dz + cs * off) ** 2 < reach || (dx + sn * off) ** 2 + (dz - cs * off) ** 2 < reach) {
          peds.knock(p, v.vx, v.vz);
          audio.impact(4);
        }
      }
    }
    if (!fine) cars.updateParked(camera.position);
    cars.drawDynamic(loose.length ? traffic.cars.concat(loose) : traffic.cars, camera.position, env.uNight.value);
    if (!fine) {
      nav.update(dt, v || player.pos, v ? player.camH + player.orbit : player.yaw, player.mode === 'fly' ? player.pos.y : 0, !!v, hudDest);
      trees.update(camera.position);
    }
    lightShow.update(dt, camera.position);
    crowd.length = 0;
    if (player.visibleFigure) crowd.push(player.visibleFigure);
    for (const p of peds.people) crowd.push(p);
    people.draw(crowd, dt, camera.position);
    // sound follows what the player is doing
    if (v && v.impact > 1.5 && env.uTime.value - lastThud > 0.18) {
      lastThud = env.uTime.value;
      audio.impact(v.impact);
    }
    if (!fine) {
      audio.update(dt, {
        mode: player.mode,
        speed: player.speed,
        altitude: v ? v.y : player.mode === 'fly' ? player.pos.y : Math.max(0, player.pos.y - 1.7),
        onGround: player.onGround,
        throttle: v && player.active ? (player.key('KeyW') || player.key('ArrowUp') ? 1 : 0) - (player.key('KeyS') || player.key('ArrowDown') ? 1 : 0) : 0,
        boost: player.active && (player.key('ShiftLeft') || player.key('ShiftRight')),
        handbrake: !!v && player.active && player.key('Space'),
        slip: v ? Math.abs(v.vx * Math.cos(v.h) + v.vz * Math.sin(v.h)) : 0,
        night: env.uNight.value,
      });
      shadow.update(eye || player.vehicle || player.pos, eye ? eye.y : player.mode === 'fly' ? player.pos.y : 0, env.uNight.value);
    }

    frames++;
    fpsTime += dt;
    hudTimer += dt;
    if (fpsTime >= 0.5) {
      fps = frames / fpsTime;
      frames = 0;
      fpsTime = 0;
    }
    if (hudTimer >= 0.2) {
      hudTimer = 0;
      updateHud(fps);
    }
  }
}

// ---------------------------------------------------------------- boot
async function boot() {
  overlayText.textContent = 'Downloading the city…';
  const res = await fetch('data/city.json');
  if (!res.ok) throw new Error(`city.json: HTTP ${res.status} (build it with rabat/pipeline first)`);
  city = await res.json();
  $('area').textContent = city.meta.name;

  overlayText.textContent = 'Raising the monuments…';
  const landmarks = placeLandmarks(scene, city);
  world = await buildCity(city, scene, (msg) => (overlayText.textContent = msg), landmarks);
  {
    // what lights the streets at night: every street lamp
    const lit = [], at = world.lights.geometry.attributes.position, rnd = (i, k) => Math.abs(Math.sin(i * 127.1 + k * 311.7) * 43758.5453) % 1;
    for (let i = 0; i < at.count; i++) {
      const cool = rnd(i, 1) < 0.25; // most are warm; some newer, whiter ones
      if (at.getY(i) < 6) lit.push(at.getX(i), at.getZ(i), 7, 1.1, 0.86, 0.56); // a path lamp: lower, and its pool smaller
      else lit.push(at.getX(i), at.getZ(i), 13, ...(cool ? [1.25, 1.3, 1.28] : [1.55, 1.18, 0.76]));
    }
    bakeStreetLight(renderer, city.meta.bounds, lit);
  }
  const bridges = addBridgeStructures(scene, city); // piers under raised roads
  overlayText.textContent = 'Planting trees…';
  trees = new Trees(scene, city.trees);
  const treeModels = await trees.loadModels('models/trees/');
  trees.build();
  overlayText.textContent = 'Working out collisions…';
  await new Promise((r) => setTimeout(r));
  const colliders = new Colliders(city.buildings);
  overlayText.textContent = 'Minarets and rooftops…';
  await new Promise((r) => setTimeout(r));
  const roofs = addRoofDetails(scene, city.buildings, colliders, landmarks);
  addSurroundings(scene, city);
  overlayText.textContent = 'Parking cars, starting traffic…';
  await new Promise((r) => setTimeout(r));
  const graph = new RoadGraph(city.roads);
  cars = new Cars(scene);
  const models = await cars.loadModels('models/cars/');
  cars.buildParked(parkCars(graph, models));
  traffic = new Traffic(graph, models);
  shadow = new SunShadow(renderer, scene);
  people = new People(scene);
  const characters = await people.loadModels('models/people/');
  peds = new Pedestrians(city.roads, { count: 220, radius: 170, kinds: people.kinds });
  placeLaserTowers(city);
  lightShow = new LightShow(scene, colliders);
  lightShow.onBurst = (x, z) => audio.burst(Math.hypot(x - camera.position.x, z - camera.position.z));
  nav = new Nav(city, graph, scene);
  // typing in the search box must not fly the player around; closing it drops straight back into the game
  nav.onOpen = () => {
    player.active = false;
    player.keys.clear();
    document.exitPointerLock?.();
  };
  nav.onClose = start;

  const p = new Player(camera, colliders, city.meta.spawn, city.meta.bounds);
  p.solids = solidsAround;
  p.surfaces = new Surfaces(city.roads);
  p.update(0);
  const director = new Director(camera);
  recorder = createRecorder({ renderer, scene, camera, tick, viewport, night: nightNow, lightShow, post });
  directorUI = createDirectorUI({
    director, camera, player: p,
    extras: [['KeyZ', 'Z', 'play this shot and record it to a video file', recordShot]],
  });
  player = p;
  resize();

  const s = world.stats;
  $('counts').textContent = `${s.buildings.toLocaleString()} buildings · ${s.roads.toLocaleString()} road segments · ${s.trees.toLocaleString()} trees · ${cars.parkedCount.toLocaleString()} parked cars`;
  overlayTitle.textContent = city.meta.name;
  overlayText.textContent = 'Click to start';
  overlay.classList.add('ready');

  // handy for debugging from the console
  window.__game = { THREE, renderer, scene, camera, player, env, world, city, cars, traffic, graph, nav, trees, roofs, audio, people, peds, characters, landmarks, bridges, lightShow, fireLight, nightNow, loose, directorUI, director, recorder, recordShot, post, models, treeModels, enterCar, setNight: (v) => (nightTarget = v ? 1 : 0) };
}

frame();
boot().catch((err) => {
  console.error(err);
  overlayTitle.textContent = 'Could not load';
  overlayText.textContent = String(err.message || err);
});
