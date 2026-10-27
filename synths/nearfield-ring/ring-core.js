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
      seg: { t0: now, turns0: 0, rate0: 0, phase0: 0 },
      score: null,                   // { start: ms, comp } while a score is on
      mode: 'chord',                 // chord | counter | sweep
      dir: 1,                        // 1 clockwise, -1 counter, 0 stopped
      lock: 1,                       // one turn per breath
      period: 60,                    // seconds per turn when not locked
      breath: 60,                    // breath period outside the score
      w: 1,                          // handoff width (1..2)
      bend: 10,                      // ± cents a position bends at a turn/min
      bloom: 0.5,                    // partial richness (phones like partials)
      fp: 12,                        // fingerprint max cents
      ombak: 1,
      anchors: 'lift',               // lift | phones | pedestal
      vol: 1,
    };
  }

  // base64url JSON — compact enough for a QR code
  function encodeState(st) {
    const s = JSON.stringify(st);
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

    setState(st) {
      const segChanged = !this.state || JSON.stringify(st.seg) !== JSON.stringify(this.state.seg);
      this.state = st;
      if (segChanged) this.integ = { t: st.seg.t0, turns: st.seg.turns0, rate: st.seg.rate0, phase: st.seg.phase0 };
      this.voices = this._voices(st.S);
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
      I.phase = wrap(I.phase + 2 * Math.PI * dtM / c.breath, 2 * Math.PI);
      I.t += STEP_MS;
    }

    // advance the shared integrator to tMs on the fixed grid; returns the
    // values at tMs (the sub-step remainder is extrapolated, never stored)
    advance(tMs) {
      const I = this.integ;
      if (tMs < I.t) return { turns: I.turns, rate: I.rate, phase: I.phase };
      let guard = 0;
      while (I.t + STEP_MS <= tMs && guard++ < 2e6) this._stepOnce();
      const c = this.curves(I.t);
      const r = (tMs - I.t) / 1000 * c.comp;
      return {
        turns: I.turns + I.rate * r,
        rate: I.rate,
        phase: wrap(I.phase + 2 * Math.PI * r / c.breath, 2 * Math.PI),
      };
    }

    // a new segment that continues exactly where this one is (host publishes
    // it with every settings change, so nobody's rotation jumps)
    segmentAt(tMs) {
      this.advance(tMs);
      const I = this.integ;
      return { t0: I.t, turns0: I.turns, rate0: I.rate, phase0: I.phase };
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
      const max = st.fp * mult * ombakScale(f0, this.params, st.ombak);
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
      const { turns, rate, phase } = this.advance(tMs);
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
      const w = clamp(st.w, 1, 2);

      const voices = this.voices.map(vc => {
        const roleP = this.params.roles[vc.role];
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
        const level = roleP.base_gain * env * breathG * entry * c.masterM;
        const vTurns = st.mode === 'sweep' ? 0
          : (st.mode === 'counter' && vc.role === 'shimmer') ? -turns : turns;
        const posU = vc.v + vTurns * S;
        const shares = windowShares(posU, w).map(([iU, g]) => ({ slot: wrap(iU, S), g }));
        return {
          v: vc.v, role: vc.role, f0, level, posU, pos: wrap(posU, S), shares,
          fp: this.fingerprint(vc.v, vc.role, f0, tMs, c.fpAmp),
          bloom: vc.role === 'anchor' ? 0.35 : st.bloom * c.bloomM,
        };
      });

      // sweep: voices stay home; a bloom window circles and lifts each
      // position it passes
      let lift = null;
      if (st.mode === 'sweep') {
        const sp = wrap(turns * S, S), sw = Math.max(1.5, w * 1.5), floor = 0.12;
        lift = Array.from({ length: S }, (_, k) => {
          let d = Math.abs(k - sp); d = Math.min(d, S - d);
          const l = d < sw ? Math.pow(Math.cos(Math.PI * d / (2 * sw)), 2) : 0;
          return floor + (1 - floor) * l;
        });
      }

      return {
        tMs, sT: c.sT, label: c.sT === null ? null : (c.sT < 0 ? 'pre-roll' : (c.sT > this.score.duration ? 'end' : this.score.labelAt(c.sT))),
        comp: c.comp, turns, rate, factor, phase, stretch: c.stretch, amDepth: c.amDepth, fpAmp: c.fpAmp,
        ratios: scaleNow.spectrum.ratios, amps: this.scale.spectrum.amps,
        voices, lift,
      };
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
        const lift = fr.lift ? fr.lift[slot] : 1;
        const tension = st.bend * ombakScale(vc.f0, this.params, st.ombak) * fr.factor;
        const g1 = Math.min(1, g);
        out.push({ v: vc.v, vc, g: g * lift, detune: vc.fp + this.positionOffset(slot) * tension * (1 - g1 * g1) });
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
    mulberry32, fnv1a, clamp, wrap, smoothstep, pitchHzFor, assignRoles, ombakScale,
    interpolateScale, Score, Ring, windowShares, partialGains,
    defaultState, encodeState, decodeState,
  };
  root.NearfieldRing = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
