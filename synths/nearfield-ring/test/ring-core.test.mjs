// node --test synths/nearfield-ring/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const NR = require('../ring-core.js');
const cfgDir = new URL('../config/', import.meta.url);
const load = f => JSON.parse(readFileSync(new URL(f, cfgDir), 'utf8'));
const cfg = { scale: load('scale.json'), params: load('params.json'), score: load('score.json'), drift: load('scale_drift.json') };

const T0 = 1_800_000_000_000;
// baseline for the handoff/score tests: every layer together, no tides, no air
// (and the original stretched tuning, fingerprint and handoff bend)
const PLAIN = { drift: 0, density: 1, L: { anchor: [1, 1, 1], voice: [1, 1, 1], shimmer: [1, 1, 1] }, air: [0, 1], pure: 0, fp: 12, bend: 10, bed: 0, space: 0, stack: 0, choir: 0 };
function ring(over = {}) {
  const r = new NR.Ring(cfg);
  r.setState({ ...NR.defaultState(T0), ...PLAIN, ...over });
  return r;
}
function cycles(over = {}) {
  const r = new NR.Ring(cfg);
  r.setState({ ...NR.defaultState(T0), ...over });
  return r;
}

test('two devices sampling at different moments agree exactly', () => {
  const a = ring(), b = ring();
  const end = T0 + 10 * 60 * 1000 + 37;
  for (let t = T0; t < end; t += 16.7) a.advance(t);   // a 60 fps phone
  for (let t = T0; t < end; t += 1000) b.advance(t);   // a throttled background tab
  const fa = a.frame(end), fb = b.frame(end);
  assert.equal(fa.turns, fb.turns);
  assert.equal(fa.phase, fb.phase);
  assert.deepEqual(fa.voices.map(v => v.fp), fb.voices.map(v => v.fp));
});

test('a late joiner lands exactly where everyone else is', () => {
  const early = ring(), late = ring();
  const end = T0 + 25 * 60 * 1000;
  for (let t = T0; t < end; t += 100) early.advance(t);
  assert.equal(late.frame(end).turns, early.frame(end).turns);
});

test('republishing a segment continues the rotation without a jump', () => {
  const r = ring();
  const t1 = T0 + 90_000;
  const seg = r.segmentAt(t1);
  const next = ring({ seg, rev: 2 });
  const later = t1 + 30_000;
  assert.ok(Math.abs(next.frame(later).turns - r.frame(later).turns) < 1e-5);
});

test('one turn per breath: a minute is a full turn once up to speed', () => {
  const r = ring({ seg: { t0: T0, turns0: 0, rate0: 1 / 60, phase0: 0 } });
  const fr = r.frame(T0 + 60_000);
  assert.ok(Math.abs(fr.turns - 1) < 1e-6, `turns ${fr.turns}`);
  assert.ok(Math.abs(fr.factor - 1) < 1e-9);
});

test('every voice keeps unit power through a handoff, at width 1 and 2', () => {
  for (const w of [1, 1.5, 2]) {
    for (const pos of [3, 3.25, 3.5, 3.9]) {
      const p = NR.windowShares(pos, w).reduce((s, [, g]) => s + g * g, 0);
      assert.ok(Math.abs(p - 1) < 1e-9, `w ${w} pos ${pos} power ${p}`);
    }
  }
});

test('positions split each voice; mid-handoff the two phones bend apart', () => {
  const r = ring({ seg: { t0: T0, turns0: 0.5 / 8, rate0: 1 / 60, phase0: 0 } });
  const fr = r.frame(T0);
  const v1 = fr.voices[1];
  const at1 = r.playersAt(fr, 1).find(p => p.v === 1);
  const at2 = r.playersAt(fr, 2).find(p => p.v === 1);
  assert.ok(at1 && at2, 'voice 1 sounds on positions 1 and 2');
  assert.ok(Math.abs(at1.g - at2.g) < 1e-3, 'equal halves mid-handoff');
  assert.notEqual(at1.detune, at2.detune, 'each position bends differently');
  assert.ok(Math.abs((at1.detune + at2.detune) / 2 - v1.fp) < 12, 'bends ride on the fingerprint');
});

test('fingerprints are bounded and fade to nothing at the end of the score', () => {
  const r = ring();
  for (let t = T0; t < T0 + 3600_000; t += 61_000) {
    for (const v of r.frame(t).voices) {
      const max = 12 * cfg.params.drift.role_multipliers[v.role] * NR.ombakScale(v.f0, cfg.params, 1);
      assert.ok(Math.abs(v.fp) <= max + 1e-9);
    }
  }
  const s = ring({ score: { start: T0, comp: 1 } });
  const end = s.frame(T0 + 960_000);
  assert.ok(end.voices.every(v => Math.abs(v.fp) < 1e-9));
  assert.ok(end.voices.every(v => v.level === 0), 'master fades out at the end');
});

test('the score: buka entries, breath turning, aging scale, rest at the end', () => {
  const r = ring({ score: { start: T0, comp: 1 } });
  const at = s => r.frame(T0 + s * 1000);
  // pre-roll is silent
  assert.ok(at(-2).voices.every(v => v.level === 0));
  assert.equal(at(-2).label, 'pre-roll');
  // buka: anchors from the start, voices stagger in around the ring
  const b30 = at(30).voices;
  assert.ok(b30.filter(v => v.role === 'anchor').every(v => v.level > 0));
  const entered = s => at(s).voices.filter(v => v.role !== 'anchor' && v.level > 0.01).length;
  assert.ok(entered(20) < entered(80) && entered(80) <= entered(125));
  // turning: breath 60 -> 40, rotation follows (one turn per breath)
  const r2 = ring({ score: { start: T0, comp: 1 } });
  for (let t = T0; t < T0 + 700_000; t += 1000) r2.advance(t);
  const f700 = r2.frame(T0 + 700_000);
  assert.ok(Math.abs(1 / f700.rate - 40) < 0.5, `turn period ${1 / f700.rate}`);
  assert.equal(f700.label, 'cycle-ii');
  assert.ok(Math.abs(f700.stretch - (2.04 + 0.06 * 700 / 840)) < 1e-9);
  // final gong: rotation comes to rest
  for (let t = T0 + 700_000; t < T0 + 960_000; t += 1000) r2.advance(t);
  assert.ok(Math.abs(r2.frame(T0 + 960_000).rate) < 0.004);
});

test('time compression runs the same arc faster', () => {
  const r = ring({ score: { start: T0, comp: 16 } });
  assert.equal(r.frame(T0 + 55_000).label, 'final-gong');   // 55 s × 16 = 14:40
  assert.equal(r.frame(T0 + 61_000).label, 'end');
});

test('pedestal mode moves the anchors off the phones', () => {
  const r = ring({ anchors: 'pedestal' });
  const fr = r.frame(T0 + 5000);
  for (let k = 0; k < 8; k++) assert.ok(r.playersAt(fr, k).every(p => p.vc.role !== 'anchor'));
  assert.ok(r.playersAt(fr, 'pedestal').length > 0);
  assert.ok(r.playersAt(fr, 'pedestal').every(p => p.vc.role === 'anchor'));
});

test('state survives the link round trip', () => {
  const st = { ...NR.defaultState(T0), score: { start: T0 + 4000, comp: 8 }, S: 12, rev: 7 };
  assert.deepEqual(NR.normalizeState(NR.decodeState(NR.encodeState(st))), NR.normalizeState(st));
  const tweaked = { ...st, density: 0.4, L: { ...st.L, voice: [0.8, 3, -1] }, air: [0.6, 1], seed: 'abc' };
  assert.deepEqual(NR.normalizeState(NR.decodeState(NR.encodeState(tweaked))), NR.normalizeState(tweaked));
  assert.ok(NR.encodeState(st).length < 420, `state link ${NR.encodeState(st).length} chars`);
  assert.equal(NR.decodeState('garbage'), null);
});

// --- cycles: layers, tides, air ---------------------------------------------------

test('layers turn at their own speeds and directions, and devices still agree', () => {
  const a = cycles({ drift: 1 }), b = cycles({ drift: 1 });
  const end = T0 + 7 * 60 * 1000 + 13;
  for (let t = T0; t < end; t += 16.7) a.advance(t);
  for (let t = T0; t < end; t += 900) b.advance(t);
  const fa = a.frame(end), fb = b.frame(end);
  assert.deepEqual(fa.lt, fb.lt);
  assert.equal(fa.ct, fb.ct);
  // nested 1:2:4 at full drift: anchor half speed, shimmer double and against
  assert.ok(Math.abs(fa.lt[0] / fa.lt[1] - 0.5) < 1e-9);
  assert.ok(Math.abs(fa.lt[2] / fa.lt[1] + 2) < 1e-9);
  assert.ok(fa.lt[3] < 0, 'air circles against the rotation');
});

test('drift 0 moves every layer together', () => {
  const r = cycles({ drift: 0, L: { anchor: [1, 1, 1], voice: [1, 1, 1], shimmer: [1, 1, 1] }, air: [0.3, 1] });
  const fr = r.frame(T0 + 300_000);
  for (const x of fr.lt) assert.ok(Math.abs(x - fr.turns) < 1e-9);
});

test('a settings change continues every layer and the tides without a jump', () => {
  const r = cycles();
  const t1 = T0 + 200_000;
  const before = r.frame(t1);
  const next = cycles({ seg: r.segmentAt(t1), drift: 0.9, rev: 2 });
  const after = next.frame(t1);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(after.lt[i] - before.lt[i]) < 1e-5);
  assert.ok(Math.abs(after.ct - before.ct) < 0.06);
});

test('the weave never touches the anchors, and moves slowly', () => {
  const r = cycles();
  let maxStep = 0, prev = null;
  for (let t = T0; t < T0 + 600_000; t += 50) {
    const fr = r.frame(t);
    assert.ok(fr.voices.filter(v => v.role === 'anchor').every(v => v.tide === 1));
    const tides = fr.voices.map(v => v.tide);
    if (prev) for (let i = 0; i < tides.length; i++) maxStep = Math.max(maxStep, Math.abs(tides[i] - prev[i]));
    prev = tides;
  }
  assert.ok(maxStep < 0.02, `largest tide change in 50 ms: ${maxStep}`);
});

test('wide layers spread a voice over several phones at unit power', () => {
  const r = cycles({ L: { anchor: [1, 1, 1], voice: [1, 3, 1], shimmer: [1, 1, -1] } });
  const fr = r.frame(T0 + 90_000);
  const v = fr.voices.find(x => x.role === 'voice');
  assert.ok(v.shares.length >= 5);
  assert.ok(Math.abs(v.shares.reduce((s, x) => s + x.g * x.g, 0) - 1) < 1e-9);
});

test('air: bounded, silent in the pre-roll, strongest where it is passing', () => {
  const r = cycles({ air: [0.5, -1] });
  for (let t = T0; t < T0 + 1200_000; t += 9000) {
    const fr = r.frame(t);
    assert.ok(fr.air.lvl >= 0 && fr.air.lvl <= 0.5 + 1e-9);
    assert.ok(fr.air.freq > 200 && fr.air.freq < 1000, `air tone ${fr.air.freq}`);
    const here = r.airAt(fr, Math.round(fr.air.pos) % 8).g, far = r.airAt(fr, (Math.round(fr.air.pos) + 4) % 8).g;
    assert.ok(here >= far);
  }
  const s = cycles({ score: { start: T0 + 4000, comp: 1 } });
  assert.equal(s.frame(T0 + 1000).air.lvl, 0);
});

test('beat depth scales fingerprint and bend together; 0 is perfectly in tune', () => {
  const r = cycles({ beat: 0, rate: 0, choir: 0 });
  const fr = r.frame(T0 + 123_456);
  for (let k = 0; k < 8; k++) for (const p of r.playersAt(fr, k)) assert.ok(p.detune === 0);
});

test('a pre-cycles link still plays: layers start from the shared rotation', () => {
  const old = { v: 1, rev: 3, epoch: T0, seed: '1', S: 6, seg: { t0: T0, turns0: 2.5, rate0: 1 / 60, phase0: 1 },
    score: null, mode: 'chord', dir: 1, lock: 1, period: 60, breath: 60, w: 1, bend: 10, bloom: 0.5, fp: 12, ombak: 1, anchors: 'lift', vol: 1 };
  const r = new NR.Ring(cfg);
  const st = r.setState(old);
  assert.deepEqual(st.seg.lt0, [2.5, 2.5, 2.5, 2.5]);
  assert.ok(r.frame(T0 + 5000).voices.length === 6);
});

// --- warmth: tuning, breathing, foundation -------------------------------------------

test('pure tuning: octaves of 2, harmonic partials, just intervals', () => {
  const fr = cycles({ pure: 1 }).frame(T0 + 60_000);
  assert.deepEqual(fr.ratios, [1, 2, 3, 4]);
  const by = d => fr.voices.find(v => v.role === 'voice' && v.v % 4 === d).f0;
  assert.ok(Math.abs(by(2) / 220 - 3 / 2) < 1e-4);
  assert.ok(Math.abs(by(3) / 220 - 5 / 3) < 1e-4);
  const sh = fr.voices.find(v => v.role === 'shimmer');
  assert.ok(Math.abs(sh.f0 / (220 * Math.pow(2, [0, 498.045, 701.955, 884.359][sh.v % 4] / 1200)) - 2) < 1e-6);
  // 0 leaves the stretched scale exactly as derived
  const st = cycles({ pure: 0 }).frame(T0 + 60_000);
  assert.deepEqual(st.ratios, cfg.scale.spectrum.ratios);
});

test('breathing: neighbors play each partial a fraction of a hertz apart', () => {
  const r = cycles({ rate: 0.27, fp: 0, bend: 0, choir: 0 });
  const fr = r.frame(T0 + 77_000);
  let pairs = 0;
  for (let k = 0; k < 8; k++) {
    const here = r.playersAt(fr, k), next = r.playersAt(fr, (k + 1) % 8);
    for (const a of here) {
      const b = next.find(x => x.v === a.v);
      if (!b) continue;
      for (let j = 0; j < 4; j++) {
        const f = a.vc.f0 * fr.ratios[j];
        const beat = Math.abs(f * Math.pow(2, a.detunes[j] / 1200) - f * Math.pow(2, b.detunes[j] / 1200));
        const want = r.beatHz(f);
        assert.ok(beat > want * 0.7 && beat < want * 1.3, `partial ${j} at ${f.toFixed(0)} Hz beats ${beat.toFixed(3)} (law ${want.toFixed(3)})`);
        pairs++;
      }
    }
  }
  assert.ok(pairs > 20);
  // 210 Hz breathes about every 3.7 s; higher partials a little faster
  assert.ok(Math.abs(r.beatHz(210) - 0.27) < 1e-9 && r.beatHz(475) > r.beatHz(210) && r.beatHz(475) < 0.5);
});

test('foundation: root and octaves always, one color at a time, silent before the score', () => {
  const r = cycles();
  const fr = r.frame(T0 + 30_000);
  assert.equal(r.bedAt(fr, 3), null);
  const bed = r.bedAt(fr, 'pedestal');
  assert.ok(Math.abs(bed.parts[0].f - 55) < 1e-6 && Math.abs(bed.parts[1].f - 110) < 1e-6 && Math.abs(bed.parts[2].f - 220) < 1e-6);
  assert.ok(bed.parts.every(p => p.beat > 0.05 && p.beat < 0.6));
  assert.ok(bed.parts[0].depth < bed.parts[1].depth, 'the bottom is steadier than what sits above it');
  assert.ok(bed.lvl > 0.5);
  // colors: three candidate degrees two octaves down; never two strong at once
  // (they would sit a few hertz apart and growl)
  for (let t = T0; t < T0 + 1800_000; t += 5000) {
    const p = r.frame(t).bed.parts, colors = [p[3].g, p[5].g, p[7].g].map(g => g / 0.35);
    assert.ok(colors.filter(g => g > 0.3).length <= 1, `two colors up at once: ${colors}`);
    assert.ok(p[0].g >= 1 && p[1].g > 0 && p[2].g > 0, 'the root and its octaves never leave');
  }
  assert.equal(cycles({ score: { start: T0 + 4000, comp: 1 } }).frame(T0 + 1000).bed.lvl, 0);
  assert.equal(cycles({ bed: 0 }).frame(T0 + 30_000).bed.lvl, 0);
});

// --- the weave: turns instead of rests -------------------------------------------------

test('the weave: the sound never stops, and every turn keeps tones in common', () => {
  const r = cycles();
  const plan = r._plan(), G = r.groups.length;
  assert.ok(G >= 5, `groups ${G}`);
  for (let n = 0; n < plan.length; n++) {
    const a = plan[n].in, b = plan[(n + 1) % plan.length].in;
    const kept = a.filter((v, i) => v && b[i]).length, changed = a.filter((v, i) => v !== b[i]).length;
    assert.ok(kept >= 1, `turn ${n} keeps nothing`);
    assert.ok(changed <= 3, `turn ${n} changes ${changed} groups`);
    assert.ok(b.filter(Boolean).length >= 2);
  }
  // and in sound: tones are always present, the anchor and the foundation always
  let minTones = Infinity, minIn = Infinity;
  for (let t = T0; t < T0 + 2400_000; t += 1000) {
    const fr = r.frame(t);
    minTones = Math.min(minTones, fr.voices.filter(v => v.role !== 'anchor').reduce((s, v) => s + v.level, 0));
    minIn = Math.min(minIn, fr.turn.groupsIn);
    assert.ok(fr.bed.lvl > 0.5);
  }
  assert.ok(minTones > 0.4, `quietest moment: tone levels sum to ${minTones}`);
  assert.ok(minIn >= 2);
});

test('the weave: incoming tones overlap outgoing ones at a turn', () => {
  const r = cycles({ phrase: 80 });
  // find turns where one group enters and another leaves; mid-turn both sound
  const plan = r._plan();
  let checked = 0;
  for (let m = 1; m < 12; m++) {
    const a = plan[m - 1].in, b = plan[m].in;
    const entering = a.findIndex((v, i) => !v && b[i]), leaving = a.findIndex((v, i) => v && !b[i]);
    if (entering < 0 || leaving < 0) continue;
    const gIn = r._gate(p => p.in[entering], m, 0), gOut = r._gate(p => p.in[leaving], m, 0);
    assert.ok(gIn > 0.6 && gOut > 0.6, `turn ${m}: entering ${gIn.toFixed(2)}, leaving ${gOut.toFixed(2)}`);
    checked++;
  }
  assert.ok(checked >= 3);
});

test('the weave: space sets how many tones rest; 0 keeps everything in; devices agree', () => {
  const share = space => {
    const r = cycles({ space });
    let s = 0, n = 0;
    for (let t = T0; t < T0 + 3600_000; t += 4000) { const fr = r.frame(t); s += fr.turn.groupsIn / fr.turn.groups; n++; }
    return s / n;
  };
  assert.equal(share(0), 1);
  const lo = share(0.3), hi = share(0.9);
  assert.ok(lo > hi && Math.abs(lo - 0.82) < 0.15 && Math.abs(hi - 0.46) < 0.15, `${lo} ${hi}`);
  const a = cycles(), b = cycles();
  for (let t = T0; t < T0 + 600_000; t += 7000) assert.deepEqual(a.frame(t).voices.map(v => v.tide), b.frame(t).voices.map(v => v.tide));
});

test('octave stacking gives the ring more pitches to trade', () => {
  const pitches = stack => new Set(cycles({ stack }).frame(T0 + 1000).voices.map(v => Math.round(v.f0))).size;
  assert.ok(pitches(1) > pitches(0), `${pitches(1)} vs ${pitches(0)}`);
});

// --- choir ---------------------------------------------------------------------------

test('choir: two singers per phone, drifting a few cents; the bottom stays exact', () => {
  const r = cycles({ fp: 0, bend: 0, rate: 0 });
  const seen = new Map();
  for (let t = T0; t < T0 + 600_000; t += 500) {
    const fr = r.frame(t);
    for (let k = 0; k < 8; k++) for (const p of r.playersAt(fr, k)) {
      assert.equal(p.singers.length, 2);
      assert.ok(Math.abs(p.singers[0].g ** 2 + p.singers[1].g ** 2 - 1) < 1e-9, 'two singers, same power as one');
      for (let s = 0; s < 2; s++) {
        const key = `${k}|${p.v}|${s}`;
        if (!seen.has(key)) seen.set(key, { f0: p.vc.f0, c: [] });
        seen.get(key).c.push(p.singers[s].detunes[0]);
        // a singer's partials move together (it stays one harmonic voice)
        assert.ok(Math.abs(p.singers[s].detunes[3] - p.singers[s].detunes[0]) < 1e-9);
      }
    }
  }
  const all = [...seen.values()].filter(x => x.c.length > 200 && x.f0 > 290);
  assert.ok(all.length > 10);
  const std = a => { const m = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
  // each singer wanders about 5 cents around its own seat; seats differ
  const wander = all.map(x => std(x.c)), seats = all.map(x => x.c.reduce((s, v) => s + v, 0) / x.c.length);
  const mean = wander.reduce((s, v) => s + v, 0) / wander.length;
  assert.ok(mean > 3.5 && mean < 7, `mean wander ${mean}`);
  assert.ok(std(seats) > 1.5 && Math.max(...all.flatMap(x => x.c.map(Math.abs))) < 22, `seat spread ${std(seats)}`);
  // slow: never more than a fraction of a cent between control ticks
  const fa = r.frame(T0 + 1000), fb = r.frame(T0 + 1050);
  const a = r.playersAt(fa, 2)[0], b = r.playersAt(fb, 2).find(p => p.v === a.v);
  assert.ok(Math.abs(a.singers[0].detunes[0] - b.singers[0].detunes[0]) < 0.6);
  // the bottom is exact
  assert.equal(r.singerCents(0, 0, 0, 55, T0 + 5000), 0);
  assert.equal(r.singerCents(0, 0, 0, 90, T0 + 5000), 0);
});

test('choir 0 is one exact voice per phone', () => {
  const r = cycles({ choir: 0, fp: 0, bend: 0, rate: 0 });
  const fr = r.frame(T0 + 9000);
  for (let k = 0; k < 8; k++) for (const p of r.playersAt(fr, k)) { assert.equal(p.singers.length, 1); assert.ok(p.detune === 0); }
});
