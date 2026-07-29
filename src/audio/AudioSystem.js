import * as THREE from 'three';
import { settings } from '../core/Settings.js';

// ---------------------------------------------------------------------------
// Fully procedural audio — no sample assets. A gunshot is synthesised as three
// layered components, which is how real weapon audio is actually mixed:
//
//   1. Transient  — the supersonic crack: a very short noise burst through a
//                   steep highpass, this is what gives the shot its "snap".
//   2. Body       — the muzzle blast: filtered noise with a fast exponential
//                   decay and a pitched low thump for chest impact.
//   3. Tail       — convolved reverb carrying the report into the environment;
//                   the impulse response is generated from decaying noise.
// ---------------------------------------------------------------------------

/** Builds a decaying-noise impulse response for a space of a given size. */
function makeImpulseResponse(ctx, seconds, decay, damping) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    // Low-passed noise: high frequencies die faster, as air absorption does.
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const env = Math.pow(1 - t, decay);
      const n = Math.random() * 2 - 1;
      lp += (n - lp) * (1 - damping * t);
      // Sparse early reflections give the tail a sense of geometry.
      const early = (i < rate * 0.09 && Math.random() < 0.0016) ? (Math.random() * 2 - 1) * 0.8 : 0;
      d[i] = (lp * env) + early * Math.pow(1 - t, 2);
    }
  }
  return buf;
}

function makeNoiseBuffer(ctx, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

export class AudioSystem {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.listener = null;
    this._pending = [];
  }

  /** Must be called from a user gesture — browsers block audio otherwise. */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx({ latencyHint: 'interactive' });
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = settings.audioMaster;

    // A gentle limiter keeps overlapping shots from clipping.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.14;

    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    // Dry/wet buses
    this.dry = ctx.createGain();
    this.dry.gain.value = 1.0;
    this.dry.connect(this.master);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = makeImpulseResponse(ctx, 2.4, 3.4, 0.55);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.42;
    this.reverb.connect(this.wet);
    this.wet.connect(this.master);

    this.noise = makeNoiseBuffer(ctx, 2.0);

    this.ready = true;
    for (const fn of this._pending) fn();
    this._pending.length = 0;
  }

  _noiseSource(offset = Math.random() * 1.5) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    return { source: s, offset };
  }

  /** Full weapon report. `distance` in metres attenuates and dulls it. */
  gunshot(distance = 0) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const atten = 1 / (1 + distance * 0.06);
    const delay = distance / 343;

    const out = ctx.createGain();
    out.gain.value = 0.85 * atten;
    out.connect(this.dry);
    out.connect(this.reverb);

    // --- 1. transient crack ---
    const crack = this._noiseSource();
    const crackGain = ctx.createGain();
    const crackHP = ctx.createBiquadFilter();
    crackHP.type = 'highpass';
    crackHP.frequency.value = 2400 - distance * 12;
    crackHP.Q.value = 0.7;
    crack.source.connect(crackHP);
    crackHP.connect(crackGain);
    crackGain.connect(out);
    crackGain.gain.setValueAtTime(0.0001, t + delay);
    crackGain.gain.exponentialRampToValueAtTime(1.0, t + delay + 0.0012);
    crackGain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.035);
    crack.source.start(t + delay, crack.offset);
    crack.source.stop(t + delay + 0.06);

    // --- 2. muzzle blast body ---
    const body = this._noiseSource();
    const bodyGain = ctx.createGain();
    const bodyBP = ctx.createBiquadFilter();
    bodyBP.type = 'bandpass';
    bodyBP.frequency.setValueAtTime(900, t + delay);
    bodyBP.frequency.exponentialRampToValueAtTime(220, t + delay + 0.16);
    bodyBP.Q.value = 0.9;
    body.source.connect(bodyBP);
    bodyBP.connect(bodyGain);
    bodyGain.connect(out);
    bodyGain.gain.setValueAtTime(0.0001, t + delay);
    bodyGain.gain.exponentialRampToValueAtTime(0.85, t + delay + 0.004);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.22);
    body.source.start(t + delay, body.offset);
    body.source.stop(t + delay + 0.3);

    // --- 3. low thump ---
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, t + delay);
    osc.frequency.exponentialRampToValueAtTime(48, t + delay + 0.13);
    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(0.0001, t + delay);
    oscGain.gain.exponentialRampToValueAtTime(0.55 * atten, t + delay + 0.006);
    oscGain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.18);
    osc.connect(oscGain);
    oscGain.connect(this.dry);
    osc.start(t + delay);
    osc.stop(t + delay + 0.25);

    // --- 4. mechanical action ---
    this._click(t + delay + 0.02, 0.12 * atten, 3200);
  }

  /** Short metallic transient — bolt, mag release, selector. */
  _click(when, gain, freq) {
    const ctx = this.ctx;
    const s = this._noiseSource();
    const g = ctx.createGain();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = 5;
    s.source.connect(bp); bp.connect(g); g.connect(this.dry);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, gain), when + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    s.source.start(when, s.offset);
    s.source.stop(when + 0.07);
  }

  /** Reload foley: mag out, mag in, bolt release. */
  reload(duration) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._click(t + duration * 0.20, 0.22, 900);
    this._click(t + duration * 0.34, 0.16, 420);   // mag hits the ground
    this._click(t + duration * 0.62, 0.30, 1400);  // seat
    this._click(t + duration * 0.78, 0.26, 2600);  // charging handle
    this._click(t + duration * 0.86, 0.34, 1900);  // bolt slams home
  }

  /** Bullet impact — spectrum depends on what was hit. */
  impact(material, distance = 0) {
    if (!this.ready) return;
    const freq = { concrete: 1500, sand: 700, metal: 3800, wood: 1100, flesh: 500 }[material] || 1500;
    const gain = 0.30 / (1 + distance * 0.09);
    this._click(this.ctx.currentTime + distance / 343, gain, freq);
  }

  /** Footstep — filtered noise burst; pitch varies with surface. */
  footstep(material = 'sand', intensity = 1) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const s = this._noiseSource();
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = { sand: 900, concrete: 2200, metal: 3400 }[material] || 1400;
    lp.Q.value = 1.2;
    s.source.connect(lp); lp.connect(g); g.connect(this.dry);
    const peak = 0.09 * intensity;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, peak), t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    s.source.start(t, s.offset);
    s.source.stop(t + 0.16);
  }

  setMasterVolume(v) {
    settings.audioMaster = v;
    if (this.master) this.master.gain.value = v;
  }
}
