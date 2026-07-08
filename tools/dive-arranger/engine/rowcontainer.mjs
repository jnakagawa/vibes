// Source row-container recognition — pure string/number logic, no AST and no
// DOM, so it can be shared by BOTH sides of the pipeline:
//  - engine/discover.mjs — JSX side: className strings + inline style objects
//  - extension/frame.js  — DOM side: class attribute + inline element styles
// Sharing one classifier means source decomposition and rendered-tile mapping
// cannot disagree about what counts as a decomposable row.
//
// A "source row container" is a dive-authored element that lays its children
// out side by side:
//  - display:grid with a multi-column template — inline style
//    (gridTemplateColumns with ≥2 tracks, incl. repeat(N, …)) or Tailwind
//    (`grid grid-cols-N`, responsive variants like `md:grid-cols-2` count) —
//  - or display:flex in row direction (`flex` without `flex-col`).
import { GRID_COLS } from "./validate.mjs";

const tokens = (classAttr) =>
  String(classAttr || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

// Strip responsive/state variant prefixes: "md:grid-cols-2" → "grid-cols-2".
const baseToken = (t) => t.slice(t.lastIndexOf(":") + 1);

/**
 * Count the column tracks in a grid-template-columns value.
 * Handles track lists ("1fr 2fr"), repeat(N, …) (incl. nested track lists),
 * and named grid lines. Returns 0 for none/auto-fill/auto-fit/unparseable.
 */
export function countGridTracks(template) {
  if (typeof template !== "string") return 0;
  const t = template.trim();
  if (!t || t === "none") return 0;

  // Split into top-level tokens (parens can nest: minmax(0, 1fr)).
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of t) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);

  let n = 0;
  for (const p of parts) {
    const rep = p.match(/^repeat\((\d+)\s*,([\s\S]*)\)$/);
    if (rep) {
      const inner = countGridTracks(rep[2]);
      if (!inner) return 0;
      n += Number(rep[1]) * inner;
    } else if (/^repeat\(/.test(p)) {
      return 0; // repeat(auto-fill|auto-fit, …) — column count is not static
    } else if (/^\[[\s\S]*\]$/.test(p)) {
      // named grid line, not a track
    } else {
      n += 1;
    }
  }
  return n;
}

/**
 * Classify an element as a side-by-side row container.
 * Inputs are the element's class attribute plus its inline style values
 * (inline style wins over classes when both are present).
 * Returns { kind: "grid", cols } | { kind: "flex" } | null.
 */
export function classifyRowContainer({
  classAttr = "",
  display = null,
  gridTemplateColumns = null,
  flexDirection = null,
} = {}) {
  const toks = tokens(classAttr).map(baseToken);
  const has = (t) => toks.includes(t);

  const isGrid =
    display === "grid" ||
    display === "inline-grid" ||
    (!display && (has("grid") || has("inline-grid")));
  if (isGrid) {
    let cols = countGridTracks(gridTemplateColumns);
    if (!cols) {
      for (const t of toks) {
        const m = t.match(/^grid-cols-(\d+)$/);
        if (m) cols = Math.max(cols, Number(m[1]));
      }
    }
    return cols >= 2 ? { kind: "grid", cols } : null;
  }

  const isFlex =
    display === "flex" ||
    display === "inline-flex" ||
    (!display && (has("flex") || has("inline-flex")));
  if (isFlex) {
    const columnClass = toks.some((t) => t === "flex-col" || t === "flex-col-reverse");
    const dir = flexDirection || (columnClass ? "column" : "row");
    return /^column/.test(dir) ? null : { kind: "flex" };
  }

  return null;
}

/**
 * Column units a grid child occupies (Tailwind col-span-N / col-span-full),
 * clamped to the container's column count. Default 1.
 */
export function gridChildUnits(classAttr, cols) {
  let units = 1;
  for (const t of tokens(classAttr).map(baseToken)) {
    if (t === "col-span-full") return cols;
    const m = t.match(/^col-span-(\d+)$/);
    if (m) units = Math.max(units, Math.min(Number(m[1]), cols));
  }
  return units;
}

/**
 * Derive each child's 12-col span for ONE visual row of a source container.
 * Returns null when decomposition is out of scope:
 *  - fewer than 2 children;
 *  - grid children whose combined column units exceed the template (the CSS
 *    grid would wrap to a second visual row — kept as one opaque block);
 *  - more children than the 12-col model can hold (flex).
 * Grid spans scale by column width (grid-cols-2 → 6/6, grid-cols-4 →
 * 3/3/3/3, col-span-2 of 3 → 8); equal-split is the fallback whenever the
 * scaled spans would not fit.
 */
export function sourceRowSpans(info, childUnits) {
  const n = childUnits.length;
  if (n < 2) return null;

  if (info.kind === "flex") {
    if (n > GRID_COLS) return null;
    const each = Math.floor(GRID_COLS / n);
    return childUnits.map(() => each);
  }

  const { cols } = info;
  const total = childUnits.reduce((a, u) => a + u, 0);
  if (total > cols) return null; // would wrap — out of scope

  let spans = childUnits.map((u) => Math.max(1, Math.round((GRID_COLS * u) / cols)));
  if (spans.reduce((a, s) => a + s, 0) > GRID_COLS) {
    const each = Math.floor(GRID_COLS / n); // equal-split fallback
    spans = childUnits.map(() => each);
  }
  return spans;
}
