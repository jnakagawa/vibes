// §14 interference topography — the phone's main screen, ported from the iOS
// app (nearfield-ios/NearfieldEnsemble/visual.html): same shader, sources,
// wavelengths, density, breath and beat-rate fringe drift. play.html pushes
// state via update(); this layer smooths per frame.
//
// Ring-specific changes, because a ring phone's voice is handed on:
// - The phone's own field is up to two voice layers on the same six sources,
//   weighted by how much of each voice the phone is playing. A handoff is a
//   crossfade between the two voices' topographies (their superposition
//   mid-way, as in the air) — nothing is swapped or rescaled.
// - Layers and peers keep their slot until they have faded out, so no
//   frame ever replaces one source with another.
// - The lines take a color (`color`, white by default) that glides.
(function (root) {
  'use strict';

  function fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const LAYERS = 2, PEERS = 3;

  const FS = `
#extension GL_OES_standard_derivatives : enable
precision highp float;
uniform vec2 res;
uniform float ink, density, breathScale;
uniform vec3 lineCol;
uniform vec2 meC[6];
uniform float meLam[12], meW[12];
uniform vec2 peerC[3];
uniform float peerLam[3], peerW[3], peerPhase[3];
float hair(float v, float n, float w) {
  float q = v * n;
  float d = abs(fract(q) - 0.5) / (fwidth(q) + 1e-5);
  return 1.0 - smoothstep(w, w + 1.0, d);
}
void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*res) / min(res.x, res.y);
  uv *= breathScale;
  float v = 0.0; float g = 1e-4;
  for (int k = 0; k < 6; k++) {
    float r = length(uv - meC[k]);
    v += meW[k] * cos(6.2831853 * r / meLam[k]) + meW[k + 6] * cos(6.2831853 * r / meLam[k + 6]);
    g += meW[k] + meW[k + 6];
  }
  for (int j = 0; j < 3; j++) {
    v += peerW[j] * cos(6.2831853 * length(uv - peerC[j]) / peerLam[j] + peerPhase[j]);
    g += peerW[j];
  }
  v = v / g;
  float c = hair(v, density, 0.7);
  gl_FragColor = vec4(mix(vec3(1.0 - c), lineCol * c, ink), 1.0);
}`;

  const lamFor = f => Math.max(0.32 * Math.pow(220 / f, 0.7), 0.06);
  function pairBeatHz(fA, fB, ratios) {
    let best = Infinity;
    for (const ri of ratios) for (const rj of ratios) {
      const d = Math.abs(fA * ri - fB * rj);
      if (d < best) best = d;
    }
    return best < 25 ? best : 0.04;
  }
  const srcSpec = [
    { pk: 0, w: 1.0 }, { pk: 0, w: 0.65 }, { pk: 0, w: 0.45 },
    { pk: 1, w: 1.0 }, { pk: 2, w: 1.0 }, { pk: 3, w: 1.0 },
  ];

  // Persistent slots: an item keeps its slot while it is wanted or still
  // fading; a new item only takes a slot that is empty or faded out.
  function assignSlots(slots, wanted, weightOf, eps) {
    const byId = new Map(wanted.map(x => [x.id, x]));
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (s) s.want = byId.get(s.id) || null;
      if (s && !s.want && weightOf(s) < eps) slots[i] = null;
    }
    const held = new Set(slots.filter(Boolean).map(s => s.id));
    for (const x of [...wanted].sort((a, b) => b.w - a.w)) {
      if (held.has(x.id)) continue;
      const free = slots.findIndex(s => !s || (!s.want && weightOf(s) < eps * 4));
      if (free < 0) break;
      slots[free] = { id: x.id, want: x, sm: 0, gains: [0, 0, 0, 0], logF: Math.log2(x.f), phase: 0 };
      held.add(x.id);
    }
  }

  function create(canvas) {
    const gl = canvas.getContext('webgl', { antialias: true });
    if (!gl) return null;
    gl.getExtension('OES_standard_derivatives');
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, 'attribute vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }'));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = innerWidth * dpr;
      canvas.height = innerHeight * dpr;
    }
    addEventListener('resize', resize);
    resize();

    let cfg = null, centers = [];
    // voices: [{id, f, w, gains}] sounding here; peers: [{id, e, freq}]
    let S = { voices: [], peers: [], W: 0, fpAmp: 1, breathPhase: 0,
              ratios: [1, 2.07, 3.2, 4.4], color: [1, 1, 1] };
    let layers = new Array(LAYERS).fill(null), peers = new Array(PEERS).fill(null);
    let visDensity = null, visCol = [1, 1, 1];
    let lastT = null;

    function frame(ms) {
      requestAnimationFrame(frame);
      if (!cfg) return;
      const t = ms / 1000;
      const dt = lastT === null ? 0.016 : Math.min(t - lastT, 0.05);
      lastT = t;
      const alpha = tau => 1 - Math.exp(-dt / tau);

      // own field: voice layers crossfade by share
      assignSlots(layers, S.voices, l => l.sm, 0.01);
      let wSum = 0;
      for (const l of layers) {
        if (!l) continue;
        const tw = l.want ? l.want.w : 0;
        l.sm += (tw - l.sm) * alpha(1.2);   // slow next to a handoff (~5–8 s), never a jolt
        if (l.want) l.logF += (Math.log2(l.want.f) - l.logF) * alpha(1.0);
        for (let p = 0; p < 4; p++) l.gains[p] += ((l.want ? l.want.gains[p] : l.gains[p]) - l.gains[p]) * alpha(0.6);
        wSum += l.sm;
      }
      const norm = wSum > 1e-3 ? 1 / wSum : 0;
      let lead = null;
      for (const l of layers) if (l && (!lead || l.sm > lead.sm)) lead = l;
      const fMe = lead ? Math.pow(2, lead.logF) : 220;

      const meC = [], meLam = new Array(12).fill(1), meW = new Array(12).fill(0);
      for (let k = 0; k < 6; k++) {
        const c = centers[k];
        let x = c.x + 0.06 * Math.sin(t * c.rate + c.wob);
        let y = c.y + 0.06 * Math.cos(t * c.rate * 0.9 + c.wob);
        x *= S.fpAmp; y *= S.fpAmp;   // final-gong convergence (§14.1)
        meC.push(x, y);
        const spec = srcSpec[k];
        for (let L = 0; L < LAYERS; L++) {
          const l = layers[L];
          if (!l) continue;
          meLam[L * 6 + k] = lamFor(Math.pow(2, l.logF) * S.ratios[spec.pk]);
          meW[L * 6 + k] = l.gains[spec.pk] * spec.w * l.sm * norm;
        }
      }

      // peers: persistent slots, slow fades, drift at the audible beat
      assignSlots(peers, S.peers.map(p => ({ ...p, w: p.e, f: p.freq })), p => p.sm, 0.01);
      const peerC = [], peerLam = [], peerW = [], peerPhase = [];
      for (let j = 0; j < PEERS; j++) {
        const p = peers[j];
        if (!p) { peerC.push(9, 9); peerLam.push(1); peerW.push(0); peerPhase.push(0); continue; }
        p.sm += ((p.want ? p.want.e : 0) - p.sm) * alpha(1.5);
        if (p.want) p.logF += (Math.log2(p.want.freq) - p.logF) * alpha(1.0);
        const freq = Math.pow(2, p.logF);
        const ang = (fnv1a(`${p.id}|azimuth`) % 6283) / 1000;
        const rad = 1.9 - 0.7 * p.sm;
        peerC.push(Math.cos(ang) * rad, Math.sin(ang) * rad);
        peerLam.push(lamFor(freq));
        peerW.push(p.sm);
        const beat = 1.2 * Math.tanh(pairBeatHz(fMe, freq, S.ratios) / 1.2);
        p.phase += 2 * Math.PI * beat * dt;
        peerPhase.push(p.phase);
      }

      const densTarget = 2 + 2 * S.W;
      visDensity = visDensity === null ? densTarget : visDensity + (densTarget - visDensity) * alpha(0.5);
      const col = S.color || [1, 1, 1];
      for (let i = 0; i < 3; i++) visCol[i] += (col[i] - visCol[i]) * alpha(1.2);

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(prog);
      const loc = n => gl.getUniformLocation(prog, n);
      gl.uniform2f(loc('res'), canvas.width, canvas.height);
      gl.uniform1f(loc('ink'), cfg.ink ?? 1);
      gl.uniform1f(loc('density'), visDensity);
      gl.uniform1f(loc('breathScale'), 1 + 0.02 * Math.sin(S.breathPhase));
      gl.uniform3fv(loc('lineCol'), visCol);
      gl.uniform2fv(loc('meC'), meC);
      gl.uniform1fv(loc('meLam'), meLam);
      gl.uniform1fv(loc('meW'), meW);
      gl.uniform2fv(loc('peerC'), peerC);
      gl.uniform1fv(loc('peerLam'), peerLam);
      gl.uniform1fv(loc('peerW'), peerW);
      gl.uniform1fv(loc('peerPhase'), peerPhase);
      const pAttr = gl.getAttribLocation(prog, 'p');
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(pAttr);
      gl.vertexAttribPointer(pAttr, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    requestAnimationFrame(frame);

    return {
      init(c) {
        cfg = c;
        const r = mulberry32(fnv1a(c.seedString));
        centers = Array.from({ length: 6 }, () => {
          const ang = r() * Math.PI * 2, rad = 1.3 + r() * 0.5;
          return { x: Math.cos(ang) * rad, y: Math.sin(ang) * rad,
                   wob: r() * Math.PI * 2, rate: 0.03 + r() * 0.04 };
        });
        layers = new Array(LAYERS).fill(null); peers = new Array(PEERS).fill(null);
        visDensity = null; visCol = [1, 1, 1];
      },
      update(s) { S = s; },
      // for tests: the smoothed weights in each slot
      debug() { return { layers: layers.map(l => l && { id: l.id, sm: l.sm }), peers: peers.map(p => p && { id: p.id, sm: p.sm }) }; },
    };
  }

  root.NearfieldVisual = { create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
