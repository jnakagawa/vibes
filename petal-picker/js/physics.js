// physics.js — Verlet soft-body simulation for petals.
//
// Each petal is a ROWS x COLS particle grid with distance constraints
// (structural + shear + weak bend). While attached, the base row is pinned to
// the flower head and every particle feels a weak "shape memory" spring toward
// its rest pose, so petals hold their shape but bend softly when pulled.
// Pull hard enough and the base strain tears the petal off; free petals get
// gravity + normal-velocity air damping, which makes them flutter like paper.

export const GRID = { ROWS: 9, COLS: 4 };
const N = GRID.ROWS * GRID.COLS;

export class PetalBody {
  // restLocal: Float32Array(N*3), positions in flower-head local space
  constructor(restLocal, index) {
    this.index = index;
    this.restLocal = restLocal;
    this.restWorld = new Float32Array(N * 3);
    this.pos = new Float32Array(N * 3);
    this.prev = new Float32Array(N * 3);
    this.attached = true;
    this.sleeping = false;
    this.sleepFrames = 0;
    this.tearTimer = 0;
    this.grab = null;            // { idx, x, y, z } world-space target
    this.geometry = null;        // set by builder; position attr shares this.pos
    this.mesh = null;
    this.phase = Math.random() * Math.PI * 2;
    this.gustF = 0.7 + Math.random() * 1.4;    // per-petal flutter frequency
    this.gustP = Math.random() * Math.PI * 2;

    // constraints
    const I = [], J = [], REST = [], K = [];
    const at = (r, c) => r * GRID.COLS + c;
    const dist = (a, b) => {
      const dx = restLocal[a * 3] - restLocal[b * 3];
      const dy = restLocal[a * 3 + 1] - restLocal[b * 3 + 1];
      const dz = restLocal[a * 3 + 2] - restLocal[b * 3 + 2];
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    };
    const add = (a, b, k) => { I.push(a); J.push(b); REST.push(dist(a, b)); K.push(k); };
    for (let r = 0; r < GRID.ROWS; r++) {
      for (let c = 0; c < GRID.COLS; c++) {
        const a = at(r, c);
        if (r + 1 < GRID.ROWS) add(a, at(r + 1, c), 1);            // structural length
        if (c + 1 < GRID.COLS) add(a, at(r, c + 1), 1);            // structural width
        if (r + 1 < GRID.ROWS && c + 1 < GRID.COLS) {              // shear
          add(a, at(r + 1, c + 1), 0.9);
          add(at(r, c + 1), at(r + 1, c), 0.9);
        }
        if (r + 2 < GRID.ROWS) add(a, at(r + 2, c), 0.35);         // bend length
        if (c + 2 < GRID.COLS) add(a, at(r, c + 2), 0.35);         // bend width
      }
    }
    this.cI = new Uint16Array(I);
    this.cJ = new Uint16Array(J);
    this.cRest = new Float32Array(REST);
    this.cK = new Float32Array(K);

    // base-row rest lengths (row0 -> row1) for tear strain
    this.rootRest = new Float32Array(GRID.COLS);
    for (let c = 0; c < GRID.COLS; c++) {
      this.rootRest[c] = dist(at(0, c), at(1, c));
    }
  }

  wake() { this.sleeping = false; this.sleepFrames = 0; }
}

export class PetalPhysics {
  constructor() {
    this.petals = [];
    this.onTear = null;
    this.time = 0;
    this.params = {
      gravity: 4.5,
      damping: 0.985,
      iters: 5,
      substeps: 2,
      kShape: 0.07,       // shape-memory spring (attached petals)
      kGrab: 0.5,
      tearDist: 0.18,     // world-unit gap between hand and petal that tears
      tearTime: 0.1,      // seconds of sustained over-pull to tear
      air: 0.5,           // normal-velocity damping on free petals -> flutter
      breeze: 0.35,
      groundY: 0.055,   // grass height: petals rest on the blades
      headCollider: null, // { x, y, z, r } world (set per frame by caller)
    };
  }

  add(petal, headEls) {
    transformAll(petal.restLocal, headEls, petal.pos);
    petal.prev.set(petal.pos);
    transformAll(petal.restLocal, headEls, petal.restWorld);
    this.petals.push(petal);
  }

  clear() { this.petals.length = 0; }

  attachedCount() {
    let n = 0;
    for (const p of this.petals) if (p.attached) n++;
    return n;
  }

  step(dt, headEls, time) {
    dt = Math.min(dt, 1 / 30);
    this.time = time;
    const P = this.params;
    const sub = P.substeps;
    const hdt = dt / sub;

    for (const petal of this.petals) {
      if (petal.sleeping && !petal.grab) continue;
      if (petal.attached) transformAll(petal.restLocal, headEls, petal.restWorld);
    }

    for (let s = 0; s < sub; s++) {
      for (const petal of this.petals) {
        if (petal.sleeping && !petal.grab) continue;
        this.integrate(petal, hdt, time + s * hdt);
        this.solve(petal);
        this.collide(petal);
        if (petal.attached) this.tearCheck(petal, hdt);
      }
    }

    // sleep bookkeeping (once per frame)
    for (const petal of this.petals) {
      if (petal.attached || petal.grab || petal.sleeping) continue;
      let vmax = 0;
      const { pos, prev } = petal;
      for (let i = 0; i < N * 3; i += 3) {
        const dx = pos[i] - prev[i], dy = pos[i + 1] - prev[i + 1], dz = pos[i + 2] - prev[i + 2];
        const v = dx * dx + dy * dy + dz * dz;
        if (v > vmax) vmax = v;
      }
      if (vmax < 6e-8) {
        if (++petal.sleepFrames > 50) petal.sleeping = true;
      } else petal.sleepFrames = 0;
    }
  }

  integrate(petal, hdt, t) {
    const P = this.params;
    const { pos, prev, restWorld, attached } = petal;
    const g = P.gravity * (attached ? 0.3 : 1);
    const hdt2 = hdt * hdt;
    const breeze = P.breeze;
    const normals = petal.geometry ? petal.geometry.attributes.normal.array : null;
    const air = attached ? 0.08 : P.air;
    const kShape = P.kShape;
    const start = attached ? GRID.COLS : 0;   // row 0 pinned while attached

    for (let i = start; i < N; i++) {
      const q = i * 3;
      const x = pos[q], y = pos[q + 1], z = pos[q + 2];
      let vx = (x - prev[q]) * P.damping;
      let vy = (y - prev[q + 1]) * P.damping;
      let vz = (z - prev[q + 2]) * P.damping;

      // flutter: damp velocity along the surface normal (paper falling)
      if (normals && air > 0) {
        const nx = normals[q], ny = normals[q + 1], nz = normals[q + 2];
        const vn = vx * nx + vy * ny + vz * nz;
        vx -= nx * vn * air;
        vy -= ny * vn * air;
        vz -= nz * vn * air;
      }

      // velocity clamp for stability
      const v2 = vx * vx + vy * vy + vz * vz;
      const VMAX = 0.09;
      if (v2 > VMAX * VMAX) {
        const f = VMAX / Math.sqrt(v2);
        vx *= f; vy *= f; vz *= f;
      }

      // accelerations
      const trow = ((i / GRID.COLS) | 0) / (GRID.ROWS - 1);   // 0 base -> 1 tip
      let ax, ay, az;
      if (attached) {
        // independent flutter: shared gust waves + per-petal flapping along
        // the surface normal, strongest at the tip (lever arm)
        const rowF = 0.2 + 1.7 * trow * trow;
        const gust = 0.6 + 0.4 * Math.sin(0.45 * t + petal.phase * 0.3) * Math.sin(0.9 * t + petal.gustP);
        const bg = breeze * gust * rowF;
        ax = bg * 8 * Math.sin(1.1 * t + y * 2.1 + petal.phase);
        ay = -g + bg * 5 * Math.sin(1.7 * t + x * 1.3 + petal.phase);
        az = bg * 6 * Math.cos(0.9 * t + z * 1.8 + petal.phase * 1.7);
        if (normals) {
          const flap = bg * (26 * Math.sin(petal.gustF * 2.2 * t + petal.gustP + trow * 2.4)
            + 12 * Math.sin(3.9 * t + petal.gustP * 1.9));
          ax += normals[q] * flap;
          ay += normals[q + 1] * flap;
          az += normals[q + 2] * flap;
        }
      } else {
        // falling/grounded: gusty drift, fading in the boundary layer near
        // the ground so petals can come to rest
        const hf = Math.min(1, Math.max(0.2, (y - P.groundY) * 3));
        const bh = breeze * hf;
        ax = bh * (8 * Math.sin(1.1 * t + y * 2.1 + petal.phase) + 6 * Math.sin(2.3 * t + petal.phase * 3));
        ay = -g + bh * 4 * Math.sin(1.7 * t + x * 1.3 + petal.phase);
        az = bh * (6 * Math.cos(0.9 * t + z * 1.8 + petal.phase * 1.7) + 5 * Math.cos(1.9 * t + petal.phase * 2));
      }

      prev[q] = x; prev[q + 1] = y; prev[q + 2] = z;
      pos[q] = x + vx + ax * hdt2;
      pos[q + 1] = y + vy + ay * hdt2;
      pos[q + 2] = z + vz + az * hdt2;

      // shape memory toward rest pose, looser toward the tip so it can waggle
      if (attached) {
        const ks = kShape * (1 - 0.55 * trow);
        pos[q] += (restWorld[q] - pos[q]) * ks;
        pos[q + 1] += (restWorld[q + 1] - pos[q + 1]) * ks;
        pos[q + 2] += (restWorld[q + 2] - pos[q + 2]) * ks;
      }
    }

    // pinned base row follows the head exactly
    if (attached) {
      for (let i = 0; i < GRID.COLS; i++) {
        const q = i * 3;
        pos[q] = prev[q] = restWorld[q];
        pos[q + 1] = prev[q + 1] = restWorld[q + 1];
        pos[q + 2] = prev[q + 2] = restWorld[q + 2];
      }
    }

    // grab spring
    if (petal.grab) {
      const gq = petal.grab.idx * 3;
      const k = P.kGrab;
      pos[gq] += (petal.grab.x - pos[gq]) * k;
      pos[gq + 1] += (petal.grab.y - pos[gq + 1]) * k;
      pos[gq + 2] += (petal.grab.z - pos[gq + 2]) * k;
    }
  }

  solve(petal) {
    const P = this.params;
    const { pos, cI, cJ, cRest, cK, attached } = petal;
    const pinnedBelow = attached ? GRID.COLS : 0;
    for (let iter = 0; iter < P.iters; iter++) {
      for (let c = 0; c < cI.length; c++) {
        const i = cI[c], j = cJ[c];
        const qi = i * 3, qj = j * 3;
        let dx = pos[qj] - pos[qi];
        let dy = pos[qj + 1] - pos[qi + 1];
        let dz = pos[qj + 2] - pos[qi + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 1e-9) continue;
        const wi = i < pinnedBelow ? 0 : 1;
        const wj = j < pinnedBelow ? 0 : 1;
        const wsum = wi + wj;
        if (!wsum) continue;
        const diff = (d - cRest[c]) / d * cK[c] / wsum;
        dx *= diff; dy *= diff; dz *= diff;
        if (wi) { pos[qi] += dx; pos[qi + 1] += dy; pos[qi + 2] += dz; }
        if (wj) { pos[qj] -= dx; pos[qj + 1] -= dy; pos[qj + 2] -= dz; }
      }
    }
  }

  collide(petal) {
    const P = this.params;
    const { pos, prev } = petal;
    const gy = P.groundY;
    for (let i = 0; i < N; i++) {
      const q = i * 3;
      if (pos[q + 1] < gy) {
        const vy = pos[q + 1] - prev[q + 1];
        pos[q + 1] = gy;
        prev[q + 1] = gy + vy * 0.15;                      // tiny bounce
        prev[q] += (pos[q] - prev[q]) * 0.55;              // friction
        prev[q + 2] += (pos[q + 2] - prev[q + 2]) * 0.55;
      }
    }
    // keep free petals out of the flower head
    const hc = P.headCollider;
    if (hc && !petal.attached) {
      for (let i = 0; i < N; i++) {
        const q = i * 3;
        const dx = pos[q] - hc.x, dy = pos[q + 1] - hc.y, dz = pos[q + 2] - hc.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < hc.r * hc.r && d2 > 1e-12) {
          const d = Math.sqrt(d2);
          const f = hc.r / d;
          pos[q] = hc.x + dx * f;
          pos[q + 1] = hc.y + dy * f;
          pos[q + 2] = hc.z + dz * f;
        }
      }
    }
  }

  // tear when the hand pulls the grab target beyond where the petal can
  // physically reach (constraints absorb stretch, so measure the gap between
  // the hand target and the grabbed particle, not internal strain)
  tearCheck(petal, hdt) {
    const P = this.params;
    if (!petal.grab) {
      petal.tearTimer = Math.max(0, petal.tearTimer - hdt * 2);
      return;
    }
    const { pos, restWorld, grab } = petal;
    const gq = grab.idx * 3;
    const dx = grab.x - pos[gq], dy = grab.y - pos[gq + 1], dz = grab.z - pos[gq + 2];
    const gap = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // root center (average of the pinned row)
    let rx = 0, ry = 0, rz = 0;
    for (let c = 0; c < GRID.COLS; c++) {
      rx += restWorld[c * 3]; ry += restWorld[c * 3 + 1]; rz += restWorld[c * 3 + 2];
    }
    rx /= GRID.COLS; ry /= GRID.COLS; rz /= GRID.COLS;
    const dTarget = Math.hypot(grab.x - rx, grab.y - ry, grab.z - rz);
    const dPart = Math.hypot(pos[gq] - rx, pos[gq + 1] - ry, pos[gq + 2] - rz);
    const outward = dTarget > dPart;

    if (gap > P.tearDist && outward) petal.tearTimer += hdt;
    else petal.tearTimer = Math.max(0, petal.tearTimer - hdt * 2);

    if (petal.tearTimer > P.tearTime || (outward && gap > P.tearDist * 2.2)) {
      this.detach(petal);
    }
  }

  detach(petal) {
    if (!petal.attached) return;
    petal.attached = false;
    petal.tearTimer = 0;
    petal.wake();
    if (this.onTear) this.onTear(petal);
  }
}

function transformAll(local, e, out) {
  for (let i = 0; i < N; i++) {
    const q = i * 3;
    const x = local[q], y = local[q + 1], z = local[q + 2];
    out[q] = e[0] * x + e[4] * y + e[8] * z + e[12];
    out[q + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    out[q + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
}
