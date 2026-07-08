// Pure layout-model operations shared by the top-frame overlay (overlay.js)
// and the in-iframe arranger (frame.js). No DOM, Node-testable.
//
// Model: { rows: [ { cells: [ { block: <id>, span?: 1..12, heightPx?: number } ] } ] }

export const COLS = 12;

export const deepCopyModel = (m) => ({
  rows: m.rows.map((r) => ({ cells: r.cells.map((c) => ({ ...c })) })),
});

/**
 * Rescale a row's spans proportionally so they sum to exactly COLS (each ≥ 1).
 * Used when a cell LEAVES a row: the remaining columns re-flow to fill the
 * width (a 6/6 row becomes a single 12; a 4/4/4 row becomes 6/6). Mutates and
 * returns `cells`.
 */
export function fillRowSpans(cells) {
  if (cells.length === 0) return cells;
  const spans = cells.map((c) => c.span ?? COLS);
  const total = spans.reduce((a, x) => a + x, 0);
  if (total <= 0) {
    cells.forEach((c) => (c.span = Math.floor(COLS / cells.length) || 1));
    return cells;
  }
  const out = spans.map((s) => Math.max(1, Math.round((s * COLS) / total)));
  let diff = COLS - out.reduce((a, x) => a + x, 0);
  for (let i = 0; diff !== 0 && i < out.length * COLS; i++) {
    const j = i % out.length;
    if (diff > 0) {
      out[j] += 1;
      diff -= 1;
    } else if (out[j] > 1) {
      out[j] -= 1;
      diff += 1;
    }
  }
  cells.forEach((c, i) => (c.span = out[i]));
  return cells;
}

/**
 * Move the cell at (fromRow, fromCell) to a target and return a NEW model
 * (input untouched). Targets:
 *   { kind: "cell", rowIdx, cellIdx } — insert into an existing row at cellIdx
 *     (indices computed against the PRE-move rows array; same-row moves are
 *     re-indexed automatically). If the row's spans then overflow 12 columns,
 *     all spans in the row are redistributed evenly (equal split).
 *   { kind: "gap", idx } — new full-width row inserted at idx (also a pre-move
 *     index; the possibly-emptied source row is filtered afterwards, keeping
 *     the index consistent).
 * When the move takes the cell OUT of a multi-cell row (gap move or cell move
 * to a different row), the source row's remaining spans re-flow proportionally
 * to fill the 12 columns.
 */
export function moveBlock(model, fromRow, fromCell, target) {
  const m = deepCopyModel(model);
  const src = m.rows[fromRow];
  const moved = src.cells.splice(fromCell, 1)[0];
  const leftSourceRow = target.kind === "gap" || target.rowIdx !== fromRow;
  if (target.kind === "cell") {
    let { rowIdx, cellIdx } = target;
    if (rowIdx === fromRow && cellIdx > fromCell) cellIdx -= 1;
    m.rows[rowIdx].cells.splice(cellIdx, 0, moved);
    const cells = m.rows[rowIdx].cells;
    const sum = cells.reduce((a, c) => a + (c.span ?? COLS), 0);
    if (sum > COLS) {
      const each = Math.floor(COLS / cells.length);
      cells.forEach((c, i) => (c.span = i === 0 ? COLS - each * (cells.length - 1) : each));
    }
  } else {
    moved.span = COLS;
    m.rows.splice(target.idx, 0, { cells: [moved] });
  }
  if (leftSourceRow && src.cells.length > 0) fillRowSpans(src.cells);
  m.rows = m.rows.filter((r) => r.cells.length > 0);
  return m;
}

/**
 * Pure drop-target picker for the drag UX (no DOM — the caller snapshots
 * geometry). Given the pointer position and per-row geometry, decide what
 * dropping here would mean and what indicator to draw. Every candidate is
 * gated through `isValid(target)` (the engine-validate oracle), with
 * fallbacks so a spot whose primary meaning is invalid can still resolve
 * (e.g. hovering a pinned row's band falls back to the nearest row gap).
 *
 *   point — { x, y } in the same coordinate space as the rects
 *   geoms — one entry per PRE-move model row, in order:
 *           { rect: {left,top,right,bottom} | null,
 *             cellRects: [ { rect: {left,top,right,bottom} | null } ] }
 *   isValid — (target) => boolean
 *
 * Zones inside a row's band: the top/bottom edge strips mean "new row
 * before/after this row" (gap target); the middle means "join this row as a
 * column at the x-derived slot" (cell target).
 *
 * Returns { target, indicator } or null.
 *   indicator: { kind: "gap", y }                                — horizontal line
 *            | { kind: "cell", rowIdx, x, row: {left,top,right,bottom} } — slot line
 */
export function pickDropTarget(point, geoms, isValid, opts = {}) {
  const edgeFrac = opts.edgeFrac ?? 0.28;
  const edgeMin = opts.edgeMin ?? 8;
  const edgeMax = opts.edgeMax ?? 80;
  const snapPx = opts.snapPx ?? 140;

  // Canonical between-row gap lines (pre-move indices 0..rows.length).
  const gapYs = [];
  for (let i = 0; i <= geoms.length; i++) {
    let prevBottom = null;
    for (let k = i - 1; k >= 0; k--) {
      if (geoms[k].rect) {
        prevBottom = geoms[k].rect.bottom;
        break;
      }
    }
    let nextTop = null;
    for (let k = i; k < geoms.length; k++) {
      if (geoms[k].rect) {
        nextTop = geoms[k].rect.top;
        break;
      }
    }
    if (prevBottom == null && nextTop == null) continue;
    const y =
      prevBottom == null ? nextTop - 10 : nextTop == null ? prevBottom + 10 : (prevBottom + nextTop) / 2;
    gapYs.push({ idx: i, y });
  }

  const tryGap = (idx) => {
    const g = gapYs.find((x) => x.idx === idx);
    if (!g) return null;
    const target = { kind: "gap", idx };
    return isValid(target) ? { target, indicator: { kind: "gap", y: g.y } } : null;
  };

  const tryCell = (rowIdx) => {
    const g = geoms[rowIdx];
    if (!g.rect) return null;
    const rects = g.cellRects.map((c) => c.rect);
    let cellIdx = rects.length;
    for (let i = 0; i < rects.length; i++) {
      if (rects[i] && point.x < (rects[i].left + rects[i].right) / 2) {
        cellIdx = i;
        break;
      }
    }
    const target = { kind: "cell", rowIdx, cellIdx };
    if (!isValid(target)) return null;
    const before = rects[cellIdx - 1] ?? null;
    const after = rects[cellIdx] ?? null;
    const x =
      before && after
        ? (before.right + after.left) / 2
        : after
          ? after.left
          : before
            ? before.right
            : (g.rect.left + g.rect.right) / 2;
    return { target, indicator: { kind: "cell", rowIdx, x, row: { ...g.rect } } };
  };

  for (let rowIdx = 0; rowIdx < geoms.length; rowIdx++) {
    const r = geoms[rowIdx].rect;
    if (!r || point.y < r.top || point.y > r.bottom) continue;
    const edge = Math.min(Math.max((r.bottom - r.top) * edgeFrac, edgeMin), edgeMax);
    const nearGap = point.y < (r.top + r.bottom) / 2 ? rowIdx : rowIdx + 1;
    const order =
      point.y < r.top + edge
        ? [() => tryGap(rowIdx), () => tryCell(rowIdx), () => tryGap(rowIdx + 1)]
        : point.y > r.bottom - edge
          ? [() => tryGap(rowIdx + 1), () => tryCell(rowIdx), () => tryGap(rowIdx)]
          : [
              () => tryCell(rowIdx),
              () => tryGap(nearGap),
              () => tryGap(nearGap === rowIdx ? rowIdx + 1 : rowIdx),
            ];
    for (const fn of order) {
      const res = fn();
      if (res) return res;
    }
    return null;
  }

  // Outside every band → nearest gap within snap distance.
  let best = null;
  for (const g of gapYs) {
    const dist = Math.abs(point.y - g.y);
    if (!best || dist < best.dist) best = { ...g, dist };
  }
  if (best && best.dist <= snapPx) return tryGap(best.idx);
  return null;
}
