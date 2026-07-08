// audio.js — synthesized sound design, no assets.
//
// Each picked petal plays a warm marimba-ish pluck walking up a major
// pentatonic scale (rising anticipation as the flower empties), layered with
// a tiny paper-rip. Everything runs through a gentle echo + compressor.

const PENTATONIC = [0, 2, 4, 7, 9];   // semitones over the root
const ROOT_HZ = 293.66;               // D4

export class Sound {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = this.ctx = new AC();

      this.master = ctx.createGain();
      this.master.gain.value = 0.7;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 4;
      this.master.connect(comp).connect(ctx.destination);

      // soft echo send for a little air
      this.send = ctx.createGain();
      this.send.gain.value = 0.16;
      const delay = ctx.createDelay(0.5);
      delay.delayTime.value = 0.16;
      const fb = ctx.createGain();
      fb.gain.value = 0.32;
      const damp = ctx.createBiquadFilter();
      damp.type = 'lowpass';
      damp.frequency.value = 1600;
      this.send.connect(delay);
      delay.connect(damp).connect(fb).connect(delay);
      damp.connect(this.master);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  out(node, echo = true) {
    node.connect(this.master);
    if (echo) node.connect(this.send);
  }

  // warm pluck: triangle fundamental + soft octave & 12th partials, lowpassed
  note(freq, t0, vol = 0.22, dur = 0.9) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(freq * 6, 3200);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(vol, t0 + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
    lp.connect(env);
    this.out(env);

    for (const [mult, g, d] of [[1, 1, dur], [2, 0.35, dur * 0.5], [3.01, 0.12, dur * 0.25]]) {
      const osc = ctx.createOscillator();
      osc.type = mult === 1 ? 'triangle' : 'sine';
      osc.frequency.value = freq * mult;
      const og = ctx.createGain();
      og.gain.setValueAtTime(g, t0);
      og.gain.exponentialRampToValueAtTime(0.001, t0 + d);
      osc.connect(og).connect(lp);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    }
  }

  rip(t0, vol = 0.07) {
    const ctx = this.ctx;
    const dur = 0.07;
    const src = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) {
      ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / ch.length, 1.6);
    }
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(2400, t0);
    bp.frequency.exponentialRampToValueAtTime(800, t0 + dur);
    bp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(bp).connect(g);
    this.out(g, false);
    src.start(t0);
  }

  // pick = 1-based count of petals picked so far
  tear(pick) {
    if (!this.enabled || !this.ctx) return;
    const t0 = this.ctx.currentTime;
    const idx = pick - 1;
    const semis = PENTATONIC[idx % 5] + 12 * (Math.floor(idx / 5) % 2);
    this.note(ROOT_HZ * Math.pow(2, semis / 12), t0, 0.22);
    this.rip(t0);
  }

  grab() {
    if (!this.enabled || !this.ctx) return;
    const ctx = this.ctx, t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 740;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.035, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.05);
    osc.connect(g);
    this.out(g, false);
    osc.start(t0);
    osc.stop(t0 + 0.06);
  }

  // verdict arpeggio: major lift for "loves me", wistful minor for "not"
  chord(lovesMe) {
    if (!this.enabled || !this.ctx) return;
    const t0 = this.ctx.currentTime + 0.05;
    const semisList = lovesMe ? [0, 4, 7, 12] : [0, 3, 7, 10];
    semisList.forEach((s, k) => {
      this.note(ROOT_HZ * Math.pow(2, s / 12), t0 + k * 0.13, 0.18, 1.6);
    });
  }
}
