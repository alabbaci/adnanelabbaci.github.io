import { Euler, Quaternion, Vector3, Vector4 } from 'three';

const DEFAULT_FOV = 70;
const ARC_CELLS = 32;
const GAUSS_NODES = [0, 0.5384693101056831, -0.5384693101056831, 0.906179845938664, -0.906179845938664];
const GAUSS_WEIGHTS = [0.5688888888888889, 0.4786286704993665, 0.4786286704993665, 0.2369268850561891, 0.2369268850561891];
const KEY_FIELDS = ['yaw', 'pitch', 'roll', 'fov', 'time'];

const clamp = (value, low, high) => Math.max(low, Math.min(value, high));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const coordinate = value => clamp(finite(value), -1e100, 1e100);
const unit = value => typeof value === 'number' && !Number.isNaN(value) ? clamp(value, 0, 1) : 0;
const durationOf = shot => Math.max(0, finite(shot?.duration));
const validTime = value => Number.isFinite(value) && value >= 0 && value <= 1;
const wrapAngle = value => Math.atan2(Math.sin(value), Math.cos(value));

function reachesEnd(elapsed, duration) {
  return elapsed >= duration || duration - elapsed <= 8 * Number.EPSILON * duration;
}

function eased(u, ease) {
  const t = unit(u);
  if (ease === 'in') return t ** 3;
  if (ease === 'out') return 1 - (1 - t) ** 3;
  if (ease !== 'inout') return t;

  const x = Math.min(t, 1 - t);
  const ramp = x ** 3 * (10 + x * (-15 + 6 * x));
  return t <= 0.5 ? ramp : 1 - ramp;
}

function interval(values, value) {
  let low = 0;
  let high = values.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >>> 1;
    if (value < values[middle]) high = middle;
    else low = middle;
  }
  return low;
}

function hermiteOffset(t, delta, start, end) {
  // start and end are derivatives with respect to this segment's unit interval.
  const s = 1 - t;
  return t * (t * (3 - 2 * t) * delta + s * (s * start - t * end));
}

function monotoneRates(widths, slopes, stopFirst, stopLast) {
  const rates = [stopFirst ? 0 : slopes[0]];
  for (let i = 1; i < slopes.length; i++) {
    const left = slopes[i - 1];
    const right = slopes[i];
    if (Math.sign(left) !== Math.sign(right) || left === 0) {
      rates.push(0);
    } else {
      const a = widths[i - 1] + 2 * widths[i];
      const b = 2 * widths[i - 1] + widths[i];
      rates.push((a + b) / (a / left + b / right));
    }
  }
  rates.push(stopLast ? 0 : slopes.at(-1));
  return rates;
}

function integrateSpeed(segment, from, to) {
  const { cubic, quadratic, tangent } = segment;
  const half = (to - from) / 2;
  const middle = from + half;
  let sum = 0;
  for (let i = 0; i < GAUSS_NODES.length; i++) {
    const t = middle + half * GAUSS_NODES[i];
    sum += GAUSS_WEIGHTS[i] * Math.hypot(
      (3 * cubic.x * t + 2 * quadratic.x) * t + tangent.x,
      (3 * cubic.y * t + 2 * quadratic.y) * t + tangent.y,
      (3 * cubic.z * t + 2 * quadratic.z) * t + tangent.z,
    );
  }
  return half * sum;
}

function positionSegments(positions) {
  const edges = positions.slice(1).map((pos, i) => pos.clone().sub(positions[i]));
  const lengths = edges.map(edge => Math.hypot(edge.x, edge.y, edge.z));
  const knots = lengths.map(Math.sqrt);
  const directions = edges.map((edge, i) => knots[i] && edge.clone().divideScalar(knots[i]));
  const tangents = positions.map((_, i) => {
    if (!directions[i - 1] || !directions[i]) return directions[i - 1] || directions[i];

    const left = knots[i - 1];
    const right = knots[i];
    return directions[i - 1].clone().multiplyScalar(right / (left + right))
      .addScaledVector(directions[i], left / (left + right));
  });
  const stops = tangents.map((tangent, i) => Boolean(directions[i - 1] && directions[i]
    && tangent.length() <= 1e-12 * Math.min(knots[i - 1], knots[i])));

  const segments = edges.map((edge, i) => {
    const knot = knots[i];
    if (!knot || edges.length === 1) return { length: lengths[i] };

    const tangent = tangents[i].clone().multiplyScalar(knot);
    const end = tangents[i + 1].clone().multiplyScalar(knot);
    const quadratic = edge.clone().multiplyScalar(3).addScaledVector(tangent, -2).sub(end);
    const cubic = edge.clone().multiplyScalar(-2).add(tangent).add(end);
    const segment = { cubic, quadratic, tangent, arc: [0] };
    for (let j = 0; j < ARC_CELLS; j++) {
      segment.arc.push(segment.arc[j] + integrateSpeed(segment, j / ARC_CELLS, (j + 1) / ARC_CELLS));
    }
    segment.length = segment.arc.at(-1);
    return segment;
  });
  return { segments, stops };
}

function positionAt(start, end, segment, fraction, result) {
  if (fraction <= 0) return result.copy(start);
  if (fraction >= 1) return result.copy(end);
  if (!segment.arc) return result.copy(start).lerp(end, fraction);

  const target = fraction * segment.length;
  if (target <= 0) return result.copy(start);
  if (target >= segment.length) return result.copy(end);
  const cell = interval(segment.arc, target);
  const startT = cell / ARC_CELLS;
  const startLength = segment.arc[cell];
  const endLength = segment.arc[cell + 1];
  const localTarget = target - startLength;
  const localLength = endLength - startLength;
  let low = startT;
  let high = (cell + 1) / ARC_CELLS;
  let t = low + (high - low) * (localTarget / localLength);
  // Bisect the integrated arc, avoiding a change in speed at lookup-table boundaries.
  for (let i = 0; i < 32; i++) {
    const error = integrateSpeed(segment, startT, t) - localTarget;
    if (Math.abs(error) <= localLength * 1e-11) break;
    if (error < 0) low = t;
    else high = t;
    t = (low + high) / 2;
  }

  return result.copy(segment.cubic).multiplyScalar(t).add(segment.quadratic)
    .multiplyScalar(t).add(segment.tangent).multiplyScalar(t).add(start);
}

function keyTimes(keys, segments) {
  const last = keys.length - 1;
  // Leave enough room for distinct keys even if an author enters conflicting times.
  const minGap = 1e-10 / last;
  const firstTime = keys[0].time;
  const lastTime = keys[last].time;
  const end = validTime(lastTime) && lastTime >= last * minGap ? lastTime : 1;
  const start = validTime(firstTime) && end - firstTime >= last * minGap ? firstTime : 0;
  const times = [start];
  let anchor = 0;
  const moving = segments.filter(segment => segment.length > 0);
  const holdWeight = moving.length ? moving.reduce((sum, segment) => sum + segment.length, 0) / moving.length : 1;

  for (let i = 1; i <= last; i++) {
    const time = i === last ? end : keys[i].time;
    if (i !== last && (!validTime(time) || time - times[anchor] < (i - anchor) * minGap
      || end - time < (last - i) * minGap)) continue;

    // With no time on a stationary segment, allow a typical segment's worth of
    // time for an in-place pan or zoom.
    const weights = segments.slice(anchor, i).map(segment => segment.length || holdWeight);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let elapsedWeight = 0;
    for (let j = anchor + 1; j < i; j++) {
      elapsedWeight += weights[j - anchor - 1];
      const proportional = times[anchor] + (time - times[anchor]) * (elapsedWeight / total);
      times[j] = clamp(proportional, times[j - 1] + minGap, time - (i - j) * minGap);
    }
    times[i] = time;
    anchor = i;
  }
  return times;
}

function rotationTangent(from, to) {
  // Great-circle tangent on the unit quaternion sphere at "from".
  const dot = from.dot(to);
  const tangent = to.clone().addScaledVector(from, -dot);
  const length = tangent.length();
  return length > 1e-15 ? tangent.multiplyScalar(Math.atan2(length, dot) / length) : tangent.set(0, 0, 0, 0);
}

function rotationControls(rotations, widths, stopFirst, stopLast) {
  const rates = rotations.map((rotation, i) => {
    const left = widths[i - 1] ? rotationTangent(rotation, rotations[i - 1]).multiplyScalar(-1 / widths[i - 1]) : null;
    const right = widths[i] ? rotationTangent(rotation, rotations[i + 1]).multiplyScalar(1 / widths[i]) : null;
    if (!left) return stopFirst ? new Vector4(0, 0, 0, 0) : right;
    if (!right) return stopLast ? new Vector4(0, 0, 0, 0) : left;

    const leftSpeed = left.length();
    const rightSpeed = right.length();
    if (!leftSpeed || !rightSpeed) return left.set(0, 0, 0, 0);

    // Use the angle bisector so the shared tangent points along both turns.
    // Limit its speed by the slower turn to avoid winding back between keys.
    const span = widths[i - 1] + widths[i];
    const rate = Math.min(span / (widths[i] / leftSpeed + widths[i - 1] / rightSpeed),
      1.5 * Math.min(leftSpeed, rightSpeed));
    return left.multiplyScalar(0.5 / leftSpeed).addScaledVector(right, 0.5 / rightSpeed).multiplyScalar(rate);
  });

  // A normalized quaternion Bézier spline. Each knot has one tangent in the
  // quaternion's tangent plane, scaled by the adjoining time interval.
  return widths.map((width, i) => [
    rotations[i].clone().addScaledVector(rates[i], width / 3),
    rotations[i + 1].clone().addScaledVector(rates[i + 1], -width / 3),
  ]);
}

function compile(keys) {
  const positions = [];
  const fovs = [];
  const angles = new Euler();
  const q = new Quaternion();
  const rotations = [];
  const distinct = [];
  for (const key of keys) {
    const pos = new Vector3(...key.pos.map(coordinate));
    const fov = Number.isFinite(key.fov) && key.fov > 0 && key.fov < 180 ? key.fov : DEFAULT_FOV;
    q.setFromEuler(angles.set(finite(key.pitch), -finite(key.yaw), finite(key.roll), 'YXZ'));
    const rotation = new Vector4(q.x, q.y, q.z, q.w).normalize();
    if (rotations.length && rotation.dot(rotations.at(-1)) < 0) rotation.negate();

    // An identical key only needs a separate knot if both copies specify
    // different times. Otherwise retain the pose and any explicit anchor.
    const previous = distinct.at(-1);
    if (previous && pos.equals(positions.at(-1)) && fov === fovs.at(-1) && rotation.equals(rotations.at(-1))
      && (!validTime(previous.time) || !validTime(key.time) || previous.time === key.time)) {
      if (validTime(key.time)) distinct[distinct.length - 1] = key;
      continue;
    }
    positions.push(pos);
    rotations.push(rotation);
    fovs.push(fov);
    distinct.push(key);
  }

  if (distinct.length < 2) return { positions, rotations, fovs };
  const { segments, stops } = positionSegments(positions);
  const times = keyTimes(distinct, segments);
  const widths = times.slice(1).map((time, i) => time - times[i]);
  const stopFirst = times[0] > 0;
  const stopLast = times.at(-1) < 1;
  const speed = segments.map((segment, i) => segment.length / widths[i]);
  const speedRates = monotoneRates(widths, speed, stopFirst, stopLast);
  for (let i = 0; i < stops.length; i++) {
    if (stops[i]) speedRates[i] = 0;
  }
  const fovRates = monotoneRates(widths, widths.map((width, i) => (fovs[i + 1] - fovs[i]) / width), stopFirst, stopLast);
  const controls = rotationControls(rotations, widths, stopFirst, stopLast);
  return { positions, rotations, fovs, segments, times, widths, speed, speedRates, fovRates, controls };
}

function keyValues(key) {
  return {
    pos: [key?.pos?.[0], key?.pos?.[1], key?.pos?.[2]],
    yaw: key?.yaw,
    pitch: key?.pitch,
    roll: key?.roll,
    fov: key?.fov,
    time: key?.time,
  };
}

function matchesKeys(snapshot, keys) {
  if (snapshot.length !== keys.length) return false;
  return snapshot.every((value, i) => {
    const key = keys[i];
    return value.pos.every((component, j) => Object.is(component, key?.pos?.[j]))
      && KEY_FIELDS.every(field => Object.is(value[field], key?.[field]));
  });
}

export class Director {
  #camera;
  #compiled = new WeakMap();
  #pose = { pos: new Vector3(), quat: new Quaternion(), fov: DEFAULT_FOV };
  #rotation = new Vector4();
  #otherQuat = new Quaternion();
  #position = new Vector3();
  #index = 0;
  #elapsed = 0;
  #elapsedError = 0;
  #all = false;

  constructor(camera) {
    this.#camera = camera;
    this.shots = [];
    this.current = -1;
    this.playing = false;
  }

  newShot(name, duration = 8) {
    this.current = this.shots.push({ name, duration, ease: 'linear', keys: [] }) - 1;
    return this.current;
  }

  addKey(extra) {
    const shot = this.shots[this.current];
    if (!shot) return;

    const camera = this.#camera;
    const pos = camera.getWorldPosition(this.#position).toArray();
    const { x, y, z, w } = camera.getWorldQuaternion(this.#otherQuat).normalize();

    // In YXZ, these pairs encode half of yaw minus/plus roll. Using the
    // pairs directly preserves the combined turn even at vertical pitch.
    const a = Math.hypot(w + x, y - z);
    const b = Math.hypot(w - x, y + z);
    const pitch = 2 * Math.atan2(a - b, a + b);
    const difference = Math.atan2(y - z, w + x);
    const sum = Math.atan2(y + z, w - x);
    const yaw = wrapAngle(a < 1e-14 ? -2 * sum : b < 1e-14 ? -2 * difference : -sum - difference);
    const roll = a < 1e-14 || b < 1e-14 ? 0 : wrapAngle(sum - difference);
    const key = { pos, yaw, pitch, fov: camera.fov };
    if (extra?.roll !== undefined || Math.abs(roll) > 1e-14) key.roll = extra?.roll ?? roll;
    if (extra?.time !== undefined) key.time = extra.time;
    if (!Array.isArray(shot.keys)) shot.keys = [];
    shot.keys.push(key);
  }

  removeLastKey() {
    const keys = this.shots[this.current]?.keys;
    if (Array.isArray(keys)) keys.pop();
  }

  sample(shot, u) {
    const pose = this.#pose;
    const keys = Array.isArray(shot?.keys) ? shot.keys : [];
    if (!keys.length) {
      pose.pos.set(0, 0, 0);
      pose.quat.identity();
      pose.fov = DEFAULT_FOV;
      return pose;
    }

    let entry = this.#compiled.get(shot);
    if (!entry || !matchesKeys(entry.snapshot, keys)) {
      const snapshot = Array.from(keys, keyValues);
      entry = { snapshot, path: compile(snapshot) };
      this.#compiled.set(shot, entry);
    }

    const { positions, rotations, fovs, segments, times, widths, speed, speedRates, fovRates, controls } = entry.path;
    // Both explicit and distance-derived key times are in eased shot progress.
    const t = eased(u, shot.ease);
    const last = positions.length - 1;
    if (last === 0 || t <= times[0] || t >= times[last]) {
      const i = last === 0 || t <= times[0] ? 0 : last;
      pose.pos.copy(positions[i]);
      pose.quat.copy(rotations[i]);
      pose.fov = fovs[i];
      return pose;
    }

    const i = interval(times, t);
    const width = widths[i];
    const s = (t - times[i]) / width;
    const distance = speed[i] ? unit(hermiteOffset(s, 1, speedRates[i] / speed[i], speedRates[i + 1] / speed[i])) : 0;
    positionAt(positions[i], positions[i + 1], segments[i], distance, pose.pos);

    pose.quat.copy(rotations[i]);
    if (last === 1 && times[0] === 0 && times[1] === 1) {
      pose.quat.slerp(this.#otherQuat.copy(rotations[i + 1]), s).normalize();
    } else if (s > 0) {
      const [a, b] = controls[i];
      const r = 1 - s;
      this.#rotation.copy(rotations[i]).multiplyScalar(r ** 3)
        .addScaledVector(a, 3 * r * r * s).addScaledVector(b, 3 * r * s * s)
        .addScaledVector(rotations[i + 1], s ** 3);
      pose.quat.copy(this.#rotation).normalize();
    }

    const fov = fovs[i] + hermiteOffset(s, fovs[i + 1] - fovs[i], fovRates[i] * width, fovRates[i + 1] * width);
    pose.fov = clamp(fov, Math.min(fovs[i], fovs[i + 1]), Math.max(fovs[i], fovs[i + 1]));
    return pose;
  }

  #apply(shot, u) {
    const { pos, quat, fov } = this.sample(shot, u);
    const camera = this.#camera;
    camera.position.copy(pos);
    camera.quaternion.copy(quat);
    if (camera.parent) {
      camera.parent.worldToLocal(camera.position);
      camera.parent.getWorldQuaternion(this.#otherQuat).invert();
      camera.quaternion.premultiply(this.#otherQuat);
    }
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }

  #start(index, all) {
    this.stop();
    const shot = this.shots[index];
    if (!shot) return;

    this.#index = index;
    this.#elapsed = 0;
    this.#elapsedError = 0;
    this.#all = all;
    this.playing = true;
    this.#apply(shot, 0);
  }

  play(index = this.current) {
    this.#start(index, false);
  }

  playAll() {
    this.#start(0, true);
  }

  stop() {
    this.playing = false;
  }

  update(dt) {
    if (!this.playing) return false;

    let shot = this.shots[this.#index];
    if (!shot) {
      this.stop();
      return false;
    }
    // Compensated addition keeps repeated fixed steps on the same shot
    // boundaries as a frame clock.
    const step = Math.max(0, finite(dt)) - this.#elapsedError;
    const elapsed = this.#elapsed + step;
    this.#elapsedError = (elapsed - this.#elapsed) - step;
    this.#elapsed = elapsed;
    let duration = durationOf(shot);
    while (reachesEnd(this.#elapsed, duration) && this.#all && this.shots[this.#index + 1]) {
      this.#elapsed = Math.max(0, this.#elapsed - duration - this.#elapsedError);
      this.#elapsedError = 0;
      shot = this.shots[++this.#index];
      duration = durationOf(shot);
    }
    if (reachesEnd(this.#elapsed, duration)) {
      this.#apply(shot, 1);
      this.stop();
    } else {
      this.#apply(shot, this.#elapsed / duration);
    }
    return true;
  }

  seek(index, u) {
    this.stop();
    const shot = this.shots[index];
    if (shot) this.#apply(shot, u);
  }

  toJSON() {
    return { version: 1, shots: structuredClone(this.shots) };
  }

  fromJSON(data) {
    this.stop();
    this.shots = data?.version === 1 && Array.isArray(data.shots) ? structuredClone(data.shots) : [];
    this.current = this.shots.length ? 0 : -1;
  }

  bake(fps = 60) {
    fps = Number.isFinite(fps) && fps > 0 ? fps : 60;
    const frames = [];
    this.shots.forEach((shot, index) => {
      const duration = durationOf(shot);
      const count = Math.round(duration * fps);
      if (!Number.isSafeInteger(count)) return;
      // Sample at fixed frame intervals from the start, without duplicating
      // the endpoint at a cut. Round fractional frame counts to the nearest frame.
      for (let frame = 0; frame < count; frame++) {
        const { pos, quat, fov } = this.sample(shot, frame / fps / duration);
        frames.push({ shot: index, name: shot?.name, pos: pos.toArray(), quat: quat.toArray(), fov });
      }
    });
    return { fps, frames };
  }
}
