// analyzer.js — turns a flower photo into a buildable flower description.
//
// Pipeline (all in-browser, no server):
//   1. separate flower from background (color distance from border pixels + Otsu)
//   2. largest connected blob -> centroid + radial extent profile r(theta)
//   3. petal lobes = local maxima of r(theta)  -> count, angle, length per petal
//   4. disk (flower center) radius from where color turns petal-like
//   5. per-petal textures sampled from the photo in polar wedges (with alpha
//      cutouts from the mask) so the 3D flower literally wears the input photo.

const RAYS = 720;

export function analyzeFlower(img) {
  const work = rasterize(img, 420);   // analysis resolution
  const hi = rasterize(img, 1000);    // texture-sampling resolution
  const { w, h, data } = work;

  // ---- 1. flower mask --------------------------------------------------------
  // Primary: the flower is the dominant saturated hue in the interior that is
  // NOT common along the border (border hues = background: sky, foliage).
  // Fallback (pale flowers): color distance from the border's median color.
  const seg = segmentByHue(data, w, h) || segmentByBorderDistance(data, w, h);
  let mask = seg.mask;
  const strongMask = seg.strong;   // pre-grow: the disk is still a hole here

  // ---- 2. largest connected component + fill holes + centroid ---------------
  const comp = largestComponent(mask, w, h);
  let ok = true;
  let ringMask = mask;                // pre-fill mask: petal pixels only
  if (!comp || comp.size < w * h * 0.015) ok = false;
  else {
    ringMask = comp.mask.slice();
    mask = comp.mask;
    fillHoles(mask, w, h);            // the disk may be a different hue: keep it
  }

  let cx = w / 2, cy = h / 2;
  if (ok) {
    let sx = 0, sy = 0, n = 0;
    for (let i = 0; i < w * h; i++) {
      if (mask[i]) { sx += i % w; sy += (i / w) | 0; n++; }
    }
    cx = sx / n; cy = sy / n;
  }

  // radial profile
  const r = new Float32Array(RAYS);
  if (ok) {
    const maxR = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
    for (let i = 0; i < RAYS; i++) {
      const a = (i / RAYS) * Math.PI * 2;
      const dx = Math.cos(a), dy = Math.sin(a);
      let last = 0;
      for (let t = 2; t < maxR; t += 1) {
        const x = Math.round(cx + dx * t), y = Math.round(cy + dy * t);
        if (x < 0 || y < 0 || x >= w || y >= h) break;
        if (mask[y * w + x]) last = t;
      }
      r[i] = last;
    }
  }
  const rs = circularSmooth(r, 5);
  let R = percentile(rs, 0.92);
  if (!ok || R < 18) {
    ok = false;
    R = 0.42 * Math.min(w, h);
  }

  // ---- petal ring color ------------------------------------------------------
  const petalPix = samplesInAnnulus(data, mask, w, h, cx, cy, 0.5 * R, 0.88 * R, ok);
  const petalColor = petalPix.length ? medianColor(petalPix) : [230, 190, 60];
  const petalHSV = rgb2hsv(petalColor[0], petalColor[1], petalColor[2]);

  // ---- 4. disk radius --------------------------------------------------------
  // The disk is the contiguous region around the center that matches the
  // center's color; walk outward until the color stops matching.
  let Rd = 0.16 * R, diskColor = [90, 60, 30];
  if (ok) {
    const centerPix = samplesInAnnulus(data, mask, w, h, cx, cy, 0, 0.08 * R, false);
    if (centerPix.length > 10) diskColor = medianColor(centerPix);
    // disk edge = where confident petal-hue pixels begin on each ray
    // (strong pre-grow mask: the disk is still a hole in it)
    const cand = [];
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      const dx = Math.cos(a), dy = Math.sin(a);
      for (let t = 2; t < 0.85 * R; t += 1) {
        let hits = 0;
        for (let k = 0; k < 5; k++) {
          const xx = Math.round(cx + dx * (t + k)), yy = Math.round(cy + dy * (t + k));
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) break;
          if (strongMask[yy * w + xx]) hits++;
        }
        if (hits >= 4) { cand.push(t); break; }
      }
    }
    if (cand.length >= 8) Rd = median(cand);
    else Rd = 0.14 * R;
    Rd = Math.min(Math.max(Rd, 0.08 * R), 0.55 * R);
  }

  // soften the ring mask for texture alpha: close speckle holes from shaded
  // petal pixels that fell below the saturation threshold
  const alphaMask = dilate(ringMask, w, h, 2);

  // ---- 3. petal lobes --------------------------------------------------------
  let lobes = [];
  if (ok) {
    const win = 10;                       // +-5 degrees
    const floor = Rd + 0.3 * (R - Rd);    // tip must reach beyond mid-petal
    for (let i = 0; i < RAYS; i++) {
      const v = rs[i];
      if (v < floor) continue;
      let isMax = true;
      for (let k = -win; k <= win && isMax; k++) {
        if (k === 0) continue;
        const u = rs[(i + k + RAYS) % RAYS];
        if (k < 0 ? u > v : u >= v) isMax = false;
      }
      if (isMax) lobes.push({ angle: (i / RAYS) * Math.PI * 2, lenNorm: Math.min(v / R, 1.08) });
    }
    // merge scallops: petal-edge wiggles create clusters of shallow maxima.
    // Iteratively drop the weaker of two adjacent peaks whose separating
    // valley is shallow — real petal notches are deep and survive.
    const valleyBetween = (a, b) => {
      let ia = Math.round(a.angle / (Math.PI * 2) * RAYS);
      let ib = Math.round(b.angle / (Math.PI * 2) * RAYS);
      if (ib <= ia) ib += RAYS;
      let valley = Infinity;
      for (let j = ia; j <= ib; j++) valley = Math.min(valley, rs[j % RAYS]);
      return valley;
    };
    let merged = true;
    while (merged && lobes.length > 3) {
      merged = false;
      let worst = -1, worstSep = Infinity;
      for (let i = 0; i < lobes.length; i++) {
        const a = lobes[i], b = lobes[(i + 1) % lobes.length];
        const sep = Math.min(a.lenNorm, b.lenNorm) * R - valleyBetween(a, b);
        if (sep < worstSep) { worstSep = sep; worst = i; }
      }
      if (worstSep < 0.045 * R) {
        const a = lobes[worst], b = lobes[(worst + 1) % lobes.length];
        lobes.splice(lobes.indexOf(a.lenNorm >= b.lenNorm ? b : a), 1);
        merged = true;
      }
    }
  }
  // tame outlier lobe lengths (stray background snags, merged neighbors)
  if (lobes.length > 3) {
    const med = median(lobes.map(l => l.lenNorm));
    for (const l of lobes) {
      l.lenNorm = Math.min(Math.max(l.lenNorm, med * 0.82), med * 1.15);
    }
  }
  if (lobes.length < 4 || lobes.length > 44) {
    const n = 21;
    lobes = [];
    for (let i = 0; i < n; i++) {
      lobes.push({ angle: (i / n) * Math.PI * 2, lenNorm: 0.97 + 0.06 * Math.sin(i * 2.4) });
    }
  }
  lobes.sort((a, b) => a.angle - b.angle);

  const hiScale = hi.w / w;   // work -> hi coordinate factor

  // ---- texture bakers --------------------------------------------------------

  // Petal texture for a wedge of the photo centered on imgAngle.
  // v=0 (bottom row of canvas, three.js flipY) is the petal base near the disk.
  function makePetalTexture(imgAngle, wedgeAngle, tipNorm) {
    const TW = 128, TH = 256;
    const cv = document.createElement('canvas');
    cv.width = TW; cv.height = TH;
    const ctx = cv.getContext('2d');
    const out = ctx.createImageData(TW, TH);
    const o = out.data;
    const rootR = Rd * 1.0, tipR = Math.max(tipNorm * R, rootR + 8);
    let covered = 0;
    for (let y = 0; y < TH; y++) {
      const v = 1 - y / (TH - 1);                       // canvas bottom = base
      const rad = rootR + v * (tipR - rootR);
      for (let x = 0; x < TW; x++) {
        const u = x / (TW - 1);
        const ang = imgAngle - (u - 0.5) * wedgeAngle;
        const sx = cx + Math.cos(ang) * rad;
        const sy = cy + Math.sin(ang) * rad;
        const q = (y * TW + x) * 4;
        const inBounds = sx >= 0 && sy >= 0 && sx < w && sy < h;
        const mi = inBounds ? Math.round(sy) * w + Math.round(sx) : -1;
        // near the disk the filled mask keeps bases solid; further out only
        // true petal pixels (ring mask) are opaque so tips keep their shape
        const opaque = inBounds && (rad < Rd * 1.2 ? mask[mi] : alphaMask[mi]);
        if (inBounds) {
          sampleBilinear(hi.data, hi.w, hi.h, sx * hiScale, sy * hiScale, o, q);
        } else {
          o[q] = petalColor[0]; o[q + 1] = petalColor[1]; o[q + 2] = petalColor[2];
        }
        if (opaque) covered++;
        o[q + 3] = opaque || v < 0.14 ? 255 : 0;        // base always attached
      }
    }
    const coverage = covered / (TW * TH);
    if (coverage < 0.2) {
      // photo did not give us a silhouette here -> procedural lanceolate shape
      for (let y = 0; y < TH; y++) {
        const v = 1 - y / (TH - 1);
        const half = 0.5 * Math.pow(Math.sin((0.1 + 0.9 * v) * Math.PI), 0.75);
        for (let x = 0; x < TW; x++) {
          const u = x / (TW - 1);
          const q = (y * TW + x) * 4;
          o[q + 3] = Math.abs(u - 0.5) < Math.max(half, v < 0.14 ? 0.2 : 0) ? 255 : 0;
        }
      }
    }
    ctx.putImageData(out, 0, 0);
    return { canvas: cv, coverage };
  }

  function makeDiskTexture() {
    const S = 256;
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = `rgb(${diskColor[0]},${diskColor[1]},${diskColor[2]})`;
    ctx.fillRect(0, 0, S, S);
    const crop = 1.04 * Rd * hiScale;
    const hx = cx * hiScale, hy = cy * hiScale;
    ctx.drawImage(hi.canvas, hx - crop, hy - crop, crop * 2, crop * 2, 0, 0, S, S);
    // soft circular cutoff
    const g = ctx.createRadialGradient(S / 2, S / 2, S * 0.42, S / 2, S / 2, S * 0.5);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = `rgb(${diskColor[0]},${diskColor[1]},${diskColor[2]})`;
    ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2); ctx.fill();
    return cv;
  }

  // diagnostic view: mask tint + detected center/disk/extent/lobe tips
  function makeDebugCanvas() {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const dctx = cv.getContext('2d');
    dctx.drawImage(work.canvas, 0, 0);
    const im = dctx.getImageData(0, 0, w, h);
    for (let i = 0; i < w * h; i++) {
      if (ringMask[i]) im.data[i * 4] = Math.min(255, im.data[i * 4] + 100);
      else if (mask[i]) im.data[i * 4 + 2] = Math.min(255, im.data[i * 4 + 2] + 100);
      else { im.data[i * 4] *= 0.35; im.data[i * 4 + 1] *= 0.35; im.data[i * 4 + 2] *= 0.35; }
    }
    dctx.putImageData(im, 0, 0);
    dctx.lineWidth = 2;
    dctx.strokeStyle = 'cyan';
    dctx.beginPath(); dctx.arc(cx, cy, Rd, 0, Math.PI * 2); dctx.stroke();
    dctx.strokeStyle = 'yellow';
    dctx.beginPath(); dctx.arc(cx, cy, R, 0, Math.PI * 2); dctx.stroke();
    dctx.fillStyle = 'lime';
    for (const l of lobes) {
      dctx.beginPath();
      dctx.arc(cx + Math.cos(l.angle) * l.lenNorm * R, cy + Math.sin(l.angle) * l.lenNorm * R, 4, 0, Math.PI * 2);
      dctx.fill();
    }
    return cv;
  }

  return {
    ok,
    count: lobes.length,
    lobes,
    rdNorm: Math.min(Math.max(Rd / R, 0.1), 0.55),
    petalColor, diskColor,
    makePetalTexture, makeDiskTexture, makeDebugCanvas,
  };
}

// ---------------- helpers ----------------

function rasterize(img, maxDim) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const s = Math.min(1, maxDim / Math.max(iw, ih));
  const w = Math.max(2, Math.round(iw * s)), h = Math.max(2, Math.round(ih * s));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  return { canvas, ctx, w, h, data: ctx.getImageData(0, 0, w, h).data };
}

// Dominant saturated hue that is rare along the border and concentrated near
// the image center -> flower. Tries the top-scoring hues in order and rejects
// candidates whose blob hugs the image border (background signature).
// Returns a mask, or null so the caller falls back to border-color distance.
function segmentByHue(data, w, h) {
  const BINS = 36;
  const borderHist = new Float64Array(BINS);
  const innerHist = new Float64Array(BINS);
  const hue = new Float32Array(w * h);
  const sat = new Float32Array(w * h);
  const val = new Float32Array(w * h);
  const bt = Math.max(4, Math.round(Math.min(w, h) * 0.04));
  const cx = w / 2, cy = h / 2, dim = Math.min(w, h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, p = i * 4;
      const c = rgb2hsv(data[p], data[p + 1], data[p + 2]);
      hue[i] = c.h; sat[i] = c.s; val[i] = c.v;
      if (c.s < 0.3 || c.v < 0.2) continue;
      const b = Math.min(BINS - 1, (c.h / 360 * BINS) | 0);
      if (x < bt || y < bt || x >= w - bt || y >= h - bt) {
        borderHist[b] += c.s * c.v;
      } else {
        // center-weighted: the flower is usually the subject
        const d = Math.hypot(x - cx, y - cy) / dim;
        innerHist[b] += c.s * c.v * Math.exp(-(d * d) / (2 * 0.45 * 0.45));
      }
    }
  }
  const innerSum = innerHist.reduce((a, b) => a + b, 0);
  const borderSum = borderHist.reduce((a, b) => a + b, 0) || 1;
  if (innerSum < w * h * 0.015) return null;     // not enough colorful interior

  const at = (k) => (k + BINS) % BINS;
  const ranked = [];
  for (let b = 0; b < BINS; b++) {
    const inner = innerHist[at(b - 1)] * 0.5 + innerHist[b] + innerHist[at(b + 1)] * 0.5;
    const border = borderHist[at(b - 1)] * 0.5 + borderHist[b] + borderHist[at(b + 1)] * 0.5;
    ranked.push({ b, score: inner / innerSum - 1.4 * (border / borderSum) });
  }
  ranked.sort((a, b) => b.score - a.score);

  for (const { b, score } of ranked.slice(0, 4)) {
    if (score <= 0) break;
    const flowerHue = (b + 0.5) / BINS * 360;
    const mask = new Uint8Array(w * h);
    let count = 0;
    for (let i = 0; i < w * h; i++) {
      if (sat[i] > 0.28 && val[i] > 0.18 && hueDist(hue[i], flowerHue) < 35) {
        mask[i] = 1; count++;
      }
    }
    if (count < w * h * 0.012) continue;
    const comp = largestComponent(mask, w, h);
    if (!comp || comp.size < w * h * 0.012) continue;
    // background blobs run along the border; flowers rarely do
    let touch = 0;
    for (let x = 0; x < w; x++) touch += comp.mask[x] + comp.mask[(h - 1) * w + x];
    for (let y = 0; y < h; y++) touch += comp.mask[y * w] + comp.mask[y * w + w - 1];
    if (touch > (w + h) * 2 * 0.18) continue;

    // hysteresis grow: shaded petals are desaturated but still weakly match
    // the flower hue and stay CONNECTED to the confident blob; background
    // bokeh doesn't. Cap growth as a runaway guard. Keep the pre-grow mask
    // too: the grow can absorb the center disk, which disk detection needs
    // to stay a hole.
    const strong = comp.mask.slice();
    const grown = comp.mask;
    const queue = new Int32Array(w * h);
    let tail = 0;
    for (let i = 0; i < w * h; i++) if (grown[i]) queue[tail++] = i;
    let head = 0, added = 0;
    const budget = comp.size * 2.5;
    const weak = (i) => sat[i] > 0.13 && val[i] > 0.09 && hueDist(hue[i], flowerHue) < 42;
    while (head < tail && added < budget) {
      const i = queue[head++];
      const x = i % w, y = (i / w) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && !grown[j] && weak(j)) {
          grown[j] = 1;
          queue[tail++] = j;
          added++;
        }
      }
    }
    return { mask: grown, strong };
  }
  return null;
}

function segmentByBorderDistance(data, w, h) {
  const border = collectBorder(data, w, h, 6);
  const bg = medianColor(border);
  const dist = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const dr = data[p] - bg[0], dg = data[p + 1] - bg[1], db = data[p + 2] - bg[2];
    dist[i] = Math.sqrt(dr * dr + dg * dg + db * db);
  }
  const thr = otsu(dist, 442);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = dist[i] > thr ? 1 : 0;
  return { mask, strong: mask };
}

// flood fill from the border across non-mask pixels; unreachable gaps
// (e.g. the flower's center disk, a different hue) become part of the mask
function fillHoles(mask, w, h) {
  const outside = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let tail = 0;
  const push = (i) => { if (!mask[i] && !outside[i]) { outside[i] = 1; queue[tail++] = i; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  let head = 0;
  while (head < tail) {
    const i = queue[head++];
    const x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  for (let i = 0; i < w * h; i++) if (!mask[i] && !outside[i]) mask[i] = 1;
}

function dilate(mask, w, h, passes) {
  let src = mask.slice();
  let dst = new Uint8Array(w * h);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        dst[i] = src[i]
          || (x > 0 && src[i - 1]) || (x < w - 1 && src[i + 1])
          || (y > 0 && src[i - w]) || (y < h - 1 && src[i + w]) ? 1 : 0;
      }
    }
    [src, dst] = [dst, src];
  }
  return src;
}

function collectBorder(data, w, h, t) {
  const out = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= t && x < w - t && y >= t && y < h - t) { x = w - t - 1; continue; }
      const p = (y * w + x) * 4;
      out.push([data[p], data[p + 1], data[p + 2]]);
    }
  }
  return out;
}

function medianColor(pixels) {
  const n = pixels.length;
  if (!n) return [128, 128, 128];
  const ch = [[], [], []];
  for (const px of pixels) { ch[0].push(px[0]); ch[1].push(px[1]); ch[2].push(px[2]); }
  return ch.map(a => { a.sort((x, y) => x - y); return a[a.length >> 1]; });
}

function median(a) { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; }

function percentile(arr, p) {
  const b = [...arr].sort((x, y) => x - y);
  return b[Math.min(b.length - 1, Math.floor(b.length * p))];
}

function otsu(values, maxVal) {
  const BINS = 128;
  const hist = new Float64Array(BINS);
  for (let i = 0; i < values.length; i++) {
    hist[Math.min(BINS - 1, (values[i] / maxVal * BINS) | 0)]++;
  }
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < BINS; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, bestT = BINS >> 1;
  for (let t = 0; t < BINS; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; bestT = t; }
  }
  return (bestT / BINS) * maxVal;
}

function largestComponent(mask, w, h) {
  const label = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  let bestSize = 0, bestId = 0, id = 0;
  const stats = [];
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || label[start]) continue;
    id++;
    let head = 0, tail = 0, size = 0, sx = 0, sy = 0;
    queue[tail++] = start;
    label[start] = id;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w, y = (i / w) | 0;
      size++; sx += x; sy += y;
      if (x > 0 && mask[i - 1] && !label[i - 1]) { label[i - 1] = id; queue[tail++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !label[i + 1]) { label[i + 1] = id; queue[tail++] = i + 1; }
      if (y > 0 && mask[i - w] && !label[i - w]) { label[i - w] = id; queue[tail++] = i - w; }
      if (y < h - 1 && mask[i + w] && !label[i + w]) { label[i + w] = id; queue[tail++] = i + w; }
    }
    stats[id] = { size, cx: sx / size, cy: sy / size };
    if (size > bestSize) { bestSize = size; bestId = id; }
  }
  if (!bestId) return null;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = label[i] === bestId ? 1 : 0;
  return { mask: out, size: bestSize, cx: stats[bestId].cx, cy: stats[bestId].cy };
}

function circularSmooth(arr, radius) {
  const n = arr.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -radius; k <= radius; k++) s += arr[(i + k + n) % n];
    out[i] = s / (radius * 2 + 1);
  }
  return out;
}

function samplesInAnnulus(data, mask, w, h, cx, cy, r0, r1, useMask) {
  const out = [];
  const step = Math.max(1, Math.round((r1 - r0) / 24));
  for (let a = 0; a < 180; a++) {
    const ang = (a / 180) * Math.PI * 2;
    for (let t = r0; t < r1; t += step) {
      const x = Math.round(cx + Math.cos(ang) * t), y = Math.round(cy + Math.sin(ang) * t);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      if (useMask && !mask[y * w + x]) continue;
      const p = (y * w + x) * 4;
      out.push([data[p], data[p + 1], data[p + 2]]);
    }
  }
  return out;
}

function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hue = 0;
  if (d > 0) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return { h: hue, s: max ? d / max : 0, v: max };
}

function hueDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// perceptual-ish distance between two HSV colors; hue matters less when
// either color is desaturated (hue is noise near gray/white)
function colorScore(a, b) {
  const hueWeight = 0.3 + 0.7 * Math.min(a.s, b.s);
  return hueDist(a.h, b.h) / 60 * hueWeight
    + Math.abs(a.s - b.s) * 1.5
    + Math.abs(a.v - b.v) * 1.5;
}

function sampleBilinear(data, w, h, x, y, out, q) {
  const x0 = Math.max(0, Math.min(w - 2, Math.floor(x)));
  const y0 = Math.max(0, Math.min(h - 2, Math.floor(y)));
  const fx = Math.min(1, Math.max(0, x - x0)), fy = Math.min(1, Math.max(0, y - y0));
  const p00 = (y0 * w + x0) * 4, p10 = p00 + 4, p01 = p00 + w * 4, p11 = p01 + 4;
  for (let c = 0; c < 3; c++) {
    const top = data[p00 + c] * (1 - fx) + data[p10 + c] * fx;
    const bot = data[p01 + c] * (1 - fx) + data[p11 + c] * fx;
    out[q + c] = top * (1 - fy) + bot * fy;
  }
}
