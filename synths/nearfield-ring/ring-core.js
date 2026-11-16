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
// On top of that: each layer (anchors, tones, shimmer, air) turns at its own
// speed and width; the tones are woven — at each turn a few hand over to
// others while a core never leaves (see "the weave" below); a deep foundation
// sits in the middle; every partial breathes slowly between neighboring phones.
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
      L: { anchor: [0.8, 1.5, 1], voice: [0.7, 1.5, 1], shimmer: [0.3, 1.25, -1] },
      air: [0, -1],                  // [level, with / against] — off by default
      bed: 0.8,                      // the foundation (center speaker) level
      pure: 0,                       // tuning: 0 = stretched (gamelan) .. 1 = pure octaves
      scale: 'own',                  // 'own' = the 4 tones derived from the timbre | 'slendro' = 5 equal steps
      rate: 0.27,                    // breathing: beat rate (Hz) of a partial at 210 Hz
      ratios: 'nested',              // layer cycle ratios: nested 1:2:4 | prime 5:7:11
      drift: 0.6,                    // 0 = every cycle together .. 1 = fully apart
      tide: 50,                      // sets the air's pace
      space: 0.6,                    // how many tones rest at a time (0 = all always in)
      phrase: 80,                    // seconds between turns
      stack: 1,                      // repeat degrees an octave up, for more pitches to trade
      choir: 1,                      // singers' pitch spread (0 = one exact voice per phone)
      glint: 1,                      // the faint twinkling harmonics on top (0 = none)
      bronze: 0.7,                   // bell partials blooming as a tone arrives (0 = none)
      voice: 0.5,                    // how sung the tones are (vowel colour amount)
      vowel: 0.4,                    // which vowel: 0 oo .. 0.25 oh .. 0.5 ah .. 0.75 eh .. 1 ee
      vowelMove: 0.5,                // how far each phone's vowel wanders around it
      vowelTravel: 0.6,              // how far the shared vowel journeys over time (0 = held)
      beatMove: 0.8,                 // how much the beating comes and goes and drifts in speed (0 = constant)
      soft: 0.68,                    // darker + slower edges
      beat: 1,                       // scales fingerprint + handoff bend
      bend: 0,                       // ± cents a position bends at a turn/min
      bloom: 0.3,                    // partial richness
      fp: 4,                         // fingerprint max cents
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

  const PURE_CENTS = [0, 498.045, 701.955, 884.359];   // 1, 4/3, 3/2, 5/3
  const BED_CLEAR_HZ = 38;   // a foundation color keeps at least this far from the root's octaves
  const NEAR_CENTS = 290;   // closer than this (about a minor third), two sustained tones grate
  // vowels as (first, second) formant in Hz, ordered so neighbors morph smoothly
  const VOWELS = [['oo', 300, 870], ['oh', 570, 840], ['ah', 730, 1090], ['eh', 530, 1840], ['ee', 270, 2290]];
  // the score's vowel arc: (fraction of the score, vowel position)
  const VOWEL_ARC = [[0, 0], [0.125, 0.2], [0.44, 0.5], [0.625, 0.68], [0.81, 0.88], [0.875, 0.6], [1, 0]];
  function vowelFormants(x) {
    const p = clamp(x, 0, 1) * (VOWELS.length - 1), i = Math.min(VOWELS.length - 2, Math.floor(p)), f = p - i;
    const a = VOWELS[i], b = VOWELS[i + 1];
    return { f1: a[1] * Math.pow(b[1] / a[1], f), f2: a[2] * Math.pow(b[2] / a[2], f), name: f < 0.5 ? a[0] : b[0] };
  }
  // 0..1: how close a frequency sits to either formant
  function vowelShape(f, fm) {
    const g = (F, w) => Math.exp(-Math.pow(Math.log2(f / F), 2) / (2 * w * w));
    return Math.max(g(fm.f1, 0.3), 0.8 * g(fm.f2, 0.22));
  }
  const hash01 = s => (fnv1a(s) % 100000) / 100000;
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
      this.voices = this._stack(this._voices(st.S));
      return st;
    }

    _voices(S) {
      const st = this.state;
      // slendro: five near-equal steps to the (stretched) octave, as in gamelan
      const scale = st.scale === 'slendro' ? { ...this.scale, scale_cents: [0, 1, 2, 3, 4] } : this.scale;
      return assignRoles(S, scale, this.params).map((a, v) => {
        let register = a.register;
        if (a.role === 'anchor' && st.anchors === 'lift') register = a.register + 1;
        return { v, role: a.role, degreeIndex: a.degreeIndex, register };
      });
    }

    // Octave stacking: when a degree comes round again among the tones, it
    // takes the octave above (quieter), so the ring holds more distinct
    // pitches to trade. Then the groups: tones of one pitch turn together.
    _stack(voices) {
      const seen = {};
      for (const vc of voices) {
        vc.gain = 1;
        if (vc.role === 'shimmer') continue;
        const n = seen[vc.degreeIndex] = (seen[vc.degreeIndex] ?? -1) + 1;
        if (this.state.stack && vc.role === 'voice' && n % 2 === 1) { vc.register += 1; vc.gain = 0.6; }
      }
      const slendro = this.state.scale === 'slendro', octC = 1200 * Math.log2(this.scale.pseudo_octave_ratio);
      const degC = slendro ? [0, 1, 2, 3, 4].map(k => k * octC / 5) : this.scale.scale_cents;
      const groups = [], anchorSteps = [], anchorCents = [], nDeg = degC.length;
      for (const vc of voices) {
        const step = vc.register * nDeg + vc.degreeIndex;   // position on the whole scale
        const cents = vc.register * octC + degC[vc.degreeIndex];
        if (vc.role === 'anchor') { vc.group = -1; anchorSteps.push(step); anchorCents.push(cents); continue; }
        const key = `${vc.degreeIndex}|${vc.register}`;
        let gi = groups.findIndex(g => g.key === key);
        if (gi < 0) { gi = groups.length; groups.push({ key, degree: vc.degreeIndex, step, cents }); }
        vc.group = gi;
        vc.stagger = (hash01(`${this.state.seed}|${vc.v}|stagger`) - 0.5) * 0.24;
      }
      this.groups = groups;
      this.anchorSteps = anchorSteps;
      this.anchorCents = anchorCents;
      // The foundation's colors. Low tones crowd each other far sooner than
      // high ones (gamelan keeps its bottom register nearly empty), so a color
      // sits one octave under the tones, and only degrees that land clear of
      // the root's octaves on both sides are used.
      const pu = clamp(this.state.pure, 0, 1), O = this.scale.pseudo_octave_ratio + (2 - this.scale.pseudo_octave_ratio) * pu;
      const base = this.scale.base_freq_hz, oc = 1200 * Math.log2(O);
      const dc = slendro ? [0, 1, 2, 3, 4].map(k => k * oc / 5) : this.scale.scale_cents.map((c, i) => c + ((PURE_CENTS[i] ?? c) - c) * pu);
      this.colorDegs = dc.map((c, d) => d).filter(d => {
        if (d === 0) return false;
        const f = base / O * Math.pow(2, dc[d] / 1200);
        return Math.min(Math.abs(f - base / O), Math.abs(f - base)) >= BED_CLEAR_HZ;
      });
      return voices;
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

    // --- the weave -------------------------------------------------------------
    // The sound never stops. Relief comes from *which* tones are sounding:
    // time runs in phrases, and at each turn a few tones hand over to others
    // — the incoming ones start before the outgoing ones have left — while a
    // core (the anchors and the foundation's root) never leaves. Modeled on
    // Aleksi Perälä's "Incandescence", where a 12-minute track keeps a 6 dB
    // loudness range and changes color by trading tones roughly every 80 s.

    // phrase position: whole numbers are the turns (lengths wander a little)
    turnPos(ct) {
      const st = this.state, P = Math.max(20, st.phrase);
      return ct / P + 0.09 * Math.sin(2 * Math.PI * ct / (P * 3.3) + (fnv1a(`${st.seed}|phrase`) % 628) / 100);
    }

    // The plan: for each phrase, which tone groups are in and which color the
    // foundation takes. A seeded walk — every turn swaps one group in for one
    // out, sometimes thickens or thins by one — played forward then backward,
    // so every turn (the wrap included) keeps tones in common with the last.
    _plan() {
      const st = this.state, G = this.groups.length;
      const key = `${st.seed}|${st.space}|${st.scale}|${this.groups.map(g => g.key).join(',')}`;
      if (this._planKey === key) return this._planned;
      const rng = mulberry32(fnv1a(`${st.seed}|turns`));
      const pick = a => a[Math.floor(rng() * a.length)];
      const k0 = clamp(Math.round((1 - 0.6 * clamp(st.space, 0, 1)) * G), Math.min(2, G), G);
      const kmin = Math.max(Math.min(2, G), k0 - 1), kmax = Math.min(G, k0 + 1);
      const order = Array.from({ length: G }, (_, i) => i);
      for (let i = G - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      const cur = new Array(G).fill(0);
      // How gamelan keeps close tones from grating: neighbors never ring
      // together (a player damps the last key when striking the next), and
      // what does sound together sits on the scale's consonances — for
      // slendro three steps (kempyung) or an octave (gembyang), for our own
      // scale its derived intervals. So: tones closer than about a minor
      // third take turns, nothing sits that close to an anchor, and partners
      // are sought on those intervals.
      const C = i => this.groups[i].cents, octC = 1200 * Math.log2(this.scale.pseudo_octave_ratio);
      const banned = i => this.anchorCents.some(a => Math.abs(a - C(i)) < NEAR_CENTS);
      const good = st.scale === 'slendro' ? [3, 5, 8, 10].map(k => k * octC / 5)
        : [1, 2].flatMap(o => [0, ...this.scale.scale_cents.slice(1)].map(c => c + (c === 0 ? o * octC : (o - 1) * octC)));
      const partner = d => good.some(g => Math.abs(d - g) < 20);
      const count = () => cur.reduce((a, v) => a + v, 0), free = i => !cur[i] && !banned(i) && !cur.some((v, j) => v && this._conflict(i, j));
      const fit = i => cur.filter((v, j) => v && partner(Math.abs(C(i) - C(j)))).length + this.anchorCents.filter(a => partner(Math.abs(a - C(i)))).length;
      if (st.space <= 0) cur.fill(1);   // "all in": the wall, by request
      else for (const i of order) if (count() < k0 && free(i)) cur[i] = 1;
      const seq = [], waited = new Array(G).fill(0), held = new Array(G).fill(0);   // phrases out / in
      let color = 0;
      const colorDegs = this.colorDegs;
      for (let n = 0; n < 16; n++) {
        if (n > 0 && st.space > 0) {
          const insNow = cur.map((v, i) => v ? i : -1).filter(i => i >= 0);
          // bring one tone in: the one that fits best with what stays
          let best = null;
          for (let i = 0; i < G; i++) {
            if (cur[i] || banned(i)) continue;
            const kept = insNow.filter(j => !this._conflict(i, j));
            if (!kept.length && insNow.length) continue;   // always keep a tone in common
            // ... and the longer a tone has waited, the more it is due
            const score = kept.filter(j => partner(Math.abs(C(i) - C(j)))).length +
              this.anchorCents.filter(a => partner(Math.abs(a - C(i)))).length + Math.min(6, waited[i]) * 1.2 + rng() * 1.5;
            if (!best || score > best.score) best = { i, kept, score };
          }
          if (best) {
            for (const j of insNow) if (this._conflict(best.i, j)) cur[j] = 0;   // damp its neighbors
            cur[best.i] = 1;
            const others = () => best.kept.filter(j => cur[j]);
            const eldest = () => others().sort((x, y) => held[y] - held[x] || x - y)[0];
            // too many, or nothing was damped: the one that has sounded longest steps out
            while (count() > kmax && others().length >= 2) cur[eldest()] = 0;
            if (best.kept.length === insNow.length && others().length >= 2 && count() > kmin && rng() < 0.6) cur[eldest()] = 0;
            // too few: add whatever fits best without crowding
            if (count() < kmin) { const c = order.filter(free).sort((x, y) => fit(y) - fit(x)); if (c.length) cur[c[0]] = 1; }
          }
        }
        for (let i = 0; i < G; i++) { if (cur[i]) { held[i]++; waited[i] = 0; } else { waited[i]++; held[i] = 0; } }
        // the foundation's color: one featured degree at a time, held when it can be
        const feat = [...new Set(this.groups.filter((g, i) => cur[i] && colorDegs.includes(g.degree)).map(g => g.degree))];
        if (!feat.includes(color) || rng() > 0.6) color = feat.length ? pick(feat) : 0;
        seq.push({ in: cur.slice(), color });
      }
      this._planKey = key;
      this._planned = seq.concat(seq.slice(1, -1).reverse());
      return this._planned;
    }

    // two tone groups too close to ring together (unless "all in" is asked for)
    _conflict(i, j) { return i !== j && this.state.space > 0 && Math.abs(this.groups[i].cents - this.groups[j].cents) < NEAR_CENTS; }

    // a tone group's gate: overlapping handover normally; but when it trades
    // places with a neighboring step, the old one leaves before the new one
    // arrives, so the two never ring together
    _groupGate(gi, u, stagger) {
      const plan = this._plan(), L = plan.length, m = Math.round(u);
      const A = plan[wrap(m - 1, L)].in, B = plan[wrap(m, L)].in;
      if (A[gi] === B[gi]) return A[gi];
      for (let j = 0; j < A.length; j++) {
        if (A[j] !== B[j] && A[j] !== A[gi] && this._conflict(gi, j)) return this._gate(p => p.in[gi], u, 0, -0.07, 0.26);
      }
      return this._gate(p => p.in[gi], u, stagger);
    }

    // seconds since this group last came in (negative while it is still
    // arriving; Infinity if it has not entered lately or is on its way out)
    _entryAge(gi, u, stagger) {
      const plan = this._plan(), L = plan.length, m0 = Math.round(u), P = Math.max(20, this.state.phrase);
      for (let m = m0; m > m0 - 8; m--) {
        const before = plan[wrap(m - 1, L)].in[gi], after = plan[wrap(m, L)].in[gi];
        if (!before && after) return (u - (m + stagger - 0.08)) * P;
        if (before && !after) return Infinity;
      }
      return Infinity;
    }

    // 0..1: is this group in at phrase position u? Around a turn a tone fades
    // over 0.4 of a phrase; entries lead and exits trail, so the incoming
    // tones overlap the outgoing ones and the level never dips.
    // (lead < 0 does the opposite — out first, then in — for the foundation's
    // colors, which sit a few hertz apart and would growl if they overlapped.)
    _gate(isIn, u, stagger, lead = 0.08, width = 0.4) {
      const plan = this._plan(), L = plan.length, m = Math.round(u);
      const before = isIn(plan[wrap(m - 1, L)]) ? 1 : 0, after = isIn(plan[wrap(m, L)]) ? 1 : 0;
      if (before === after) return before;
      const shift = stagger + (after ? -lead : lead);
      return before + (after - before) * smoothstep((u - (m + shift)) / width + 0.5);
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
      // tuning: blend the stretched (gamelan-derived) scale toward its pure
      // counterpart — octave 2, harmonic partials, and the just intervals the
      // same dissonance-curve method lands on for a harmonic tone
      const pu = clamp(st.pure, 0, 1), mix = (a, b) => a + (b - a) * pu;
      const es = {
        base_freq_hz: this.scale.base_freq_hz,
        pseudo_octave_ratio: mix(scaleNow.stretch ?? scaleNow.spectrum.ratios[1], 2),
        scale_cents: scaleNow.scale_cents.map((c, i) => mix(c, PURE_CENTS[i] ?? c)),
      };
      // slendro divides whatever the octave currently is into five equal steps
      if (st.scale === 'slendro') es.scale_cents = [0, 1, 2, 3, 4].map(k => k * 1200 * Math.log2(es.pseudo_octave_ratio) / 5);
      // Partials: the fundamental, its (stretched) octave, the bell partial
      // (3.2 in gamelan tuning), and the double octave. The top one is tuned
      // to the octave, not the derived spectrum's 4.4, so that everything
      // allowed to *sustain* up high is an octave of a scale tone: different
      // tones' high partials then sit a full scale step apart, where the
      // spectrum's own would land a few hertz apart and beat harshly.
      const partialRatios = scaleNow.spectrum.ratios.map((r, i) => mix(r, i + 1));
      partialRatios[3] = es.pseudo_octave_ratio * es.pseudo_octave_ratio;
      const factor = clamp(Math.abs(rate) * 60, 0, 1.5);   // 1 = a turn a minute
      const breathG = 1 + this.params.breath.ensemble_depth * Math.sin(phase);
      const gongAge = c.sT === null ? Infinity : c.sT - this.score.lastEventAt(c.sT);
      const gongOn = gongAge >= 0 && gongAge < GONG_S;
      const bukaLen = this.score.sections[1]?.at ?? 120;
      const nonAnchors = this.voices.filter(x => x.role !== 'anchor');
      const anchors = this.voices.filter(x => x.role === 'anchor');
      // where we are in the weave (whole numbers of u are the turns)
      const u = this.turnPos(adv.ct);
      const bump = Math.exp(-Math.pow((u - Math.round(u)) / 0.1, 2));   // 1 at a turn
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
        // anchors hold (they breathe); the other tones come and go at the turns
        const ev = this.beatEvolve(vc.v, adv.ct);
        const tide = vc.group < 0 ? 1 : this._groupGate(vc.group, u, vc.stagger);
        // Bronze: a struck bar's bell partials flare and die away while the
        // hum stays. Here the strike is stretched out: as a tone arrives its
        // upper partials bloom, then recede over seconds — the higher, the
        // sooner. Anchors flare at each turn, with the root's gong-like swell.
        const age = vc.group < 0 ? null : this._entryAge(vc.group, u, vc.stagger);
        const flare = vc.group < 0 ? [bump, 0.7 * bump, 0.5 * bump]
          : [16, 9, 5].map(tau => age === Infinity ? 0 : age < 0 ? Math.exp(age / 6) : Math.exp(-age / tau));
        const level = roleP.base_gain * vc.gain * env * breathG * entry * c.masterM * tide * st.L[vc.role][0];
        const posU = vc.v + adv.lt[LAYER_INDEX[vc.role]] * S;
        const shares = windowShares(posU, w).map(([iU, g]) => ({ slot: wrap(iU, S), g }));
        return {
          v: vc.v, role: vc.role, f0, level, tide, flare, posU, pos: wrap(posU, S), shares, peak: peaks[vc.role],
          beatMul: ev.rate, choirMul: ev.choir,
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

      // Foundation: a deep tone with its octaves and fifth, for a real speaker
      // in the middle (phones cannot play it). Each part is a pair of tones a
      // fraction of a hertz apart, so it breathes; the root's pair is uneven,
      // which keeps the bottom steadier than what sits above it.
      const O = es.pseudo_octave_ratio, root = pitchHzFor(es, 0, -2);
      // The root and its octaves never leave; at each turn the root swells a
      // little, like a gong marking it. One color (a featured degree, an
      // octave under the tones) sits on top and changes at the turns.
      const colorParts = this.colorDegs.map(deg =>
        [pitchHzFor(es, deg, -1), 0.3 * this._gate(p => p.color === deg, u, 0, -0.13, 0.26), 0.85, 0.5]);
      const bed = {
        lvl: st.bed * c.masterM * (0.85 + 0.15 * Math.sin(phase + 1)),
        parts: [[root, 1 + 0.3 * bump, 0.35, 0], [root * O, 0.45, 0.85, 0.75], [root * O * O, 0.2, 0.85, 0], ...colorParts]
          .map(([f, g, depth, trade], i) => ({ f, g, depth, trade, beat: this.beatHz(f) * this.beatEvolve(`bed${i}`, adv.ct).rate * (0.8 + 0.4 * hash01(`${st.seed}|bed|${i}`)) })),
      };
      const groupsIn = this.groups.filter((g, i) => this._groupGate(i, u, 0) > 0.5).length;

      const absRate = Math.abs(rate);
      return {
        tMs, sT: c.sT, label: c.sT === null ? null : (c.sT < 0 ? 'pre-roll' : (c.sT > this.score.duration ? 'end' : this.score.labelAt(c.sT))),
        comp: c.comp, turns, rate, factor, phase, stretch: c.stretch, amDepth: c.amDepth, fpAmp: c.fpAmp,
        ratios: partialRatios, amps: this.scale.spectrum.amps,
        ct: adv.ct, lt: adv.lt, soft: st.soft, air, bed, vowel: this.vowelNow(adv.ct, c.sT),
        // the shimmer's arc: with the score, it follows the bloom (none in the
        // buka, gone by the end); always riding a slow swell of its own
        glintArc: c.bloomM * c.masterM * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(2 * Math.PI * adv.ct / (st.tide * 2.9) + 1.3))),
        // the weave: seconds to the next turn, and how many tone groups are in
        turn: { u, nextS: (Math.ceil(u) - u) * Math.max(20, st.phrase) / c.comp, groupsIn, groups: this.groups.length },
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

    // Beating that evolves. Left alone, every wave runs at one speed and the
    // choir shimmers at one strength, forever. Instead, per tone:
    //   rate   the wave between paired phones drifts slower and faster
    //          (about x0.7 to x1.5) over a couple of phrases
    //   choir  the singers draw together into near-unison, leaving only the
    //          slow wave, then spread into shimmer again — partly on a cycle
    //          the whole ring shares, so there are calm stretches for everyone
    // `beatMove` is how much of this happens (0 = constant, as before).
    beatEvolve(id, ct) {
      const st = this.state, m = clamp(st.beatMove, 0, 1);
      if (m <= 0) return { rate: 1, choir: 1 };
      const r = mulberry32(fnv1a(`${st.seed}|${id}|beatmove`)), P = Math.max(20, st.phrase), TAU = 2 * Math.PI;
      const rate = Math.pow(2, 0.7 * m * Math.sin(TAU * ct / (P * (1.9 + 1.2 * r())) + TAU * r()));
      const shared = 0.04 + 0.96 * (0.5 + 0.5 * Math.sin(TAU * ct / (P * 1.7) + (fnv1a(`${st.seed}|calm`) % 628) / 100));
      const own = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(TAU * ct / (P * (0.9 + 0.9 * r())) + TAU * r()));
      // as a power, so the calm stretches stay calm at any setting short of 0
      return { rate, choir: Math.pow(shared * own * 1.3, m) };
    }

    // beat rate (Hz) for a tone at f: slow, rising gently with pitch
    beatHz(f) { return this.state.rate * Math.pow(f / 210, 0.6); }

    // the foundation, for the device in the middle
    bedAt(fr, slot) { return slot === 'pedestal' ? fr.bed : null; }

    // What one position plays: each voice with a share here, its gain and its
    // detune (fingerprint + this position's handoff bend, fading as the voice
    // arrives). slot = 'pedestal' plays the anchors in the middle.
    playersAt(fr, slot) {
      const st = this.state;
      const out = [];
      for (const vc of fr.voices) {
        if (slot === 'pedestal') {
          if (vc.role === 'anchor' && st.anchors === 'pedestal') { const d = [vc.fp, vc.fp, vc.fp, vc.fp]; out.push({ v: vc.v, vc, g: 1, detune: vc.fp, detunes: d, singers: [{ g: 1, detunes: d }], glints: [0, 0, 0], body: [1, 1, 1, 1], open: [0, 0, 0, 0] }); }
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
        const shared = vc.fp + this.positionOffset(slot) * tension * (1 - g1 * g1);
        // Breathing: neighboring positions play each partial a fraction of a
        // hertz apart (alternating above / below), so wherever a tone sounds
        // on two phones every partial beats slowly between them, each at its
        // own rate.
        const side = slot % 2 === 0 ? 0.5 : -0.5;
        const detunes = fr.ratios.map((r, j) => {
          const f = vc.f0 * r;
          const off = side * this.beatHz(f) * vc.beatMul * (0.75 + 0.5 * hash01(`${st.seed}|${slot}|${vc.v}|${j}`));
          return shared + 1200 * Math.log2(1 + off / f);
        });
        // Choir: two singers per phone on each tone, each drifting on its own
        const nS = st.choir > 0 ? 2 : 1, singers = [];
        for (let k = 0; k < nS; k++) {
          const c = this.singerCents(slot, vc.v, k, vc.f0, fr.tMs) * vc.choirMul;
          singers.push({ g: 1 / Math.sqrt(nS), detunes: detunes.map(d => d + c) });
        }
        const vw = this.vowelGains(slot, vc, fr), gl = this.glints(slot, vc, fr);
        if (st.bronze > 0) for (let j = 1; j < 4; j++) {
          vw.open[j] += st.bronze * vc.flare[j - 1];
          if (vc.f0 * fr.ratios[j] >= 700) vw.bright[j - 1] += st.bronze * 0.4 * vc.flare[j - 1] / j;
        }
        out.push({ v: vc.v, vc, g, detune: singers[0].detunes[0], detunes: singers[0].detunes, singers,
          glints: gl.map((x, i) => x + vw.bright[i]), body: vw.body, open: vw.open });
      }
      return out;
    }

    // Vowel: a sung tone keeps bright regions (formants) that stay put while
    // the note changes. Each phone has a vowel — the set one, wandering a
    // little so the choir never quite agrees — and weights every partial by
    // how close it falls to that vowel's two formants.
    //   body   multiplier on each partial's normal level
    //   open   extra level for partials the bloom has not opened (x amps)
    //   bright extra level for partials 2-4 above 700 Hz, sent round the
    //          darkening filter with the glints
    vowelAt(slot, fr) {
      const st = this.state;
      const r = mulberry32(fnv1a(`${st.seed}|${slot}|vowel`));
      const ts = (fr.tMs - st.epoch) / 1000;
      return vowelFormants(fr.vowel + st.vowelMove * 0.18 * Math.sin(2 * Math.PI * ts / (23 + r() * 31) + r() * 2 * Math.PI));
    }

    // The vowel everyone shares, evolving. On its own it wanders slowly around
    // the set vowel, changing about as often as the weave turns. With the
    // score it follows an arc, a mouth opening over the piece: closed (oo) in
    // the buka, through oh and ah, brightest (toward ee) late in cycle II,
    // closing again across the final gong. `vowelTravel` is how far it goes:
    // 0 holds the set vowel.
    vowelNow(ct, sT) {
      const st = this.state, tr = clamp(st.vowelTravel, 0, 1), P = Math.max(20, st.phrase);
      const ph = (fnv1a(`${st.seed}|vowelpath`) % 628) / 100;
      const wander = 0.6 * Math.sin(2 * Math.PI * ct / (P * 2.3) + ph) + 0.4 * Math.sin(2 * Math.PI * ct / (P * 5.7) + 2 * ph);
      if (sT === null) return clamp(st.vowel + tr * 0.45 * wander, 0, 1);
      const D = this.score.duration, x = clamp(sT, 0, D) / D;
      let arc = VOWEL_ARC[VOWEL_ARC.length - 1][1];
      for (let i = 1; i < VOWEL_ARC.length; i++) if (x <= VOWEL_ARC[i][0]) {
        const [x0, v0] = VOWEL_ARC[i - 1], [x1, v1] = VOWEL_ARC[i];
        arc = v0 + (v1 - v0) * smoothstep((x - x0) / (x1 - x0)); break;
      }
      return clamp(st.vowel + (arc - st.vowel) * tr + tr * 0.12 * wander, 0, 1);
    }
    vowelGains(slot, vc, fr) {
      const amt = clamp(this.state.voice, 0, 1);
      if (amt <= 0) return { body: [1, 1, 1, 1], open: [0, 0, 0, 0], bright: [0, 0, 0] };
      const fm = this.vowelAt(slot, fr);
      const V = fr.ratios.map(r => vowelShape(vc.f0 * r, fm));
      return {
        body: V.map((v, j) => 1 + amt * ((j === 0 ? 0.6 + 0.6 * v : 0.3 + 1.5 * v) - 1)),
        // (only the octave partials: a held bell partial would clash with its neighbors')
        open: V.map((v, j) => j === 0 || j === 2 ? 0 : amt * 0.9 * v),
        bright: [1, 2, 3].map(j => j === 2 || vc.f0 * fr.ratios[j] < 700 ? 0 : amt * 0.3 * V[j] / j),
      };
    }

    // Glints: the shimmer on top. A tone's own octave and double octave, where
    // they land between about 1 and 2.5 kHz, sound very faintly, outside the
    // darkening filter, each twinkling on its own cycle of one to three
    // seconds — and each phone twinkles differently, so the sparkle moves
    // around the ring. They follow an arc: absent while the piece is sparse,
    // present when it is full. (In "Incandescence": six tones at 1.06–2.1 kHz,
    // 40–55 dB under the bass, exact x2 / x3 / x4 of the tones below,
    // flickering 10–13 dB at 0.3–1.6 Hz, strongest mid-piece.)
    // Returns the level of partials 2, 3, 4 relative to the tone's level.
    glints(slot, vc, fr) {
      const st = this.state, amt = st.glint * fr.glintArc;
      if (amt <= 0) return [0, 0, 0];
      const ts = (fr.tMs - st.epoch) / 1000;
      return [1, 2, 3].map(j => {
        if (j === 2) return 0;   // the bell partial only flares (bronze); it never sustains up here
        const f = vc.f0 * fr.ratios[j];
        const band = smoothstep((f - 800) / 400) * (1 - smoothstep((f - 2400) / 800));
        if (band <= 0) return 0;
        const r = mulberry32(fnv1a(`${st.seed}|${slot}|${vc.v}|${j}|glint`));
        const twinkle = 0.3 + 0.7 * Math.pow(0.5 + 0.5 * Math.sin(2 * Math.PI * ts / (0.6 + r() * 2.7) + r() * 2 * Math.PI), 2);
        return 0.45 * amt * band * twinkle / j;
      });
    }

    // Choir: what turns a pure tone into something sung is that it is not one
    // exact pitch but a few voices near it, each drifting slowly. In Perälä's
    // "Incandescence" the bass tones are razor lines while every tone above
    // ~130 Hz is a band about 1% of its pitch wide. So each phone carries two
    // singers per tone; a singer has its own seat (a fixed offset) and wanders
    // around it over a few seconds, all its partials together, by a few cents
    // — none at the bottom, full above ~300 Hz. Every phone is a different
    // pair of singers, so a tone spread over three phones is six voices.
    singerCents(slot, v, k, f0, tMs) {
      const st = this.state;
      const sigma = 8 * st.choir * clamp((f0 - 90) / 200, 0, 1);
      if (sigma <= 0) return 0;
      const r = mulberry32(fnv1a(`${st.seed}|${slot}|${v}|${k}|choir`));
      const seat = (r() * 2 - 1) * 0.7, ts = (tMs - st.epoch) / 1000;
      let x = 0;
      for (let i = 0; i < 3; i++) x += Math.sin(2 * Math.PI * ts / (1.7 + r() * 6.3) + r() * 2 * Math.PI);
      return sigma * (seat + x * 0.61);
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
    defaultState, normalizeState, layerSpeeds, encodeState, decodeState, vowelFormants, vowelShape,
  };
  root.NearfieldRing = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
