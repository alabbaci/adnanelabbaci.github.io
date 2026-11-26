// The light show's set pieces, as plain numbers, so that the game (lightshow.js) and the Blender export
// (tools/bake-shots.mjs) show exactly the same thing:
//   laser fans from the crowns of the tallest towers, switched on by the shock wave as it reaches them;
//   a swarm of drones that climbs out of a park and writes a word in the sky.
// Metres, +x east, +y up, +z south; times in seconds. Nothing here touches the screen.

export const WAVE_SPEED = 230; // how fast a shock front spreads, as in showAt() (shaders.js)

const smooth = (lo, hi, x) => {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};
// a steady pseudo-random number in 0..1 for the i-th thing's k-th property
const rnd = (i, k) => {
  const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

// ---------------------------------------------------------------- lasers
// [x, height of the crown, z, colour, fans]: the towers that carry lasers
export const LASER_TOWERS = [];
const LASER_COLOURS = [[1.0, 0.25, 0.62], [0.3, 0.85, 1.0], [1.0, 0.74, 0.34], [0.62, 0.42, 1.0], [0.45, 0.9, 1.0], [1.0, 0.3, 0.7], [0.75, 0.85, 1.0], [1.0, 0.78, 0.4]];
const MOST_FANS = 10;
// Which roofs the lasers stand on, as [x, top, z, colour, fans]: the monuments (two fans each on the
// Mohammed VI Tower and the Hassan Tower) and the three tallest ordinary buildings. Call once, with the
// loaded city, before the light show is built.
export function placeLaserTowers(city) {
  LASER_TOWERS.length = 0;
  const add = (x, top, z, fans) => LASER_TOWERS.push([x, top, z, LASER_COLOURS[LASER_TOWERS.length % LASER_COLOURS.length], fans]);
  for (const lm of city.landmarks || []) add(lm.x, lm.h, lm.z, lm.id === 'tourm6' || lm.id === 'hassan' ? 2 : 1);
  const tall = city.buildings.filter((b) => b.lm == null && b.st !== 6).sort((a, b) => b.h - a.h).slice(0, 3);
  for (const b of tall) {
    let x = 0, z = 0;
    for (let i = 0; i < b.p.length; i += 2) { x += b.p[i]; z += b.p[i + 1]; }
    add(x / (b.p.length / 2), b.h, z / (b.p.length / 2), 1);
  }
  while (LASER_TOWERS.reduce((n, t) => n + t[4], 0) > MOST_FANS) LASER_TOWERS.pop();
}
const FLIGHT = 4.2, STAGGER = 1.6; // seconds a drone takes to its place; how far apart the first and last leave
export const DRONES_READY = FLIGHT + STAGGER; // seconds after the start when the word stands complete
export const BEAMS_PER_FAN = 9;
export const BEAM_REACH = 1500, BEAM_FOLDED = 300; // how far a beam is drawn: sweeping the sky, and folded under the drones' word
export const MAX_BEAMS = MOST_FANS * BEAMS_PER_FAN;

export const BEAM_STRIDE = 11;

// The beams alight at `now`. waves: [[x, z, the time it started], ...]. Fills `out` with BEAM_STRIDE numbers
// a beam (where it starts x, y, z; its direction x, y, z; its colour r, g, b; its strength 0..1; its length)
// and returns how many. formation: { plan, tau } while drones are up (planDrones(), seconds since they
// left): as their word comes together the fans stop sweeping, turn to face its reader and fold down into
// a short low spray on either side of each crown, so that the sky where the word stands is left clear.
export function beamsAt(waves, now, out, formation = null) {
  let n = 0;
  const gather = formation ? smooth(DRONES_READY - 2.5, DRONES_READY, formation.tau) : 0;
  const mid = (BEAMS_PER_FAN - 1) / 2;
  LASER_TOWERS.forEach(([x, top, z, colour, fans], ti) => {
    let lit = 0, since = 0;
    for (const [wx, wz, t0] of waves) {
      const age = now - t0;
      if (age < 0 || age > 42) continue;
      const after = age - Math.hypot(x - wx, z - wz) / WAVE_SPEED; // since the front passed this tower
      if (after < 0) continue;
      const k = smooth(0, 1.2, after) * (1 - smooth(28, 42, age));
      if (k > lit) {
        lit = k;
        since = after;
      }
    }
    if (lit < 0.01) return;
    // a fan opens from straight up, then breathes and turns slowly; a second fan stands across the first
    const spread = (1.9 * smooth(0, 3, since) * (0.78 + 0.22 * Math.sin(now * 0.9 + ti * 2.1))) / 2;
    for (let f = 0; f < fans; f++) {
      const turn = ti * 1.3 + now * 0.2 * (ti % 2 ? 1 : -1) + (f * Math.PI) / 2;
      let hx = Math.sin(turn), hz = -Math.cos(turn);
      const lean = 0.3 * Math.sin(now * 0.5 + ti + f * 1.7); // the whole fan nods from side to side
      if (gather > 0) {
        // swing the fan round to stand across the reader's view (whichever way round is nearer)
        let [rx, rz] = formation.plan.right;
        if (rx * hx + rz * hz < 0) {
          rx = -rx;
          rz = -rz;
        }
        hx += (rx - hx) * gather;
        hz += (rz - hz) * gather;
        const len = Math.hypot(hx, hz) || 1;
        hx /= len;
        hz /= len;
      }
      for (let b = 0; b < BEAMS_PER_FAN; b++) {
        let a = (b / (BEAMS_PER_FAN - 1) - 0.5) * 2 * spread + lean, strength = 1;
        if (gather > 0) {
          // folded: 72 to 86 degrees from straight up on either side, nothing in between
          const side = Math.sign(b - mid), low = side * (1.26 + 0.24 * ((Math.abs(b - mid) - 1) / (mid - 1)));
          a += (low - a) * gather;
          strength = f > 0 || side === 0 ? 1 - gather : 1 - 0.15 * gather; // the middle beam and a tower's second fan go out
        }
        if (strength < 0.01) continue;
        const o = n * BEAM_STRIDE;
        out[o] = x;
        out[o + 1] = top;
        out[o + 2] = z;
        out[o + 3] = hx * Math.sin(a);
        out[o + 4] = Math.cos(a);
        out[o + 5] = hz * Math.sin(a);
        out[o + 6] = colour[0];
        out[o + 7] = colour[1];
        out[o + 8] = colour[2];
        out[o + 9] = lit * strength * (0.72 + 0.28 * Math.sin(now * 3.1 + b * 1.7 + ti));
        out[o + 10] = BEAM_REACH + (BEAM_FOLDED - BEAM_REACH) * gather;
        n++;
      }
    }
  });
  return n;
}

// ---------------------------------------------------------------- drones
// a five-by-seven dot-matrix alphabet: seven rows a letter, top first
const FONT = {
  A: '01110 10001 10001 11111 10001 10001 10001', B: '11110 10001 10001 11110 10001 10001 11110',
  C: '01110 10001 10000 10000 10000 10001 01110', D: '11110 10001 10001 10001 10001 10001 11110',
  E: '11111 10000 10000 11110 10000 10000 11111', F: '11111 10000 10000 11110 10000 10000 10000',
  G: '01110 10001 10000 10111 10001 10001 01111', H: '10001 10001 10001 11111 10001 10001 10001',
  I: '11111 00100 00100 00100 00100 00100 11111', J: '00111 00010 00010 00010 00010 10010 01100',
  K: '10001 10010 10100 11000 10100 10010 10001', L: '10000 10000 10000 10000 10000 10000 11111',
  M: '10001 11011 10101 10101 10001 10001 10001', N: '10001 11001 10101 10011 10001 10001 10001',
  O: '01110 10001 10001 10001 10001 10001 01110', P: '11110 10001 10001 11110 10000 10000 10000',
  Q: '01110 10001 10001 10001 10101 10010 01101', R: '11110 10001 10001 11110 10100 10010 10001',
  S: '01111 10000 10000 01110 00001 00001 11110', T: '11111 00100 00100 00100 00100 00100 00100',
  U: '10001 10001 10001 10001 10001 10001 01110', V: '10001 10001 10001 10001 10001 01010 00100',
  W: '10001 10001 10001 10101 10101 11011 10001', X: '10001 10001 01010 00100 01010 10001 10001',
  Y: '10001 10001 01010 00100 00100 00100 00100', Z: '11111 00001 00010 00100 01000 10000 11111',
  0: '01110 10001 10011 10101 11001 10001 01110', 1: '00100 01100 00100 00100 00100 00100 01110',
  2: '01110 10001 00001 00010 00100 01000 11111', 3: '11110 00001 00001 01110 00001 00001 11110',
  4: '00010 00110 01010 10010 11111 00010 00010', 5: '11111 10000 11110 00001 00001 10001 01110',
  6: '00110 01000 10000 11110 10001 10001 01110', 7: '11111 00001 00010 00100 01000 01000 01000',
  8: '01110 10001 10001 01110 10001 10001 01110', 9: '01110 10001 10001 01111 00001 00010 01100',
  ' ': '00000 00000 00000 00000 00000 00000 00000',
};

// Plan a formation. centre: the middle of the word [x, y, z]; yaw: the compass bearing (degrees) of whoever
// should read it, i.e. the way a camera looks when it faces the word; width: the word's width in metres;
// from: [x, z] of the lawn the drones take off from. Returns what dronesAt() needs.
export function planDrones({ text = 'RABAT', centre, yaw = 0, width = 760, from }) {
  const letters = [...text.toUpperCase()].map((ch) => (FONT[ch] || FONT[' ']).split(' '));
  const columns = letters.length * 6 - 1, cell = width / columns;
  const rx = Math.cos((yaw * Math.PI) / 180), rz = Math.sin((yaw * Math.PI) / 180); // the reader's right
  const target = [];
  letters.forEach((rows, li) => {
    rows.forEach((row, r) => {
      [...row].forEach((bit, c) => {
        if (bit !== '1') return;
        for (const du of [-0.25, 0.25]) {
          for (const dv of [-0.25, 0.25]) {
            const u = (li * 6 + c + 0.5 + du - columns / 2) * cell, v = (3 - r + dv) * cell;
            target.push(centre[0] + rx * u, centre[1] + v, centre[2] + rz * u);
          }
        }
      });
    });
  });
  const count = target.length / 3, side = Math.ceil(Math.sqrt(count));
  const ground = [], mid = [], delay = [];
  const lawn = from || [centre[0], centre[2]];
  for (let i = 0; i < count; i++) {
    // parked in rows on the lawn, three metres apart
    ground.push(lawn[0] + ((i % side) - side / 2) * 3, 1.5, lawn[1] + (Math.floor(i / side) - side / 2) * 3);
    // on the way up each one swings wide round the column of the swarm
    const swing = rnd(i, 1) * Math.PI * 2, far = 60 + 160 * rnd(i, 2);
    mid.push((lawn[0] + centre[0]) / 2 + Math.cos(swing) * far, centre[1] * (0.45 + 0.25 * rnd(i, 3)), (lawn[1] + centre[2]) / 2 + Math.sin(swing) * far);
    delay.push(STAGGER * rnd(i, 4));
  }
  return { count, ground, mid, target, delay, right: [rx, rz] };
}

// Where each drone is `tau` seconds after the formation started: fills `out` (x, y, z a drone) and
// returns how many there are (none before the start).
export function dronesAt(plan, tau, out) {
  if (!plan || tau < 0) return 0;
  const { count, ground, mid, target, delay } = plan;
  for (let i = 0; i < count; i++) {
    const s = Math.min(1, Math.max(0, (tau - delay[i]) / FLIGHT));
    const e = s * s * s * (s * (s * 6 - 15) + 10); // leaves and arrives gently
    const a = (1 - e) * (1 - e), b = 2 * e * (1 - e), c = e * e;
    // in place, a drone still drifts a little: it is hovering, not nailed to the sky
    const drift = s >= 1 ? 0.5 : 0;
    for (let k = 0; k < 3; k++) {
      out[i * 3 + k] = a * ground[i * 3 + k] + b * mid[i * 3 + k] + c * target[i * 3 + k] + drift * Math.sin(tau * (1.1 + 0.4 * rnd(i, 5 + k)) + i * (k + 1));
    }
  }
  return count;
}
