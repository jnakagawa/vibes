// Sound for the ring.
//
// BedSynth    the foundation: a deep octave stack for a real speaker in the
//             middle (and for the headphone monitor).
// PhoneSynth  what one ring position plays: the voices passing through it
//             (each a stack of 4 sine partials at this position's bend) and
//             its share of the air (band-passed noise, its own per phone).
// RingAudio   a real phone: one PhoneSynth through the ensemble's voicing
//             chain (shelf, lowpass, generated-IR reverb, compressor). The
//             room does the rest — beating, interference and movement happen
//             in the air between phones.
// RingMonitor the host's headphone monitor: every position's PhoneSynth
//             placed around the listener (HRTF) with the air's travel time,
//             so the piece can be composed without setting out phones.
(function (root) {
  'use strict';
  const NR = root.NearfieldRing;
  const C_AIR = 343;   // m/s

  // only touch an AudioParam when its target moved (keeps automation lists short)
  function setT(param, v, now, tau, eps) {
    if (param._last !== undefined && Math.abs(param._last - v) <= eps) return;
    param._last = v;
    param.setTargetAtTime(v, now, tau);
  }

  // softness 0..1 -> lowpass cutoff (6 kHz open .. 500 Hz dark), 24 dB / octave
  const softHz = s => 6000 * Math.pow(500 / 6000, NR.clamp(s ?? 0.6, 0, 1));

  // a few seconds of pink-ish noise, shared per context; each phone reads it
  // from its own random offset
  function noiseBuffer(ctx) {
    if (ctx._nfNoise) return ctx._nfNoise;
    const len = Math.floor(ctx.sampleRate * 7.3);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {   // Paul Kellet's economy pink filter
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.0990460;
      b1 = 0.96300 * b1 + w * 0.2965164;
      b2 = 0.57000 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
    }
    ctx._nfNoise = buf;
    return buf;
  }

  // same generated IR as the simulators: mulberry32(1234) damped noise
  function reverbIR(ctx, T) {
    const sr = ctx.sampleRate;
    const len = Math.max(1, Math.floor(T.reverb_decay_s * sr));
    const ir = ctx.createBuffer(2, len, sr);
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

  // shelf -> dry / reverb -> compressor -> master. (The darkening lowpass
  // lives in each PhoneSynth, so the glints can go round it.) `halo` is the
  // reverb's input, for sends that should be mostly tail.
  function voicingChain(ctx, T) {
    const sum = new GainNode(ctx, { gain: 1 });
    const shelf = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: T.shelf_freq_hz, gain: T.shelf_gain_db });
    const dry = new GainNode(ctx, { gain: Math.cos(T.reverb_wet * Math.PI / 2) });
    const wet = new GainNode(ctx, { gain: Math.sin(T.reverb_wet * Math.PI / 2) });
    const convolver = new ConvolverNode(ctx);
    convolver.buffer = reverbIR(ctx, T);
    const comp = new DynamicsCompressorNode(ctx, { threshold: -9, knee: 10, ratio: 2.5, attack: 0.02, release: 0.4 });   // gentle: quiet stays quiet
    const master = new GainNode(ctx, { gain: 0 });
    sum.connect(shelf);
    shelf.connect(dry).connect(comp);
    shelf.connect(convolver).connect(wet).connect(comp);
    comp.connect(master);
    return { sum, master, halo: convolver };
  }

  // iOS mutes plain Web Audio when the ring / silent switch is on. Two things
  // get round it: a "playback" audio session, and playing through an <audio>
  // element fed by a MediaStream, which makes the page a media player (it
  // also keeps sounding when the screen locks). Call both from a tap.
  function playbackSession() {
    if (navigator.audioSession) { try { navigator.audioSession.type = 'playback'; } catch (_) {} }
  }
  async function attachOutput(ctx, master) {
    let dest = null, el = null;
    try {
      dest = ctx.createMediaStreamDestination();
      master.connect(dest);
      el = new Audio();
      el.srcObject = dest.stream;
      el.setAttribute('playsinline', '');
      // if the element will not start, fall back rather than wait forever
      await Promise.race([el.play(), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 2500))]);
      return el;
    } catch (_) {
      try { if (el) { el.pause(); el.srcObject = null; } if (dest) master.disconnect(dest); } catch (_e) {}
      master.connect(ctx.destination);
      return null;
    }
  }

  class PhoneSynth {
    constructor(ctx, params, out, halo) {
      this.ctx = ctx;
      this.params = params;
      // body: tones + air through the darkening lowpass (24 dB / octave)
      this.body = new GainNode(ctx, { gain: 1 });
      this.lp1 = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: softHz(0.6), Q: 0.5 });
      this.lp2 = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: softHz(0.6), Q: 0.5 });
      this.body.connect(this.lp1).connect(this.lp2).connect(out);
      // glints: the faint high harmonics go round the lowpass, and mostly
      // into the reverb, so they hang in the air
      this.glint = new GainNode(ctx, { gain: 1 });
      this.glintHp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 900, Q: 0.5 });
      this.glint.connect(this.glintHp).connect(out);
      if (halo) { this.haloSend = new GainNode(ctx, { gain: 1.5 }); this.glintHp.connect(this.haloSend).connect(halo); }
      this.out = this.body;
      this.voices = new Map();   // v -> nodes
      this.air = null;
    }

    _voice(v, f0) {
      const ctx = this.ctx;
      const bus = new GainNode(ctx, { gain: 0 });
      const lfo = new OscillatorNode(ctx, { type: 'sine', frequency: 0.1 });
      const lfoGain = new GainNode(ctx, { gain: 0 });
      lfo.connect(lfoGain).connect(bus.gain);
      lfo.start();
      bus.connect(this.out);
      const nodes = { bus, lfo, lfoGain, sets: [], silentSince: null };
      this.voices.set(v, nodes);
      return nodes;
    }

    // one singer: four sine partials into the voice's bus
    _singer(nodes, f0) {
      const set = { oscs: [], pGains: [], glints: [] };
      for (let j = 0; j < 4; j++) {
        const o = new OscillatorNode(this.ctx, { type: 'sine', frequency: f0 * (j + 1) });
        const g = new GainNode(this.ctx, { gain: 0 });
        o.connect(g).connect(nodes.bus);
        o.start();
        set.oscs.push(o); set.pGains.push(g);
        if (j > 0) { const gl = new GainNode(this.ctx, { gain: 0 }); o.connect(gl).connect(this.glint); set.glints.push(gl); }
      }
      nodes.sets.push(set);
      return set;
    }

    _drop(v, nodes) {
      for (const set of nodes.sets) {
        for (const o of set.oscs) { try { o.stop(); } catch (_) {} }
        for (const gl of set.glints) gl.disconnect();
      }
      try { nodes.lfo.stop(); } catch (_) {}
      nodes.bus.disconnect();
      this.voices.delete(v);
    }

    _air() {
      const ctx = this.ctx, buf = noiseBuffer(ctx);
      const src = new AudioBufferSourceNode(ctx, { buffer: buf, loop: true });
      const band = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 500, Q: 2.5 });
      const gain = new GainNode(ctx, { gain: 0 });
      src.connect(band).connect(gain).connect(this.out);
      src.start(0, Math.random() * buf.duration);
      this.air = { src, band, gain };
      return this.air;
    }

    // players: ring.playersAt(frame, slot); air: ring.airAt(frame, slot) or null
    update(fr, players, air) {
      const now = this.ctx.currentTime;
      const am = this.params.shimmer_am;
      setT(this.lp1.frequency, softHz(fr.soft), now, 0.5, 5);
      setT(this.lp2.frequency, softHz(fr.soft), now, 0.5, 5);
      const live = new Set();
      for (const p of players) {
        const vc = p.vc;
        const g = vc.level * p.g * 0.42;
        if (g < 2e-4 && !this.voices.has(p.v)) continue;   // ebbed out: no oscillators
        live.add(p.v);
        const n = this.voices.get(p.v) || this._voice(p.v, vc.f0);
        n.silentSince = null;
        // each partial's level: the bloom's, shaped by this phone's vowel
        const base = NR.partialGains(this.params, vc.role, vc.f0, vc.bloom, fr.ratios, fr.amps);
        const pg = base.map((x, j) => x * (p.body ? p.body[j] : 1) + (p.open ? p.open[j] * fr.amps[j] : 0));
        const singers = p.singers || [{ g: 1, detunes: p.detunes }];
        for (let k = 0; k < Math.max(singers.length, n.sets.length); k++) {
          const sg = singers[k], set = n.sets[k] || this._singer(n, vc.f0);
          for (let j = 0; j < 4; j++) {
            if (sg) {
              setT(set.oscs[j].frequency, vc.f0 * fr.ratios[j], now, 1.5, 0.01);
              setT(set.oscs[j].detune, sg.detunes[j], now, 0.08, 0.002);
            }
            setT(set.pGains[j].gain, sg ? pg[j] * sg.g : 0, now, 0.3, 1e-3);
            // the glint taps the partial directly, so it carries the tone's level itself
            if (j > 0) setT(set.glints[j - 1].gain, sg && p.glints ? p.glints[j - 1] * sg.g * g : 0, now, 0.15, 1e-5);
          }
        }
        setT(n.bus.gain, g, now, 0.05, 1e-4);
        // rotation is this piece's wind: it drives the shimmer AM (spec §5.3)
        const roleP = this.params.roles[vc.role];
        const depth = fr.amDepth * (roleP.am_depth_scale ?? 1) * 0.5 * fr.factor;
        setT(n.lfo.frequency, (am.rate_base_hz + am.rate_motion_hz * 0.1 * fr.factor) * fr.comp, now, 0.2, 1e-3);
        setT(n.lfoGain.gain, depth * g, now, 0.2, 1e-4);
        if (g < 2e-4) live.delete(p.v);   // let a voice at low tide be freed
      }
      // voices that have moved on or ebbed: fade, then free their oscillators
      for (const [v, n] of this.voices) {
        if (live.has(v)) continue;
        setT(n.bus.gain, 0, now, 0.05, 1e-4);
        setT(n.lfoGain.gain, 0, now, 0.05, 1e-4);
        for (const set of n.sets) for (const gl of set.glints) setT(gl.gain, 0, now, 0.1, 1e-5);
        if (n.silentSince === null) n.silentSince = now;
        else if (now - n.silentSince > 2) this._drop(v, n);
      }
      const ag = air ? air.g : 0;
      if (ag > 1e-4 || this.air) {
        const a = this.air || this._air();
        if (air) {
          setT(a.band.frequency, air.freq, now, 0.4, 0.5);
          setT(a.band.Q, air.q, now, 0.4, 0.01);
        }
        setT(a.gain.gain, ag * AIR_GAIN, now, 0.25, 1e-4);
      }
    }

    dispose() {
      for (const [v, n] of [...this.voices]) this._drop(v, n);
      if (this.air) { try { this.air.src.stop(); } catch (_) {} this.air.gain.disconnect(); this.air = null; }
      this.lp2.disconnect(); this.glintHp.disconnect();
    }
  }
  // The foundation: each part is two sines a fraction of a hertz apart, so it
  // breathes; `trade` flips one of them toward one ear so some parts sway.
  class BedSynth {
    constructor(ctx, out) {
      this.ctx = ctx;
      this.gain = new GainNode(ctx, { gain: 0 });
      this.merge = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
      this.merge.connect(this.gain);
      this.gain.connect(out);
      this.parts = [];
    }
    update(bed) {
      const now = this.ctx.currentTime, ctx = this.ctx;
      if (!bed || (bed.lvl < 1e-4 && !this.parts.length)) return;
      bed.parts.forEach((p, i) => {
        let n = this.parts[i];
        if (!n) {
          // tone a goes to both ears; tone b goes to the left as is and to
          // the right scaled by (1 - 2 * trade) — flipped past 0.5 — so the
          // two ears swell in turn (kept under 1 so one speaker still beats)
          n = { a: new OscillatorNode(ctx, { type: 'sine', frequency: p.f }), b: new OscillatorNode(ctx, { type: 'sine', frequency: p.f }),
            ga: new GainNode(ctx, { gain: 0 }), gbl: new GainNode(ctx, { gain: 0 }), gbr: new GainNode(ctx, { gain: 0 }) };
          n.a.connect(n.ga); n.ga.connect(this.merge, 0, 0); n.ga.connect(this.merge, 0, 1);
          n.b.connect(n.gbl); n.b.connect(n.gbr); n.gbl.connect(this.merge, 0, 0); n.gbr.connect(this.merge, 0, 1);
          n.a.start(); n.b.start();
          this.parts[i] = n;
        }
        const unit = p.g / (1 + p.depth);
        setT(n.a.frequency, p.f - 0.5 * p.beat, now, 1.0, 1e-4);
        setT(n.b.frequency, p.f + 0.5 * p.beat, now, 1.0, 1e-4);
        setT(n.ga.gain, unit, now, 0.3, 1e-4);
        setT(n.gbl.gain, unit * p.depth, now, 0.3, 1e-4);
        setT(n.gbr.gain, unit * p.depth * (1 - 2 * p.trade), now, 0.3, 1e-4);
      });
      setT(this.gain.gain, bed.lvl * BED_GAIN, now, 0.4, 1e-4);
    }
    dispose() {
      for (const n of this.parts) { try { n.a.stop(); n.b.stop(); } catch (_) {} }
      this.gain.disconnect();
      this.parts = [];
    }
  }
  // set against the album's balance: the foundation carries most of the energy
  const BED_GAIN = 2.2;

  // with the air fader at 1 and the air fully swelled, the air around the ring
  // is about as loud as the whole chord (measured through the monitor)
  const AIR_GAIN = 3;

  class RingAudio {
    constructor(params) {
      this.params = params;
      this.ctx = null;
      this.level = 0;            // for the screen
    }

    // call from a tap (browser rule)
    async start() {
      playbackSession();
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
      this.ctx = ctx;
      const resumed = ctx.resume();
      this.chain = voicingChain(ctx, this.params.timbre);
      this.synth = new PhoneSynth(ctx, this.params, this.chain.sum, this.chain.halo);
      // only sounds on the device in the middle; trimmed so its stack of
      // tones stays under full scale on one speaker
      this.bedTrim = new GainNode(ctx, { gain: 0.2 });
      this.bedTrim.connect(this.chain.sum);
      this.bed = new BedSynth(ctx, this.bedTrim);
      this.analyser = new AnalyserNode(ctx, { fftSize: 512 });
      this.chain.master.connect(this.analyser);
      this.el = await attachOutput(ctx, this.chain.master);
      await resumed;
      this._buf = new Float32Array(this.analyser.fftSize);
    }

    resume() {
      if (!this.ctx) return;
      this.ctx.resume().catch(() => {});
      this.el?.play().catch(() => {});
    }

    update(fr, players, vol, air, bed) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      setT(this.chain.master.gain, vol, now, 0.6, 1e-3);
      this.synth.update(fr, players, air || null);
      this.bed.update(bed || SILENT_BED);
      this.analyser.getFloatTimeDomainData(this._buf);
      let s = 0;
      for (const x of this._buf) s += x * x;
      this.level = Math.sqrt(s / this._buf.length);
    }
  }

  const SILENT_BED = { lvl: 0, parts: [] };

  class RingMonitor {
    constructor(params) {
      this.params = params;
      this.ctx = null;
      this.slots = [];
      this.S = 0;
      this.level = 0;
      this.listener = { x: 0, z: 1.6 };
    }

    // call from a tap
    async start() {
      playbackSession();
      const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
      this.ctx = ctx;
      const resumed = ctx.resume();
      this.chain = voicingChain(ctx, this.params.timbre);
      this.analyser = new AnalyserNode(ctx, { fftSize: 512 });
      this.chain.master.connect(this.analyser);
      this._buf = new Float32Array(this.analyser.fftSize);
      this.el = await attachOutput(ctx, this.chain.master);
      await Promise.race([resumed, new Promise(res => setTimeout(res, 2500))]);
    }

    resume() {
      if (!this.ctx) return;
      this.ctx.resume().catch(() => {});
      this.el?.play().catch(() => {});
    }

    async stop() {
      this._dispose();
      const ctx = this.ctx;
      this.ctx = null;
      if (this.el) { try { this.el.pause(); this.el.srcObject = null; } catch (_) {} this.el = null; }
      if (ctx) await ctx.close().catch(() => {});
    }

    _dispose() {
      if (this.bed) { this.bed.dispose(); this.bed = null; this.bedBus.disconnect(); }
      for (const s of this.slots) { s.synth.dispose(); s.panner.disconnect(); }
      this.slots = [];
      this.S = 0;
    }

    // one synth per ring position plus one in the middle (the pedestal):
    // synth -> travel-time delay -> HRTF panner at the phone's spot
    _build(S) {
      this._dispose();
      const ctx = this.ctx;
      for (let k = 0; k <= S; k++) {
        const input = new GainNode(ctx, { gain: 1 });
        const delay = new DelayNode(ctx, { maxDelayTime: 0.1, delayTime: 0 });
        const panner = new PannerNode(ctx, {
          panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 0.5, maxDistance: 50, rolloffFactor: 1,
        });
        input.connect(delay).connect(panner).connect(this.chain.sum);
        this.slots.push({ slot: k < S ? k : 'pedestal', delay, panner, synth: new PhoneSynth(ctx, this.params, input, this.chain.halo) });
      }
      // the foundation comes from the speaker in the middle; low tones have
      // no direction, so it goes straight to both ears
      this.bedBus = new GainNode(ctx, { gain: 1 });
      this.bedBus.connect(this.chain.sum);
      this.bed = new BedSynth(ctx, this.bedBus);
      this.S = S;
    }

    // opts: { vol, diameter (m), listen: 'outside' | 'center' | 'walk', dist (m) }
    update(ring, fr, opts) {
      if (!this.ctx) return;
      const st = ring.state, now = this.ctx.currentTime;
      if (st.S !== this.S) this._build(st.S);
      const phoneH = 0.9, earH = opts.listen === 'center' ? 1.2 : 1.6;
      const R = opts.diameter / 2;

      // where you are (room x / z, the ring's center at the origin)
      let lx = 0, lz = 0, fx = 0, fz = -1;
      if (opts.listen !== 'center') {
        const a = opts.listen === 'walk' ? Math.PI / 2 + 2 * Math.PI * (performance.now() / 1000) / 45 : Math.PI / 2;
        lx = opts.dist * Math.cos(a); lz = opts.dist * Math.sin(a);
        fx = -Math.cos(a); fz = -Math.sin(a);   // facing the ring
      }
      this.listener = { x: lx, z: lz };
      const l = this.ctx.listener;
      if (l.positionX) {
        setT(l.positionX, lx, now, 0.05, 1e-3); setT(l.positionY, earH, now, 0.05, 1e-3); setT(l.positionZ, lz, now, 0.05, 1e-3);
        setT(l.forwardX, fx, now, 0.05, 1e-3); setT(l.forwardY, 0, now, 0.05, 1e-3); setT(l.forwardZ, fz, now, 0.05, 1e-3);
        l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
      } else {
        l.setPosition(lx, earH, lz);
        l.setOrientation(fx, 0, fz, 0, 1, 0);
      }

      for (const s of this.slots) {
        let x = 0, z = 0;
        if (s.slot !== 'pedestal') {
          const a = -Math.PI / 2 + 2 * Math.PI * s.slot / st.S;
          x = R * Math.cos(a); z = R * Math.sin(a);
        }
        setT(s.panner.positionX, x, now, 0.05, 1e-3);
        setT(s.panner.positionY, phoneH, now, 0.05, 1e-3);
        setT(s.panner.positionZ, z, now, 0.05, 1e-3);
        const d = Math.hypot(x - lx, z - lz, phoneH - earH);
        setT(s.delay.delayTime, Math.min(0.1, d / C_AIR), now, 0.05, 2e-5);
        // the glints' reverb send does not pass the panner, so give it the
        // same fall-off with distance by hand
        if (s.synth.haloSend) setT(s.synth.haloSend.gain, 1.5 * 0.5 / Math.max(d, 0.5), now, 0.1, 1e-3);
        // the middle only sounds when the piece has a pedestal device
        const hasAir = s.slot !== 'pedestal' || st.anchors === 'pedestal';
        s.synth.update(fr, ring.playersAt(fr, s.slot), hasAir ? ring.airAt(fr, s.slot) : null);
      }
      // quieter with distance, like the phones
      const dBed = Math.max(0.5, Math.hypot(lx, lz, phoneH - earH));
      setT(this.bedBus.gain, 0.5 / dBed, now, 0.1, 1e-3);
      this.bed.update(fr.bed);
      setT(this.chain.master.gain, opts.vol * st.vol * 0.6, now, 0.3, 1e-3);
      this.analyser.getFloatTimeDomainData(this._buf);
      let sum = 0;
      for (const v of this._buf) sum += v * v;
      this.level = Math.sqrt(sum / this._buf.length);
    }
  }

  root.NearfieldAudio = { RingAudio, RingMonitor, PhoneSynth };
})(typeof globalThis !== 'undefined' ? globalThis : this);
