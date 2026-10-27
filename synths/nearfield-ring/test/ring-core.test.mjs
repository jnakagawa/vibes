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
function ring(over = {}) {
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
  assert.ok(Math.abs(next.frame(later).turns - r.frame(later).turns) < 1e-9);
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
  assert.deepEqual(NR.decodeState(NR.encodeState(st)), st);
  assert.ok(NR.encodeState(st).length < 600);
  assert.equal(NR.decodeState('garbage'), null);
});
