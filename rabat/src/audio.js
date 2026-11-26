const MASTER_LEVEL = 0.5;
const GEAR_SPEEDS = [0, 8, 16, 25, 35, 47, 64]; // m/s
const BURST_NOTES = [293.66, 440, 659.25, 739.99]; // D, A, E, F#

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
}

function gainTo(context, output) {
  const gain = context.createGain();
  gain.gain.value = 0;
  gain.connect(output);
  return gain;
}

function filterTo(context, output, type, frequency, q = 0.707) {
  const filter = context.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = q;
  filter.connect(output);
  return filter;
}

function oscillatorTo(context, output, type, frequency) {
  const oscillator = context.createOscillator();
  oscillator.type = type;
  oscillator.frequency.value = frequency;
  oscillator.connect(output);
  return oscillator;
}

function envelope(param, start, attack, peak, duration) {
  const end = start + duration;
  param.cancelScheduledValues(start);
  param.setValueAtTime(0, start);
  param.linearRampToValueAtTime(peak, start + attack);
  param.exponentialRampToValueAtTime(peak * 0.002, end - 0.012);
  param.linearRampToValueAtTime(0, end);
}

function makeNoise(context) {
  const buffer = context.createBuffer(2, 4 * context.sampleRate, context.sampleRate);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

function makeGraph(context) {
  const limiter = context.createWaveShaper();
  const curve = new Float32Array(2049);
  for (let i = 0; i < curve.length; i++) {
    const sample = i / 1024 - 1;
    const magnitude = Math.abs(sample);
    // Unity gain for normal play, with a soft ceiling for stacked transients.
    curve[i] = magnitude <= 0.7
      ? sample
      : Math.sign(sample) * (0.7 + 0.26 * Math.tanh((magnitude - 0.7) / 0.26));
  }
  limiter.curve = curve;
  limiter.connect(context.destination);

  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -17;
  compressor.knee.value = 14;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.006;
  compressor.release.value = 0.2;
  compressor.connect(limiter);
  const master = gainTo(context, compressor);

  const noiseBuffer = makeNoise(context);
  const noise = context.createBufferSource();
  noise.buffer = noiseBuffer;
  noise.loop = true;
  const noiseChannels = context.createChannelSplitter(2);
  noise.connect(noiseChannels);

  const engineGain = gainTo(context, master);
  const engineFilter = filterTo(context, engineGain, 'lowpass', 280);
  const engineBody = oscillatorTo(context, engineFilter, 'triangle', 34);
  const engineRaspGain = gainTo(context, engineFilter);
  const engineRasp = oscillatorTo(context, engineRaspGain, 'sawtooth', 37.4);
  const engineNoise = gainTo(context, engineFilter);
  noiseChannels.connect(engineNoise, 0);

  const roadGain = gainTo(context, master);
  const roadFilter = filterTo(context, roadGain, 'bandpass', 145, 0.65);
  noiseChannels.connect(roadFilter, 0);
  const tyreGain = gainTo(context, master);
  const tyreFilter = filterTo(context, tyreGain, 'bandpass', 850, 4.5);
  noiseChannels.connect(tyreFilter, 1);
  const tyreToneGain = gainTo(context, tyreGain);
  const tyreTone = oscillatorTo(context, tyreToneGain, 'triangle', 850);

  const windGain = gainTo(context, master);
  const windLowpass = filterTo(context, windGain, 'lowpass', 620);
  const windHighpass = filterTo(context, windLowpass, 'highpass', 65);
  noise.connect(windHighpass);

  const cityGain = gainTo(context, master);
  const cityStereo = context.createChannelMerger(2);
  cityStereo.connect(cityGain);
  const cityLeft = context.createBiquadFilter();
  const cityRight = context.createBiquadFilter();
  cityLeft.type = cityRight.type = 'bandpass';
  cityLeft.frequency.value = 118;
  cityRight.frequency.value = 154;
  cityLeft.Q.value = cityRight.Q.value = 0.62;
  noiseChannels.connect(cityLeft, 0);
  noiseChannels.connect(cityRight, 1);
  cityLeft.connect(cityStereo, 0, 0);
  cityRight.connect(cityStereo, 0, 1);

  const airGain = gainTo(context, master);
  const airFilter = filterTo(context, airGain, 'bandpass', 980, 0.58);
  noise.connect(airFilter);

  // Reusable voices let update trigger footsteps and distant traffic without creating nodes.
  const stepGain = gainTo(context, master);
  const stepNoise = filterTo(context, stepGain, 'lowpass', 760);
  noiseChannels.connect(stepNoise, 1);
  const stepBody = oscillatorTo(context, stepGain, 'sine', 92);

  const distantGain = gainTo(context, master);
  const distantFilter = filterTo(context, distantGain, 'lowpass', 800);
  const distantBody = oscillatorTo(context, distantFilter, 'triangle', 390);
  const distantOvertoneGain = gainTo(context, distantFilter);
  const distantOvertone = oscillatorTo(context, distantOvertoneGain, 'sine', 580);

  const now = context.currentTime;
  engineRaspGain.gain.setTargetAtTime(0.28, now, 0.02);
  engineNoise.gain.setTargetAtTime(0.13, now, 0.02);
  tyreToneGain.gain.setTargetAtTime(0.22, now, 0.02);
  distantOvertoneGain.gain.setTargetAtTime(0.29, now, 0.02);
  noise.start(now);
  engineBody.start(now);
  engineRasp.start(now);
  tyreTone.start(now);
  stepBody.start(now);
  distantBody.start(now);
  distantOvertone.start(now);

  return {
    master, noiseBuffer,
    engineGain, engineFilter, engineBody, engineRasp,
    roadGain, roadFilter, tyreGain, tyreFilter, tyreTone,
    windGain, windLowpass, windHighpass, cityGain, airGain,
    stepGain, stepNoise, stepBody, distantGain, distantFilter, distantBody, distantOvertone,
  };
}

export class GameAudio {
  #context = null;
  #graph = null;
  #failed = false;
  #resuming = false;
  #muted = false;
  #nextMix = 0;
  #gear = 0;
  #shiftUntil = 0;
  #stepPhase = 0;
  #nextStep = 0;
  #nextDistant = 0;

  constructor() {}

  unlock() {
    if (this.#failed || this.#resuming) return;
    try {
      if (!this.#context) {
        const AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext;
        if (!AudioContext) {
          this.#failed = true;
          return;
        }
        const context = new AudioContext();
        this.#context = context;
        this.#graph = makeGraph(context);
        this.#nextDistant = context.currentTime + 8 + Math.random() * 10;
        this.#rampMaster();
      }

      if (this.#context.state === 'closed') {
        this.#disable();
      } else if (this.#context.state !== 'running') {
        // Call resume in the gesture handler, before yielding to the browser.
        this.#resuming = true;
        this.#context.resume().then(
          () => { this.#resuming = false; },
          () => this.#disable(),
        );
      }
    } catch {
      this.#disable();
    }
  }

  #disable() {
    const context = this.#context;
    this.#failed = true;
    this.#resuming = false;
    this.#graph = null;
    this.#context = null;
    try {
      if (context && context.state !== 'closed') context.close().catch(() => {});
    } catch {
      // A partially initialized context may already be unusable.
    }
  }

  #rampMaster() {
    const now = this.#context.currentTime;
    const gain = this.#graph.master.gain;
    gain.cancelScheduledValues(now);
    gain.setTargetAtTime(this.#muted ? 0 : MASTER_LEVEL, now, 0.025);
  }

  setMuted(muted) {
    muted = Boolean(muted);
    if (muted === this.#muted) return;
    this.#muted = muted;
    if (this.#graph && this.#context.state !== 'closed') this.#rampMaster();
  }

  get muted() {
    return this.#muted;
  }

  update(dt, state) {
    const context = this.#context;
    if (!this.#graph || context.state !== 'running' || !state) return;
    const now = context.currentTime;
    const speed = clamp(state.speed, 0, 250);
    const altitude = clamp(state.altitude, 0, 2500);
    const night = clamp(state.night, 0, 1);
    const street = 1 / (1 + (altitude / 95) ** 2);

    if (now >= this.#nextMix) {
      this.#nextMix = now + 1 / 45;
      this.#mix(now, state, speed, altitude, street, night);
    }

    if (!this.#muted && state.mode === 'walk' && state.onGround && speed > 0.65) {
      const pace = clamp(speed / 14, 0, 1);
      this.#stepPhase += clamp(dt, 0, 0.1) * (1.05 + 3.05 * pace);
      if (this.#stepPhase >= 1) {
        this.#stepPhase -= 1;
        if (now >= this.#nextStep) this.#footstep(now, pace);
      }
    } else {
      this.#stepPhase = 0.65; // Let the first stride arrive sooner after standing still.
    }

    if (now >= this.#nextDistant) {
      this.#nextDistant = now + 11 + Math.random() * 15 + night * 9;
      if (!this.#muted && street > 0.11) this.#distantTraffic(now, street, night);
    }
  }

  #mix(now, state, speed, altitude, street, night) {
    const graph = this.#graph;
    if (state.mode === 'drive') {
      this.#drive(now, state, speed);
    } else {
      this.#gear = 0;
      this.#shiftUntil = 0;
      graph.engineGain.gain.setTargetAtTime(0, now, 0.06);
      graph.roadGain.gain.setTargetAtTime(0, now, 0.08);
      graph.tyreGain.gain.setTargetAtTime(0, now, 0.05);
    }

    const flying = state.mode === 'fly';
    const airborne = flying || (state.mode === 'walk' && !state.onGround);
    // Walking includes vertical speed, so the same layer swells naturally during a drop.
    const airspeed = airborne ? clamp(speed / (flying ? 250 : 75), 0, 1) : 0;
    const thin = altitude / (altitude + 370);
    graph.windGain.gain.setTargetAtTime(0.35 * airspeed ** 0.82 * (1 - 0.44 * thin), now, 0.11);
    graph.windHighpass.frequency.setTargetAtTime(65 + 285 * thin, now, 0.14);
    graph.windLowpass.frequency.setTargetAtTime(520 + 2850 * airspeed, now, 0.12);
    graph.cityGain.gain.setTargetAtTime(0.22 * street * (1 - 0.28 * night), now, 0.25);
    graph.airGain.gain.setTargetAtTime(0.047 * (1 - street) * (1 - 0.15 * night), now, 0.25);
  }

  #drive(now, state, speed) {
    const graph = this.#graph;
    const throttle = clamp(state.throttle, -1, 1);
    // S can mean braking or reverse. Above the game's reverse limit it can only be braking.
    const load = throttle < 0 && speed > 11 ? 0 : Math.abs(throttle);
    const boost = state.boost ? 1 : 0;
    const oldGear = this.#gear;
    const topGear = GEAR_SPEEDS.length - 2;
    while (this.#gear < topGear && speed >= GEAR_SPEEDS[this.#gear + 1]) this.#gear++;
    while (this.#gear > 0 && speed < GEAR_SPEEDS[this.#gear] - 1.6) this.#gear--;
    if (this.#gear > oldGear) this.#shiftUntil = now + 0.09;

    const low = GEAR_SPEEDS[this.#gear];
    const high = GEAR_SPEEDS[this.#gear + 1];
    const revs = clamp((speed - low) / (high - low), 0, 1);
    const rolling = clamp(speed / 62, 0, 1);
    const overrun = (1 - load) * rolling;
    const fundamental = (this.#gear ? 57 : 34) + 61 * revs + load * (5 + 7 * boost) - 7 * overrun;
    const shifting = now < this.#shiftUntil;
    graph.engineBody.frequency.setTargetAtTime(fundamental, now, shifting ? 0.035 : 0.065);
    // The close detune gives the engine a slow beat that is easiest to hear at idle.
    graph.engineRasp.frequency.setTargetAtTime(fundamental * 1.021 + 2.7, now, shifting ? 0.035 : 0.065);
    graph.engineFilter.frequency.setTargetAtTime(245 + 660 * load + 290 * revs + 520 * boost * load, now, 0.075);
    const level = 0.097 + 0.097 * load + 0.042 * revs + 0.025 * overrun + 0.036 * boost * load;
    graph.engineGain.gain.setTargetAtTime(level * (shifting ? 0.62 : 1), now, 0.04);

    graph.roadFilter.frequency.setTargetAtTime(145 + 470 * rolling, now, 0.1);
    graph.roadGain.gain.setTargetAtTime(0.28 * rolling ** 0.85, now, 0.09);
    const slip = clamp((clamp(state.slip, 0, 24) - 0.7) / 10, 0, 1);
    const lockedTyres = state.handbrake ? 0.52 * clamp((speed - 2) / 16, 0, 1) : 0;
    const squeal = Math.max(slip, lockedTyres);
    const squealPitch = 750 + 520 * squeal + 300 * rolling;
    graph.tyreTone.frequency.setTargetAtTime(squealPitch * 1.023, now, 0.045);
    graph.tyreFilter.frequency.setTargetAtTime(squealPitch, now, 0.055);
    graph.tyreGain.gain.setTargetAtTime(0.2 * squeal, now, 0.055);
  }

  #footstep(now, pace) {
    const graph = this.#graph;
    const start = now + 0.008;
    const duration = 0.135;
    this.#nextStep = start + duration;
    const variation = Math.random();
    graph.stepNoise.frequency.setTargetAtTime(620 + 440 * pace + 300 * variation, now, 0.008);
    graph.stepBody.frequency.setTargetAtTime(80 + 27 * variation, now, 0.008);
    envelope(graph.stepGain.gain, start, 0.012, 0.035 + 0.028 * pace, duration);
  }

  #distantTraffic(now, street, night) {
    const graph = this.#graph;
    const start = now + 0.015;
    const level = 0.046 * street * (1 - 0.24 * night);
    const body = graph.distantBody.frequency;
    const overtone = graph.distantOvertone.frequency;
    if (Math.random() < 0.62) {
      const pitch = 300 + 110 * Math.random();
      body.setTargetAtTime(pitch, now, 0.015);
      overtone.setTargetAtTime(pitch * 1.49, now, 0.015);
      graph.distantFilter.frequency.setTargetAtTime(630, now, 0.025);
      envelope(graph.distantGain.gain, start, 0.11, level, 0.58);
    } else {
      body.setValueAtTime(425, start);
      body.linearRampToValueAtTime(685, start + 0.7);
      body.linearRampToValueAtTime(385, start + 1.65);
      overtone.setValueAtTime(850, start);
      overtone.linearRampToValueAtTime(1370, start + 0.7);
      overtone.linearRampToValueAtTime(770, start + 1.65);
      graph.distantFilter.frequency.setTargetAtTime(960, now, 0.025);
      envelope(graph.distantGain.gain, start, 0.61, level * 0.85, 2.1);
    }
  }

  #canPlay() {
    return this.#graph && !this.#muted && (this.#context.state === 'running' || this.#resuming);
  }

  #voice(source, start, peak, attack, duration, filter, offset) {
    const context = this.#context;
    const gain = gainTo(context, this.#graph.master);
    if (filter) filter.connect(gain);
    source.connect(filter || gain);
    envelope(gain.gain, start, attack, peak, duration);
    source.onended = () => {
      source.disconnect();
      if (filter) filter.disconnect();
      gain.disconnect();
      source.onended = null;
    };
    if (offset === undefined) source.start(start);
    else source.start(start, offset);
    source.stop(start + duration + 0.025);
  }

  #tone(start, type, from, to, sweep, peak, attack, duration, cutoff = 0) {
    const context = this.#context;
    const source = context.createOscillator();
    source.type = type;
    source.frequency.setValueAtTime(from, start);
    source.frequency.exponentialRampToValueAtTime(to, start + sweep);
    const filter = cutoff ? context.createBiquadFilter() : null;
    if (filter) {
      filter.type = 'lowpass';
      filter.frequency.value = cutoff;
      filter.Q.value = 0.707;
    }
    this.#voice(source, start, peak, attack, duration, filter);
  }

  #noiseHit(start, type, from, to, peak, attack, duration) {
    const context = this.#context;
    const source = context.createBufferSource();
    source.buffer = this.#graph.noiseBuffer;
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.Q.value = 0.707;
    filter.frequency.setValueAtTime(from, start);
    filter.frequency.exponentialRampToValueAtTime(to, start + duration * 0.8);
    const offset = Math.random() * (source.buffer.duration - duration - 0.03);
    this.#voice(source, start, peak, attack, duration, filter, offset);
  }

  impact(strength) {
    if (!this.#canPlay()) return;
    strength = clamp(strength, 0, 40);
    if (strength <= 0) return;
    const severity = (strength / 40) ** 0.75;
    const start = this.#context.currentTime + 0.012;
    this.#tone(start, 'triangle', 102 - 27 * severity, 58 - 21 * severity, 0.10,
      0.062 + 0.23 * severity, 0.009, 0.15 + 0.24 * severity, 320);
    this.#noiseHit(start, 'lowpass', 610 + 4000 * severity, 230 + 440 * severity,
      0.08 + 0.43 * severity, 0.007, 0.13 + 0.31 * severity);
  }

  door() {
    if (!this.#canPlay()) return;
    const start = this.#context.currentTime + 0.012;
    this.#tone(start, 'triangle', 136, 76, 0.073, 0.13, 0.008, 0.15, 440);
    this.#noiseHit(start + 0.019, 'lowpass', 1200, 330, 0.18, 0.007, 0.115);
  }

  fire() {
    if (!this.#canPlay()) return;
    const start = this.#context.currentTime + 0.012;
    this.#tone(start, 'triangle', 235, 1460, 0.19, 0.14, 0.048, 0.28, 2800);
    this.#noiseHit(start, 'bandpass', 480, 3650, 0.26, 0.078, 0.29);
  }

  burst(distance) {
    if (!this.#canPlay()) return;
    distance = clamp(distance, 0, 1800);
    const level = 1 / (1 + (distance / 275) ** 1.27);
    const clarity = 1 / (1 + distance / 270);
    const start = this.#context.currentTime + 0.012 + Math.min(1.5, distance / 343);
    this.#tone(start, 'sine', 74, 33, 0.29, 0.36 * level, 0.023, 0.86);
    this.#noiseHit(start, 'lowpass', 170 + 1550 * clarity, 95 + 150 * clarity,
      0.48 * level, 0.017, 0.65);

    const cutoff = 210 + 2550 * clarity ** 1.6;
    for (let i = 0; i < BURST_NOTES.length; i++) {
      const note = BURST_NOTES[i];
      const onset = start + 0.028 + i * 0.038;
      const shimmer = note * (i % 2 ? 1.013 : 0.989);
      this.#tone(onset, 'triangle', shimmer, note, 0.55, 0.072 * level * (0.85 ** i),
        0.06 + i * 0.014, 2.45 - i * 0.18, cutoff);
    }
  }
}
