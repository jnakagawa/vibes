// What one phone plays: the voices passing through its ring position, each a
// stack of 4 sine partials at this position's bend, through the ensemble's
// voicing chain (shelf, lowpass, generated-IR reverb, compressor). The room
// does the rest — beating, interference and the chord's movement happen in
// the air between phones.
(function (root) {
  'use strict';
  const NR = root.NearfieldRing;

  // only touch an AudioParam when its target moved (keeps automation lists short)
  function setT(param, v, now, tau, eps) {
    if (param._last !== undefined && Math.abs(param._last - v) <= eps) return;
    param._last = v;
    param.setTargetAtTime(v, now, tau);
  }

  class RingAudio {
    constructor(params) {
      this.params = params;
      this.ctx = null;
      this.voices = new Map();   // v -> nodes
      this.level = 0;            // for the screen's glow
    }

    // call from a tap (browser rule)
    async start() {
      // iOS: a playback session ignores the ring/silent switch
      if (navigator.audioSession) { try { navigator.audioSession.type = 'playback'; } catch (_) {} }
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
      this.ctx = ctx;
      const resumed = ctx.resume();
      const T = this.params.timbre;
      this.comp = new DynamicsCompressorNode(ctx, { threshold: -14, knee: 12, ratio: 4, attack: 0.01, release: 0.3 });
      this.shelf = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: T.shelf_freq_hz, gain: T.shelf_gain_db });
      this.lowpass = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: T.lowpass_hz, Q: 0.5 });
      this.dry = new GainNode(ctx, { gain: Math.cos(T.reverb_wet * Math.PI / 2) });
      this.wet = new GainNode(ctx, { gain: Math.sin(T.reverb_wet * Math.PI / 2) });
      this.convolver = new ConvolverNode(ctx);
      this.convolver.buffer = this._ir();
      this.master = new GainNode(ctx, { gain: 0 });
      this.analyser = new AnalyserNode(ctx, { fftSize: 512 });
      this.sum = new GainNode(ctx, { gain: 1 });
      this.sum.connect(this.shelf).connect(this.lowpass);
      this.lowpass.connect(this.dry).connect(this.comp);
      this.lowpass.connect(this.convolver).connect(this.wet).connect(this.comp);
      this.comp.connect(this.master);
      this.master.connect(this.analyser);
      // play through an <audio> element (MediaStream): iOS treats the page as
      // a media player, so it sounds with the silent switch on and survives
      // screen lock; fall back to the plain destination
      try {
        const dest = ctx.createMediaStreamDestination();
        this.master.connect(dest);
        const el = new Audio();
        el.srcObject = dest.stream;
        el.setAttribute('playsinline', '');
        await el.play();
        this.el = el;
      } catch (_) {
        this.master.connect(ctx.destination);
      }
      await resumed;
      this._buf = new Float32Array(this.analyser.fftSize);
    }

    resume() {
      if (!this.ctx) return;
      this.ctx.resume().catch(() => {});
      this.el?.play().catch(() => {});
    }

    // same generated IR as the simulators: mulberry32(1234) damped noise
    _ir() {
      const T = this.params.timbre, sr = this.ctx.sampleRate;
      const len = Math.max(1, Math.floor(T.reverb_decay_s * sr));
      const ir = this.ctx.createBuffer(2, len, sr);
      const rng = NR.mulberry32(1234);
      const dampA = 1 - Math.exp(-2 * Math.PI * T.reverb_damp_hz / sr);
      for (let ch = 0; ch < 2; ch++) {
        const data = ir.getChannelData(ch);
        let lp = 0;
        for (let i = 0; i < len; i++) {
          lp += ((rng() * 2 - 1) - lp) * dampA;
          data[i] = lp * Math.exp(-6.9 * i / len);
        }
      }
      return ir;
    }

    _voice(v, f0) {
      const ctx = this.ctx;
      const bus = new GainNode(ctx, { gain: 0 });
      const lfo = new OscillatorNode(ctx, { type: 'sine', frequency: 0.1 });
      const lfoGain = new GainNode(ctx, { gain: 0 });
      lfo.connect(lfoGain).connect(bus.gain);
      lfo.start();
      const oscs = [], pGains = [];
      for (let j = 0; j < 4; j++) {
        const o = new OscillatorNode(ctx, { type: 'sine', frequency: f0 * (j + 1) });
        const g = new GainNode(ctx, { gain: 0 });
        o.connect(g).connect(bus);
        o.start();
        oscs.push(o); pGains.push(g);
      }
      bus.connect(this.sum);
      const nodes = { bus, lfo, lfoGain, oscs, pGains, silentSince: null };
      this.voices.set(v, nodes);
      return nodes;
    }

    _drop(v, nodes) {
      for (const o of nodes.oscs) { try { o.stop(); } catch (_) {} }
      try { nodes.lfo.stop(); } catch (_) {}
      nodes.bus.disconnect();
      this.voices.delete(v);
    }

    // players: ring.playersAt(frame, slot); vol: state volume
    update(fr, players, vol) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const am = this.params.shimmer_am;
      setT(this.master.gain, vol, now, 0.6, 1e-3);
      const live = new Set();
      for (const p of players) {
        const vc = p.vc;
        live.add(p.v);
        const n = this.voices.get(p.v) || this._voice(p.v, vc.f0);
        n.silentSince = null;
        const pg = NR.partialGains(this.params, vc.role, vc.f0, vc.bloom, fr.ratios, fr.amps);
        for (let j = 0; j < 4; j++) {
          setT(n.oscs[j].frequency, vc.f0 * fr.ratios[j], now, 1.5, 0.01);
          setT(n.oscs[j].detune, p.detune, now, 0.08, 0.02);
          setT(n.pGains[j].gain, pg[j], now, 0.3, 1e-3);
        }
        const g = vc.level * p.g * 0.42;
        setT(n.bus.gain, g, now, 0.05, 1e-4);
        // rotation is this piece's wind: it drives the shimmer AM (spec §5.3)
        const roleP = this.params.roles[vc.role];
        const depth = fr.amDepth * (roleP.am_depth_scale ?? 1) * 0.5 * fr.factor;
        setT(n.lfo.frequency, (am.rate_base_hz + am.rate_motion_hz * 0.1 * fr.factor) * fr.comp, now, 0.2, 1e-3);
        setT(n.lfoGain.gain, depth * g, now, 0.2, 1e-4);
      }
      // voices that have moved on: fade, then free their oscillators
      for (const [v, n] of this.voices) {
        if (live.has(v)) continue;
        setT(n.bus.gain, 0, now, 0.05, 1e-4);
        setT(n.lfoGain.gain, 0, now, 0.05, 1e-4);
        if (n.silentSince === null) n.silentSince = now;
        else if (now - n.silentSince > 2) this._drop(v, n);
      }
      // output level for the screen
      this.analyser.getFloatTimeDomainData(this._buf);
      let s = 0;
      for (const x of this._buf) s += x * x;
      this.level = Math.sqrt(s / this._buf.length);
    }
  }

  root.NearfieldAudio = { RingAudio };
})(typeof globalThis !== 'undefined' ? globalThis : this);
