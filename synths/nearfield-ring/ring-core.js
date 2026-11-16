// ============================================================================
// Nearfield — the ring, as a web piece. Pure logic (no DOM, no audio):
// loaded by play.html / host.html and by test/ring-core.test.mjs under node.
//
// Every phone computes the whole piece itself from the shared performance
// state + its clock, so there is no server: phones that join late land in
// the same place, and a phone that drops out loses nothing. Anything that
// evolves over time is either a pure function of time (fingerprints, score
// curves) or is integrated in fixed 50 ms steps from a shared segment
// {t0, turns0, rate0, phase0} (rotation, breath), so every device gets the
// same numbers however often it looks.
//
// Musical model = the ring simulator in nearfield-ios (simulator/ring.html):
// tuning, roles, ombak, aging scale and the 16-minute score are the ensemble
// piece's (config/*.json copied from nearfield-ios); the chord rotates around
// the ring by equal-power handoffs, and each position bends what it plays so
// a voice beats against itself mid-handoff.
//
// On top of that sit slow cycles that never quite line up: each layer
// (anchors, tones, shimmer, air) turns at its own speed and width; every tone
// swells in and out on its own tide; soft noise circles as air.
// ============================================================================
(function (root) {
  'use strict';

  const STEP_MS = 50;                 // integration grid for rotation + breath
  const BUKA_FADE_S = 3;              // a voice's entry fade
  const GONG_S = 20;                  // section / final gong swell length
  const SCORE_LEAD_MS = 4000;         // a score starts this long after "start"

  // --- small math ------------------------------------------------------------------

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
  function smoothstep(x) { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); }
  function wrap(x, m) { return ((x % m) + m) % m; }

  function pitchHzFor(scale, degreeIndex, register) {
    return scale.base_freq_hz *
      Math.pow(scale.pseudo_octave_ratio, register) *
      Math.pow(2, scale.scale_cents[degreeIndex] / 1200);
  }

  // same as the simulator's assignRoles (spec §6.1): anchors 1-in-8,
  // shimmer 1-in-6, degree cycles with the index — here the index is the
  // ring position, so each marked position *is* a voice
  function assignRoles(n, scale, params) {
    const out = [];
    let anchors = 0, shimmers = 0;
    const anchorEvery = params.roles.anchor.share_one_in;
    const shimmerEvery = params.roles.shimmer.share_one_in;
    for (let i = 0; i < n; i++) {
      let role = 'voice';
      if (anchors < Math.ceil((i + 1) / anchorEvery)) { role = 'anchor'; anchors++; }
      else if (shimmers < Math.ceil((i + 1) / shimmerEvery)) { role = 'shimmer'; shimmers++; }
      out.push({ role, degreeIndex: i % scale.scale_cents.length, register: scale.registers[role] });
    }
    return out;
  }

  // Ombak (spec §13.3): beat rate ~ f * cents, so cents scale by ref/f to keep
  // the wave even across registers.
  function ombakScale(fHz, params, on) {
    if (!on) return 1;
    return clamp(params.drift.ombak_ref_hz / fHz, 0.25, 3);
  }

  // A voice's color: hue from where its pitch sits inside the (stretched)
  // pseudo-octave, so equal pitches share a color and the four scale degrees
  // land on amber / cyan / indigo / magenta; lightness from the role.
  // Returns linear-ish sRGB in 0..1.
  // thin lines on black: saturated enough to read as color, never neon
  const ROLE_LIGHT = { anchor: [0.72, 0.58], voice: [0.7, 0.66], shimmer: [0.6, 0.78] };   // [sat, light]
  function voiceColor(f0, role, baseHz, pseudoRatio) {
    const pc = wrap(Math.log2(f0 / baseHz), Math.log2(pseudoRatio)) / Math.log2(pseudoRatio);
    const h = wrap(40 + 360 * pc, 360) / 360;
    const [s, l] = ROLE_LIGHT[role] || ROLE_LIGHT.voice;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const ch = t => {
      t = wrap(t, 1);
      return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    };
    return [ch(h + 1 / 3), ch(h), ch(h - 1 / 3)];
  }

  // Interpolate the drifting scale between precomputed sweep rows (§13.1).
  function interpolateScale(drift, stretch) {
    const rows = drift.rows;
    if (stretch <= rows[0].stretch) return rows[0];
    for (let i = 1; i < rows.length; i++) {
      if (stretch <= rows[i].stretch) {
        const a = rows[i - 1], b = rows[i];
        const f = (stretch - a.stretch) / (b.stretch - a.stretch);
        const lerpArr = (x, y) => x.map((v, k) => v + (y[k] - v) * f);
        return {
          stretch,
          spectrum: { ratios: lerpArr(a.spectrum.ratios, b.spectrum.ratios), amps: a.spectrum.amps },
          scale_cents: lerpArr(a.scale_cents, b.scale_cents),
        };
      }
    }
    return rows[rows.length - 1];
  }

  // Score keyframes (spec §12): each path's mentions form a piecewise-linear
  // curve, held flat before the first and after the last mention.
  class Score {
    constructor(score) {
      this.score = score;
      this.duration = score.duration_s;
      this.curves = new Map();
      for (const kf of score.keyframes) {
        for (const [path, v] of Object.entries(kf.patch)) {
          if (!this.curves.has(path)) this.curves.set(path, []);
          this.curves.get(path).push([kf.at_s, v]);
        }
      }
      for (const pts of this.curves.values()) pts.sort((a, b) => a[0] - b[0]);
      this.events = [...score.events].sort((a, b) => a.at_s - b.at_s);
      this.sections = score.keyframes.map(k => ({ label: k.label, at: k.at_s }));
    }
    valueAt(path, t, dflt) {
      const pts = this.curves.get(path);
      if (!pts) return dflt;
      if (t <= pts[0][0]) return pts[0][1];
      for (let i = 1; i < pts.length; i++) {
        if (t <= pts[i][0]) {
          const [t0, v0] = pts[i - 1], [t1, v1] = pts[i];
          return v0 + (v1 - v0) * (t - t0) / (t1 - t0);
        }
      }
      return pts[pts.length - 1][1];
    }
    labelAt(t) {
      let label = this.sections[0].label;
      for (const s of this.sections) if (t >= s.at) label = s.label;
      return label;
    }
    lastEventAt(t) {
      let at = -Infinity;
      for (const e of this.events) if (e.at_s <= t) at = e.at_s;
      return at;
    }
  }

  // --- the performance state (shared by link + live relay) ------------------------

  function defaultState(now) {
    return {
      v: 1, rev: 1,
      epoch: now,                    // fingerprint + bend seed time origin
      seed: String(now % 1000000),   // performance seed
      S: 8,                          // marked positions on the ring
      // ct = composed seconds elapsed (tides + air run on it); lt = turns per
      // layer [anchor, voice, shimmer, air]
      seg: { t0: now, turns0: 0, rate0: 0, phase0: 0, ct0: 0, lt0: [0, 0, 0, 0] },
      score: null,                   // { start: ms, comp } while a score is on
      dir: 1,                        // 1 clockwise, -1 counter, 0 stopped
      lock: 1,                       // one turn per breath
      period: 60,                    // seconds per turn when not locked
      breath: 60,                    // breath period outside the score
      // layers: [level, width in positions, 1 with / -1 against the rotation]
      L: { anchor: [1, 1.5, 1], voice: [1, 1.5, 1], shimmer: [1, 1.25, -1] },
      air: [0.35, -1],               // [level, with / against]
      ratios: 'nested',              // layer cycle ratios: nested 1:2:4 | prime 5:7:11
      drift: 0.6,                    // 0 = every cycle together .. 1 = fully apart
      density: 0.6,                  // share of the chord sounding at once (tides)
      tide: 50,                      // a voice's swell cycle, seconds
      soft: 0.5,                     // darker + slower edges
      beat: 1,                       // scales fingerprint + handoff bend
      bend: 10,                      // ± cents a position bends at a turn/min
      bloom: 0.5,                    // partial richness (phones like partials)
      fp: 12,                        // fingerprint max cents
      ombak: 1,
      anchors: 'lift',               // lift | phones | pedestal
      vol: 1,
    };
  }

  // fill in whatever an older link or saved state lacks (pre-cycles states
  // rotated every layer together: their layers start from the shared turns)
  function normalizeState(st) {
    const d = defaultState(st.epoch || 0);
    const out = { ...d, ...st };
    out.L = { ...d.L, ...(st.L || {}) };
    const t = st.seg.turns0 || 0;
    out.seg = { ct0: 0, lt0: [t, t, t, t], ...st.seg };
    return out;
  }

  const LAYER_INDEX = { anchor: 0, voice: 1, shimmer: 2, air: 3 };
  const RATIOS = { nested: [0.5, 1, 2, 0.25], prime: [5 / 7, 1, 11 / 7, 3 / 7] };

  // signed speed of each layer relative to the base rotation
  function layerSpeeds(st) {
    const r = RATIOS[st.ratios] || RATIOS.nested;
    const dirs = [st.L.anchor[2], st.L.voice[2], st.L.shimmer[2], st.air[1]];
    return r.map((x, i) => Math.pow(x, st.drift) * (dirs[i] < 0 ? -1 : 1));
  }

  // base64url JSON — compact enough for a QR code
  // (settings still at their defaults are left out; normalizeState restores them)
  function encodeState(st) {
    const d = defaultState(st.epoch || 0), lean = {};
    for (const k of Object.keys(st)) {
      if (k === 'v' || k === 'rev' || k === 'epoch' || k === 'seg' || JSON.stringify(st[k]) !== JSON.stringify(d[k])) lean[k] = st[k];
    }
    const s = JSON.stringify(lean);
    const b64 = typeof btoa === 'function'
      ? btoa(unescape(encodeURIComponent(s)))
      : Buffer.from(s, 'utf8').toString('base64');
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decodeState(str) {
    try {
      const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
      const s = typeof atob === 'function'
        ? decodeURIComponent(escape(atob(b64)))
        : Buffer.from(b64, 'base64').toString('utf8');
      const st = JSON.parse(s);
      return st && st.v === 1 && st.seg ? st : null;
    } catch (_) { return null; }
  }

  // --- the piece -------------------------------------------------------------------

  class Ring {
    constructor(cfg) {
      this.scale = cfg.scale;
      this.params = cfg.params;
      this.drift = cfg.drift || null;
      this.score = new Score(cfg.score);
      this.state = null;
      this.integ = null;
    }

    // returns the normalized state (callers keep that one)
    setState(raw) {
      const st = normalizeState(raw);
      const segChanged = !this.state || JSON.stringify(st.seg) !== JSON.stringify(this.state.seg);
      this.state = st;
      if (segChanged) {
        this.integ = { t: st.seg.t0, turns: st.seg.turns0, rate: st.seg.rate0, phase: st.seg.phase0,
          ct: st.seg.ct0, lt: st.seg.lt0.slice() };
      }
      this.speeds = layerSpeeds(st);
      this.voices = this._voices(st.S);
      return st;
    }

    _voices(S) {
      const st = this.state;
      return assignRoles(S, this.scale, this.params).map((a, v) => {
        let register = a.register;
        if (a.role === 'anchor' && st.anchors === 'lift') register = a.register + 1;
        return { v, role: a.role, degreeIndex: a.degreeIndex, register };
      });
    }

    // score time (s) at absolute ms, or null when no score is on
    scoreTime(tMs) {
      const sc = this.state.score;
      return sc ? (tMs - sc.start) / 1000 * (sc.comp || 1) : null;
    }

    // composed curves at a moment: the score's when one is on, else the
    // free ring's (state values)
    curves(tMs) {
      const st = this.state, sT = this.scoreTime(tMs);
      if (sT === null) {
        return { sT: null, comp: 1, breath: st.breath, bloomM: 1, masterM: 1, fpAmp: 1, amDepth: this.params.shimmer_am.depth_wind, stretch: null };
      }
      const t = clamp(sT, 0, this.score.duration);
      const d = this.params.drift;
      return {
        sT,
        comp: st.score.comp || 1,
        breath: this.score.valueAt('breath.period_s', t, st.breath),
        bloomM: sT < 0 ? 0 : this.score.valueAt('bloom_multiplier', t, 1),
        // pre-roll: the ring falls silent before the buka begins
        masterM: sT < 0 ? 0 : this.score.valueAt('master_multiplier', t, 1),
        fpAmp: this.score.valueAt('drift.fingerprint_amplitude', t, 1),
        amDepth: this.score.valueAt('shimmer_am.depth_wind', t, this.params.shimmer_am.depth_wind),
        stretch: d.global_stretch_from + (d.global_stretch_to - d.global_stretch_from) * clamp(t / d.global_stretch_end_s, 0, 1),
      };
    }

    _stepOnce() {
      const I = this.integ, st = this.state;
      const c = this.curves(I.t);
      const dtM = STEP_MS / 1000 * c.comp;
      const period = st.lock ? c.breath : st.period;
      const target = st.dir === 0 ? 0 : (st.dir / period) * c.bloomM;
      I.rate += (target - I.rate) * Math.min(1, dtM / 3);   // ease speed changes
      I.turns += I.rate * dtM;
      for (let i = 0; i < 4; i++) I.lt[i] += I.rate * this.speeds[i] * dtM;
      I.ct += dtM;
      I.phase = wrap(I.phase + 2 * Math.PI * dtM / c.breath, 2 * Math.PI);
      I.t += STEP_MS;
    }

    // advance the shared integrator to tMs on the fixed grid; returns the
    // values at tMs (the sub-step remainder is extrapolated, never stored)
    advance(tMs) {
      const I = this.integ;
      if (tMs < I.t) return { turns: I.turns, rate: I.rate, phase: I.phase, ct: I.ct, lt: I.lt.slice() };
      let guard = 0;
      while (I.t + STEP_MS <= tMs && guard++ < 2e6) this._stepOnce();
      const c = this.curves(I.t);
      const r = (tMs - I.t) / 1000 * c.comp;
      return {
        turns: I.turns + I.rate * r,
        rate: I.rate,
        phase: wrap(I.phase + 2 * Math.PI * r / c.breath, 2 * Math.PI),
        ct: I.ct + r,
        lt: I.lt.map((x, i) => x + I.rate * this.speeds[i] * r),
      };
    }

    // a new segment that continues exactly where this one is (host publishes
    // it with every settings change, so nobody's rotation jumps)
    segmentAt(tMs) {
      this.advance(tMs);
      const I = this.integ;
      // rounded so the link stays short enough for an easy QR code; everyone
      // (the host included) continues from these same rounded numbers
      const r = (x, d) => Math.round(x * d) / d;
      return { t0: I.t, turns0: r(I.turns, 1e6), rate0: r(I.rate, 1e9), phase0: r(I.phase, 1e6),
        ct0: r(I.ct, 1e3), lt0: I.lt.map(x => r(x, 1e6)) };
    }

    // Tide (0..1): each voice swells in and out on its own slow cycle, so only
    // part of the chord sounds at once. density = the share of a cycle a voice
    // is up; drift spreads the voices' periods and phases apart; soft widens
    // the fade. A pure function of composed time, so every phone agrees.
    tide(v, ct) {
      const st = this.state;
      const r = mulberry32(fnv1a(`${v}|${st.seed}|tide`));
      const period = Math.max(4, st.tide * (1 + st.drift * (r() - 0.5) * 1.2));
      const phase = 2 * Math.PI * r() * Math.min(1, st.drift / 0.2);
      const w = 0.35 + 0.95 * st.soft;
      return smoothstep((Math.cos(2 * Math.PI * ct / period + phase) - this._tideThreshold(st.density, w)) / w + 0.5);
    }

    // the threshold at which a tide's average over its cycle equals density
    _tideThreshold(density, w) {
      const key = `${density}|${w}`;
      if (this._thrKey === key) return this._thr;
      const D = clamp(density, 0, 1), N = 256;
      const mean = thr => {
        let s = 0;
        for (let i = 0; i < N; i++) s += smoothstep((Math.cos(Math.PI * (i + 0.5) / N) - thr) / w + 0.5);
        return s / N;
      };
      let lo = -1 - w, hi = 1 + w;   // mean(lo) = 1, mean(hi) = 0
      if (D >= 1) hi = lo; else if (D <= 0) lo = hi;
      else for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (mean(mid) > D) lo = mid; else hi = mid; }
      this._thrKey = key;
      this._thr = (lo + hi) / 2;
      return this._thr;
    }

    // Deterministic per-voice fingerprint (§13.2 stand-in): three slow
    // sinusoids seeded by voice + performance, ~max/3 std, clamped to ±max.
    // The ensemble's OU walk depends on each device's step sequence; this
    // gives every phone the same value for the same voice at the same time.
    fingerprint(v, role, f0, tMs, amp) {
      const st = this.state;
      const r = mulberry32(fnv1a(`${v}|${st.seed}|fp`));
      const ts = (tMs - st.epoch) / 1000;
      let x = 0;
      for (let i = 0; i < 3; i++) {
        const per = 60 + r() * 140;
        x += Math.sin(2 * Math.PI * ts / per + r() * 2 * Math.PI);
      }
      const mult = this.params.drift.role_multipliers[role] ?? 1;
      const max = st.fp * st.beat * mult * ombakScale(f0, this.params, st.ombak);
      return clamp((x / 3) * max * 0.82, -max, max) * amp;   // std ≈ max/3
    }

    // a position's fixed bend direction, in [-1, 1]
    positionOffset(slot) {
      return mulberry32(fnv1a(`${slot}|${this.state.seed}|position`))() * 2 - 1;
    }

    // Everything at one moment: every voice's pitch, level and where it
    // sounds (shares per ring position). Phones use their own slot's shares;
    // the host draws them all.
    frame(tMs) {
      const st = this.state, S = st.S;
      const c = this.curves(tMs);
      const adv = this.advance(tMs);
      const { turns, rate, phase } = adv;
      const scaleNow = c.stretch !== null && this.drift
        ? interpolateScale(this.drift, c.stretch)
        : { scale_cents: this.scale.scale_cents, spectrum: this.scale.spectrum, stretch: this.scale.pseudo_octave_ratio };
      const es = {
        base_freq_hz: this.scale.base_freq_hz,
        pseudo_octave_ratio: scaleNow.stretch ?? scaleNow.spectrum.ratios[1],
        scale_cents: scaleNow.scale_cents,
      };
      const factor = clamp(Math.abs(rate) * 60, 0, 1.5);   // 1 = a turn a minute
      const breathG = 1 + this.params.breath.ensemble_depth * Math.sin(phase);
      const gongAge = c.sT === null ? Infinity : c.sT - this.score.lastEventAt(c.sT);
      const gongOn = gongAge >= 0 && gongAge < GONG_S;
      const bukaLen = this.score.sections[1]?.at ?? 120;
      const nonAnchors = this.voices.filter(x => x.role !== 'anchor');
      const anchors = this.voices.filter(x => x.role === 'anchor');
      // each layer: its own width (a voice as a cloud over several phones)
      const widths = {}, peaks = {};
      for (const role of ['anchor', 'voice', 'shimmer']) {
        widths[role] = clamp(st.L[role][1], 1, Math.max(1, S / 2));
        peaks[role] = Math.max(...windowShares(0, widths[role]).map(s => s[1]));
      }

      const voices = this.voices.map(vc => {
        const roleP = this.params.roles[vc.role];
        const w = widths[vc.role];
        const f0 = pitchHzFor(es, vc.degreeIndex, vc.register);
        // entries (buka): anchors first, then voices one by one around the ring
        let entry = 1;
        if (c.sT !== null && vc.role !== 'anchor') {
          const idx = nonAnchors.indexOf(vc);
          const at = (idx + 1) * bukaLen / (nonAnchors.length + 1);
          entry = smoothstep((c.sT - at) / BUKA_FADE_S);
        }
        let env = 1;
        if (vc.role === 'anchor') {
          const ai = anchors.indexOf(vc);
          env = gongOn ? Math.sin(Math.PI * gongAge / GONG_S)
            : 0.5 + 0.5 * Math.sin(phase + 2 * Math.PI * ai / Math.max(anchors.length, 1));
        }
        // anchors already come and go on the breath; the others ride tides
        const tide = vc.role === 'anchor' ? 1 : this.tide(vc.v, adv.ct);
        const level = roleP.base_gain * env * breathG * entry * c.masterM * tide * st.L[vc.role][0];
        const posU = vc.v + adv.lt[LAYER_INDEX[vc.role]] * S;
        const shares = windowShares(posU, w).map(([iU, g]) => ({ slot: wrap(iU, S), g }));
        return {
          v: vc.v, role: vc.role, f0, level, tide, posU, pos: wrap(posU, S), shares, peak: peaks[vc.role],
          color: voiceColor(f0, vc.role, this.scale.base_freq_hz, es.pseudo_octave_ratio),
          fp: this.fingerprint(vc.v, vc.role, f0, tMs, c.fpAmp),
          bloom: vc.role === 'anchor' ? 0.35 : st.bloom * c.bloomM,
        };
      });

      // Air: soft noise, each phone its own. It circles the ring on its own
      // cycle (against the rotation by default), swells with the breath and a
      // longer tide, and its tone wanders note to note across the scale —
      // dwelling on each pitch, then gliding to the next.
      const notes = [0, 1].flatMap(reg => es.scale_cents.map((_, d) => pitchHzFor(es, d, reg)));
      const path = notes.concat(notes.slice(1, -1).reverse());
      const x = adv.ct / Math.max(6, st.tide * 0.45);
      const i = Math.floor(x), glide = smoothstep((x - i - 0.25) / 0.5);
      const fa = path[wrap(i, path.length)], fb = path[wrap(i + 1, path.length)];
      const long = 0.5 + 0.5 * Math.sin(2 * Math.PI * adv.ct / (st.tide * 2.3) + (fnv1a(`${st.seed}|air`) % 628) / 100);
      const swell = 0.5 + 0.5 * Math.sin(phase + 2.1);
      const air = {
        lvl: st.air[0] * c.masterM * (0.1 + 0.9 * swell * (0.35 + 0.65 * long)),
        pos: wrap(adv.lt[3] * S, S),
        freq: fa * Math.pow(fb / fa, glide),
        q: 2.5,
      };

      const absRate = Math.abs(rate);
      return {
        tMs, sT: c.sT, label: c.sT === null ? null : (c.sT < 0 ? 'pre-roll' : (c.sT > this.score.duration ? 'end' : this.score.labelAt(c.sT))),
        comp: c.comp, turns, rate, factor, phase, stretch: c.stretch, amDepth: c.amDepth, fpAmp: c.fpAmp,
        ratios: scaleNow.spectrum.ratios, amps: this.scale.spectrum.amps,
        ct: adv.ct, lt: adv.lt, soft: st.soft, air,
        // seconds per turn of each layer [anchor, voice, shimmer, air] (signed)
        periods: this.speeds.map(s => absRate < 1e-5 ? Infinity : 1 / (rate * s)),
        voices,
      };
    }

    // the air's gain + tone at one position
    airAt(fr, slot) {
      const a = fr.air, S = this.state.S;
      if (slot === 'pedestal') return { g: a.lvl * 0.5, freq: a.freq, q: a.q };
      const sw = Math.max(1.5, S / 3), floor = 0.15;
      let d = Math.abs(slot - a.pos); d = Math.min(d, S - d);
      const lift = d < sw ? Math.pow(Math.cos(Math.PI * d / (2 * sw)), 2) : 0;
      return { g: a.lvl * (floor + (1 - floor) * lift), freq: a.freq, q: a.q };
    }

    // What one position plays: each voice with a share here, its gain and its
    // detune (fingerprint + this position's handoff bend, fading as the voice
    // arrives). slot = 'pedestal' plays the anchors in the middle.
    playersAt(fr, slot) {
      const st = this.state;
      const out = [];
      for (const vc of fr.voices) {
        if (slot === 'pedestal') {
          if (vc.role === 'anchor' && st.anchors === 'pedestal') out.push({ v: vc.v, vc, g: 1, detune: vc.fp });
          continue;
        }
        if (vc.role === 'anchor' && st.anchors === 'pedestal') continue;
        let g = 0;
        for (const s of vc.shares) if (s.slot === slot) g += s.g;
        if (g <= 1e-4) continue;
        // the bend fades as the voice centers on this position (relative to
        // the peak share its width allows)
        const tension = st.bend * st.beat * ombakScale(vc.f0, this.params, st.ombak) * fr.factor;
        const g1 = Math.min(1, g / vc.peak);
        out.push({ v: vc.v, vc, g, detune: vc.fp + this.positionOffset(slot) * tension * (1 - g1 * g1) });
      }
      return out;
    }
  }

  // Window over unwrapped ring indices: cos(pi*d/2w) inside width w,
  // normalized to unit power — w = 1 is an equal-power handoff between two
  // neighbors.
  function windowShares(posU, w) {
    const out = [];
    let norm = 0;
    for (let i = Math.floor(posU - w); i <= Math.ceil(posU + w); i++) {
      const d = Math.abs(i - posU);
      if (d >= w) continue;
      const g = Math.cos(Math.PI * d / (2 * w));
      norm += g * g;
      out.push([i, g]);
    }
    norm = Math.sqrt(norm) || 1;
    for (const o of out) o[1] /= norm;
    return out;
  }

  // partial gains for a voice at bloom B (spec §5.3), with the equal-loudness tilt
  function partialGains(params, role, f0, B, ratios, amps) {
    const roleP = params.roles[role];
    const th = params.bloom.partial_thresholds, tw = params.bloom.threshold_width;
    const T = params.timbre;
    return [0, 1, 2, 3].map(j => {
      const f = f0 * ratios[j];
      const tilt = Math.min(1, Math.pow(T.loudness_ref_hz / f, T.loudness_exponent));
      const on = j === 0 ? 1 : (j < roleP.max_partials ? smoothstep((B - th[j - 1]) / tw) : 0);
      return amps[j] * on * tilt;
    });
  }

  const api = {
    STEP_MS, SCORE_LEAD_MS,
    mulberry32, fnv1a, clamp, wrap, smoothstep, pitchHzFor, assignRoles, ombakScale, voiceColor,
    interpolateScale, Score, Ring, windowShares, partialGains,
    defaultState, normalizeState, layerSpeeds, encodeState, decodeState,
  };
  root.NearfieldRing = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
