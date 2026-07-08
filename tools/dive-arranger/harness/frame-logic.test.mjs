// Pure tests for the in-iframe arranger's model logic — the parts of
// dist/frame.js that don't need a DOM: the shared move operations
// (layout-model.mjs) and the tile↔block alignment (frame-map.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deepCopyModel,
  moveBlock,
  fillRowSpans,
  pickDropTarget,
  COLS,
} from "../extension/layout-model.mjs";
import { alignRowsToChildren } from "../extension/frame-map.mjs";
import { validateLayout } from "../engine/validate.mjs";
import { validateLayout as validateViaIndex } from "../engine/index.mjs";
import {
  classifyRowContainer,
  countGridTracks,
  sourceRowSpans,
} from "../engine/rowcontainer.mjs";

// ── layout-model ──────────────────────────────────────────────────────

const model3 = () => ({
  rows: [
    { cells: [{ block: 0, span: 12, heightPx: null }] },
    { cells: [{ block: 1, span: 12, heightPx: null }] },
    { cells: [{ block: 2, span: 12, heightPx: null }] },
  ],
});

test("moveBlock: gap move makes a full-width row and never mutates the input", () => {
  const m = model3();
  const before = JSON.stringify(m);
  const out = moveBlock(m, 2, 0, { kind: "gap", idx: 0 });
  assert.equal(JSON.stringify(m), before);
  assert.deepEqual(out.rows.map((r) => r.cells.map((c) => c.block)), [[2], [0], [1]]);
  assert.equal(out.rows[0].cells[0].span, COLS);
});

test("moveBlock: cell move joins a row; overflowing spans are redistributed", () => {
  const out = moveBlock(model3(), 1, 0, { kind: "cell", rowIdx: 0, cellIdx: 1 });
  assert.deepEqual(out.rows.map((r) => r.cells.map((c) => c.block)), [[0, 1], [2]]);
  // 12 + 12 > 12 → even split
  assert.deepEqual(out.rows[0].cells.map((c) => c.span), [6, 6]);
});

test("moveBlock: same-row reindex and empty-row cleanup", () => {
  const m = {
    rows: [
      { cells: [{ block: 0, span: 4 }, { block: 1, span: 4 }, { block: 2, span: 4 }] },
      { cells: [{ block: 3, span: 12 }] },
    ],
  };
  // move block 0 after block 2 within the same row
  const out = moveBlock(m, 0, 0, { kind: "cell", rowIdx: 0, cellIdx: 3 });
  assert.deepEqual(out.rows[0].cells.map((c) => c.block), [1, 2, 0]);
  // moving a solo block out deletes its old row
  const out2 = moveBlock(m, 1, 0, { kind: "cell", rowIdx: 0, cellIdx: 0 });
  assert.equal(out2.rows.length, 1);
  assert.deepEqual(out2.rows[0].cells.map((c) => c.block), [3, 0, 1, 2]);
});

test("moveBlock: intra-row column reorder keeps spans and membership", () => {
  const m = {
    rows: [
      { cells: [{ block: 0, span: 6, heightPx: null }, { block: 1, span: 6, heightPx: 300 }] },
      { cells: [{ block: 2, span: 12, heightPx: null }] },
    ],
  };
  // drag block 1 to the left of block 0 (slot 0)
  const out = moveBlock(m, 0, 1, { kind: "cell", rowIdx: 0, cellIdx: 0 });
  assert.deepEqual(out.rows.map((r) => r.cells.map((c) => c.block)), [[1, 0], [2]]);
  assert.deepEqual(out.rows[0].cells.map((c) => c.span), [6, 6]); // no redistribution
  assert.equal(out.rows[0].cells[0].heightPx, 300); // height travels with the cell
  // uneven spans travel with their cells too
  const m2 = { rows: [{ cells: [{ block: 0, span: 8 }, { block: 1, span: 4 }] }] };
  const out2 = moveBlock(m2, 0, 0, { kind: "cell", rowIdx: 0, cellIdx: 2 });
  assert.deepEqual(out2.rows[0].cells.map((c) => c.block), [1, 0]);
  assert.deepEqual(out2.rows[0].cells.map((c) => c.span), [4, 8]);
});

test("moveBlock: extracting a column to its own row re-flows the remainder to full width", () => {
  const m = {
    rows: [
      { cells: [{ block: 0, span: 6, heightPx: null }, { block: 1, span: 6, heightPx: null }] },
      { cells: [{ block: 2, span: 12, heightPx: null }] },
    ],
  };
  const out = moveBlock(m, 0, 1, { kind: "gap", idx: 1 });
  assert.deepEqual(out.rows.map((r) => r.cells.map((c) => c.block)), [[0], [1], [2]]);
  assert.equal(out.rows[0].cells[0].span, COLS); // survivor fills the row
  assert.equal(out.rows[1].cells[0].span, COLS); // extracted tile is full-width

  // 3-col row: remaining two re-flow proportionally (4/4/4 → 6/6)
  const m3 = { rows: [{ cells: [{ block: 0, span: 4 }, { block: 1, span: 4 }, { block: 2, span: 4 }] }] };
  const out3 = moveBlock(m3, 0, 1, { kind: "gap", idx: 1 });
  assert.deepEqual(out3.rows[0].cells.map((c) => c.span), [6, 6]);
  // uneven remainder keeps its proportions (3/6/3 minus the 6 → 6/6)
  const m4 = { rows: [{ cells: [{ block: 0, span: 3 }, { block: 1, span: 6 }, { block: 2, span: 3 }] }] };
  const out4 = moveBlock(m4, 0, 1, { kind: "gap", idx: 0 });
  assert.deepEqual(out4.rows[1].cells.map((c) => c.span), [6, 6]);
});

test("moveBlock: moving a column into ANOTHER row re-flows the source and splits the target", () => {
  const m = {
    rows: [
      { cells: [{ block: 0, span: 6, heightPx: null }, { block: 1, span: 6, heightPx: null }] },
      { cells: [{ block: 2, span: 12, heightPx: null }] },
    ],
  };
  const out = moveBlock(m, 0, 1, { kind: "cell", rowIdx: 1, cellIdx: 1 });
  assert.deepEqual(out.rows.map((r) => r.cells.map((c) => c.block)), [[0], [2, 1]]);
  assert.equal(out.rows[0].cells[0].span, COLS); // source re-flowed
  assert.deepEqual(out.rows[1].cells.map((c) => c.span), [6, 6]); // target split evenly
});

test("moveBlock: inserting a full-width tile as a new column splits the row evenly", () => {
  const m = {
    rows: [
      { cells: [{ block: 0, span: 6 }, { block: 1, span: 6 }] },
      { cells: [{ block: 2, span: 12 }] },
    ],
  };
  const out = moveBlock(m, 1, 0, { kind: "cell", rowIdx: 0, cellIdx: 1 });
  assert.deepEqual(out.rows.map((r) => r.cells.map((c) => c.block)), [[0, 2, 1]]);
  assert.deepEqual(out.rows[0].cells.map((c) => c.span), [4, 4, 4]);
  const sum = out.rows[0].cells.reduce((a, c) => a + c.span, 0);
  assert.ok(sum <= COLS);
});

test("moveBlock never mutates its input on the new paths", () => {
  const m = {
    rows: [
      { cells: [{ block: 0, span: 6 }, { block: 1, span: 6 }] },
      { cells: [{ block: 2, span: 12 }] },
    ],
  };
  const before = JSON.stringify(m);
  moveBlock(m, 0, 1, { kind: "gap", idx: 2 });
  moveBlock(m, 0, 1, { kind: "cell", rowIdx: 1, cellIdx: 0 });
  moveBlock(m, 0, 1, { kind: "cell", rowIdx: 0, cellIdx: 0 });
  assert.equal(JSON.stringify(m), before);
});

test("fillRowSpans: proportional integer re-flow to exactly 12", () => {
  const spans = (cells) => cells.map((c) => c.span);
  assert.deepEqual(spans(fillRowSpans([{ span: 6 }])), [12]);
  assert.deepEqual(spans(fillRowSpans([{ span: 4 }, { span: 4 }])), [6, 6]);
  assert.deepEqual(spans(fillRowSpans([{ span: 3 }, { span: 6 }])), [4, 8]);
  const odd = fillRowSpans([{ span: 5 }, { span: 2 }]);
  assert.equal(odd.reduce((a, c) => a + c.span, 0), 12);
  assert.ok(odd.every((c) => c.span >= 1));
});

test("deepCopyModel detaches cells", () => {
  const m = model3();
  const c = deepCopyModel(m);
  c.rows[0].cells[0].span = 3;
  assert.equal(m.rows[0].cells[0].span, 12);
});

// ── rowcontainer: the classifier shared by discovery and the frame ────

test("classifyRowContainer: tailwind classes, inline styles, and rejections", () => {
  assert.deepEqual(classifyRowContainer({ classAttr: "grid grid-cols-2 gap-8 mb-8" }), { kind: "grid", cols: 2 });
  assert.deepEqual(classifyRowContainer({ classAttr: "grid grid-cols-1 md:grid-cols-3" }), { kind: "grid", cols: 3 });
  assert.equal(classifyRowContainer({ classAttr: "grid" }), null); // single column
  assert.equal(classifyRowContainer({ classAttr: "card grid-cols-2" }), null); // no grid display
  assert.deepEqual(classifyRowContainer({ classAttr: "flex items-center gap-4" }), { kind: "flex" });
  assert.equal(classifyRowContainer({ classAttr: "flex flex-col gap-4" }), null);
  assert.equal(classifyRowContainer({ classAttr: "flex md:flex-col" }), null);
  assert.deepEqual(
    classifyRowContainer({ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }),
    { kind: "grid", cols: 4 },
  );
  assert.deepEqual(classifyRowContainer({ display: "grid", gridTemplateColumns: "1fr 2fr" }), { kind: "grid", cols: 2 });
  assert.equal(classifyRowContainer({ display: "grid", gridTemplateColumns: "repeat(auto-fill, 200px)" }), null);
  assert.equal(classifyRowContainer({ display: "flex", flexDirection: "column" }), null);
  assert.deepEqual(classifyRowContainer({ display: "flex" }), { kind: "flex" });
  // inline display wins over classes
  assert.equal(classifyRowContainer({ classAttr: "grid grid-cols-2", display: "block" }), null);
  assert.equal(classifyRowContainer({}), null);
});

test("countGridTracks: track lists, repeat expansion, named lines", () => {
  assert.equal(countGridTracks("repeat(4, minmax(0, 1fr))"), 4);
  assert.equal(countGridTracks("repeat(2, 1fr 2fr)"), 4);
  assert.equal(countGridTracks("1fr 1fr 1fr"), 3);
  assert.equal(countGridTracks("[full-start] 1fr [mid] 1fr [full-end]"), 2);
  assert.equal(countGridTracks("none"), 0);
  assert.equal(countGridTracks("repeat(auto-fit, 100px)"), 0);
  assert.equal(countGridTracks(null), 0);
});

test("sourceRowSpans: template-derived spans with equal-split fallback", () => {
  assert.deepEqual(sourceRowSpans({ kind: "grid", cols: 2 }, [1, 1]), [6, 6]);
  assert.deepEqual(sourceRowSpans({ kind: "grid", cols: 4 }, [1, 1, 1, 1]), [3, 3, 3, 3]);
  assert.deepEqual(sourceRowSpans({ kind: "grid", cols: 3 }, [2, 1]), [8, 4]);
  assert.deepEqual(sourceRowSpans({ kind: "grid", cols: 5 }, [1, 1, 1, 1, 1]), [2, 2, 2, 2, 2]);
  assert.equal(sourceRowSpans({ kind: "grid", cols: 2 }, [1, 1, 1]), null); // wraps
  assert.equal(sourceRowSpans({ kind: "grid", cols: 2 }, [1]), null); // solo
  assert.deepEqual(sourceRowSpans({ kind: "flex" }, [1, 1]), [6, 6]);
  assert.deepEqual(sourceRowSpans({ kind: "flex" }, [1, 1, 1]), [4, 4, 4]);
});

test("align: decomposed source rows presented as wrapper-like children align in order", () => {
  // frame.js's srcrow pass maps a rendered source grid (ONE container child)
  // to a decomposed multi-cell model row by presenting it as wrapper-like.
  const rows = [
    { cells: [{ block: 0, span: 6, heightPx: null }, { block: 1, span: 6, heightPx: null }] },
    { cells: [{ block: 2, span: 6, heightPx: null }, { block: 3, span: 6, heightPx: null }] },
    { cells: [{ block: 4, span: 12, heightPx: null }] },
  ];
  const kinds = kindsOf(["static", "static", "static", "static", "static"]);
  const children = [
    child({ wrapper: true, cellCount: 2 }), // srcrow view of grid #1
    child({ wrapper: true, cellCount: 2 }), // srcrow view of grid #2
    child({ anchors: new Set([4]) }),
  ];
  const out = alignRowsToChildren(rows, kinds, children);
  assert.deepEqual(out.map((r) => r.childIdxs), [[0], [1], [2]]);
  assert.deepEqual(out.map((r) => r.via), ["wrapper", "wrapper", "anchor"]);
});

// ── engine/validate split ─────────────────────────────────────────────

test("validateLayout is the same function via engine/index.mjs and engine/validate.mjs", () => {
  assert.equal(validateLayout, validateViaIndex);
});

// ── frame-map: alignment ──────────────────────────────────────────────

const kindsOf = (spec) => new Map(spec.map((k, i) => [i, k]));
const bareRows = (n) => ({
  rows: Array.from({ length: n }, (_, i) => ({ cells: [{ block: i, span: 12, heightPx: null }] })),
});
const child = (over = {}) => ({ wrapper: false, cellCount: 0, anchors: new Set(), ...over });

test("align: fresh dive, counts match, no anchors → positional 1:1", () => {
  const rows = bareRows(3).rows;
  const kinds = kindsOf(["static", "static", "static"]);
  const children = [child(), child(), child()];
  const out = alignRowsToChildren(rows, kinds, children);
  assert.deepEqual(out.map((r) => r.childIdxs), [[0], [1], [2]]);
  assert.ok(out.every((r) => r.via === "position"));
});

test("align: anchors pin blocks, the rest fills positionally", () => {
  const rows = bareRows(3).rows;
  const kinds = kindsOf(["static", "static", "static"]);
  const children = [child(), child({ anchors: new Set([1]) }), child()];
  const out = alignRowsToChildren(rows, kinds, children);
  assert.deepEqual(out.map((r) => r.childIdxs), [[0], [1], [2]]);
  assert.equal(out[1].via, "anchor");
});

test("align: dynamic block absorbs a variable number of children", () => {
  const rows = bareRows(3).rows; // [static, dynamic, static]
  const kinds = kindsOf(["static", "dynamic", "static"]);
  // dynamic rendered TWO nodes; statics anchored on both sides
  const c4 = [
    child({ anchors: new Set([0]) }),
    child(),
    child(),
    child({ anchors: new Set([2]) }),
  ];
  const out = alignRowsToChildren(rows, kinds, c4);
  assert.deepEqual(out.map((r) => r.childIdxs), [[0], [1, 2], [3]]);
  assert.equal(out[1].via, "dynamic");

  // dynamic rendered ZERO nodes
  const c2 = [child({ anchors: new Set([0]) }), child({ anchors: new Set([2]) })];
  const out2 = alignRowsToChildren(rows, kinds, c2);
  assert.deepEqual(out2.map((r) => r.childIdxs), [[0], [], [1]]);
});

test("align: dynamic without anchors uses edge-in positional assignment", () => {
  const rows = bareRows(3).rows; // [static, dynamic, static]
  const kinds = kindsOf(["static", "dynamic", "static"]);
  const children = [child(), child(), child(), child(), child()]; // dyn rendered 3
  const out = alignRowsToChildren(rows, kinds, children);
  assert.deepEqual(out.map((r) => r.childIdxs), [[0], [1, 2, 3], [4]]);
});

test("align: wrapper rows match arranger row wrappers in order with cell counts", () => {
  const rows = [
    { cells: [{ block: 0, span: 6, heightPx: null }, { block: 1, span: 6, heightPx: null }] },
    { cells: [{ block: 2, span: 12, heightPx: null }] },
    { cells: [{ block: 3, span: 12, heightPx: 300 }] }, // heightPx → wrapped too
  ];
  const kinds = kindsOf(["static", "static", "static", "static"]);
  const children = [
    child({ wrapper: true, cellCount: 2 }),
    child(),
    child({ wrapper: true, cellCount: 1 }),
  ];
  const out = alignRowsToChildren(rows, kinds, children);
  assert.deepEqual(out.map((r) => r.childIdxs), [[0], [1], [2]]);
  assert.deepEqual(out.map((r) => r.via), ["wrapper", "position", "wrapper"]);
});

test("align: wrapper count or cell-count mismatch fails cleanly (null)", () => {
  const rows = [
    { cells: [{ block: 0, span: 6, heightPx: null }, { block: 1, span: 6, heightPx: null }] },
    { cells: [{ block: 2, span: 12, heightPx: null }] },
  ];
  const kinds = kindsOf(["static", "static", "static"]);
  // no wrapper child at all
  assert.equal(alignRowsToChildren(rows, kinds, [child(), child()]), null);
  // wrapper child with the wrong number of cells
  assert.equal(
    alignRowsToChildren(rows, kinds, [child({ wrapper: true, cellCount: 3 }), child()]),
    null,
  );
});

test("align: static-only count mismatch fails cleanly (null)", () => {
  const rows = bareRows(3).rows;
  const kinds = kindsOf(["static", "static", "static"]);
  assert.equal(alignRowsToChildren(rows, kinds, [child(), child()]), null);
  assert.equal(alignRowsToChildren(rows, kinds, [child(), child(), child(), child()]), null);
});

test("align: unanchored static between two dynamics goes inert; region stays ordered", () => {
  const rows = bareRows(3).rows; // [dynamic, static, dynamic]
  const kinds = kindsOf(["dynamic", "static", "dynamic"]);
  const children = [child(), child(), child()];
  const out = alignRowsToChildren(rows, kinds, children);
  assert.deepEqual(out[0].childIdxs, [0, 1, 2]); // whole region to the first dynamic
  assert.equal(out[1].via, "inert");
  assert.deepEqual(out[1].childIdxs, []);
  assert.deepEqual(out[2].childIdxs, []);
});

test("align: conflicting anchor order falls back to wrapper pins, then fails if still inconsistent", () => {
  const rows = bareRows(2).rows;
  const kinds = kindsOf(["static", "static"]);
  // anchors claim reversed order — inconsistent, no wrappers to fall back on,
  // but positionally 1:1 still works once the anchors are dropped
  const children = [child({ anchors: new Set([1]) }), child({ anchors: new Set([0]) })];
  const out = alignRowsToChildren(rows, kinds, children);
  assert.deepEqual(out.map((r) => r.childIdxs), [[0], [1]]);
});

test("align: extra children that belong to no row fail cleanly (null)", () => {
  const rows = [
    { cells: [{ block: 0, span: 6, heightPx: null }, { block: 1, span: 6, heightPx: null }] },
  ];
  const kinds = kindsOf(["static", "static"]);
  const children = [child({ wrapper: true, cellCount: 2 }), child()];
  assert.equal(alignRowsToChildren(rows, kinds, children), null);
});

// ── the frame's validity oracle matches the engine ────────────────────

test("frame drop-validity: moveBlock + validateLayout reject crossing a pinned block", () => {
  const blocks = [
    { id: 0, kind: "static", label: "a" },
    { id: 1, kind: "dynamic", label: "b" },
    { id: 2, kind: "static", label: "c" },
  ];
  const m = bareRows(3);
  const crossed = moveBlock(m, 2, 0, { kind: "gap", idx: 0 }); // c above the pin
  assert.throws(() => validateLayout(blocks, deepCopyModel(crossed)));
  const legal = moveBlock(m, 0, 0, { kind: "gap", idx: 2 }); // a stays in segment 0? no — crosses too
  assert.throws(() => validateLayout(blocks, deepCopyModel(legal)));
  const fine = moveBlock(m, 0, 0, { kind: "gap", idx: 1 }); // a below nothing, before the pin
  assert.doesNotThrow(() => validateLayout(blocks, deepCopyModel(fine)));
});

// ── validate rules the multi-col moves rely on ────────────────────────

test("validateLayout: row spans must sum to ≤ 12", () => {
  const blocks = [
    { id: 0, kind: "static", label: "a" },
    { id: 1, kind: "static", label: "b" },
  ];
  const over = { rows: [{ cells: [{ block: 0, span: 8 }, { block: 1, span: 6 }] }] };
  assert.throws(() => validateLayout(blocks, over), /sum to 14 > 12/);
  const ok = { rows: [{ cells: [{ block: 0, span: 6 }, { block: 1, span: 6 }] }] };
  assert.doesNotThrow(() => validateLayout(blocks, ok));
});

test("validateLayout: no zero-width columns, no empty rows", () => {
  const blocks = [
    { id: 0, kind: "static", label: "a" },
    { id: 1, kind: "static", label: "b" },
  ];
  const zero = {
    rows: [{ cells: [{ block: 0, span: 12 }, { block: 1, span: 0 }] }],
  };
  assert.throws(() => validateLayout(blocks, zero), /span must be an integer 1\.\.12/);
  const empty = { rows: [{ cells: [{ block: 0, span: 12 }] }, { cells: [] }, { cells: [{ block: 1, span: 12 }] }] };
  assert.throws(() => validateLayout(blocks, empty), /non-empty cells/);
});

test("a 13th column is impossible: even split would need zero-width, validate rejects", () => {
  const blocks = Array.from({ length: 13 }, (_, i) => ({ id: i, kind: "static", label: `b${i}` }));
  const m = {
    rows: [
      { cells: Array.from({ length: 12 }, (_, i) => ({ block: i, span: 1 })) },
      { cells: [{ block: 12, span: 12 }] },
    ],
  };
  const joined = moveBlock(m, 1, 0, { kind: "cell", rowIdx: 0, cellIdx: 12 });
  assert.throws(() => validateLayout(blocks, deepCopyModel(joined)));
});

// ── pickDropTarget: the pure drag hit-test frame.js uses ─────────────

// Two rows: row 0 is a 6/6 two-column row, row 1 a full-width tile.
const rect = (left, top, right, bottom) => ({ left, top, right, bottom });
const twoRowGeoms = () => [
  {
    rect: rect(0, 0, 1200, 300),
    cellRects: [
      { block: 0, rect: rect(0, 0, 592, 300) },
      { block: 1, rect: rect(608, 0, 1200, 300) },
    ],
  },
  { rect: rect(0, 316, 1200, 616), cellRects: [{ block: 2, rect: rect(0, 316, 1200, 616) }] },
];
const yes = () => true;

test("pickDropTarget: middle of a multi-col row targets a column slot with an x indicator", () => {
  // between the two cells → slot 1, indicator line in the 16px gutter
  const mid = pickDropTarget({ x: 600, y: 150 }, twoRowGeoms(), yes);
  assert.deepEqual(mid.target, { kind: "cell", rowIdx: 0, cellIdx: 1 });
  assert.equal(mid.indicator.kind, "cell");
  assert.equal(mid.indicator.x, 600); // (592 + 608) / 2
  // left of the first cell's midpoint → slot 0, line at the row's left edge
  const left = pickDropTarget({ x: 100, y: 150 }, twoRowGeoms(), yes);
  assert.deepEqual(left.target, { kind: "cell", rowIdx: 0, cellIdx: 0 });
  assert.equal(left.indicator.x, 0);
  // right of the last cell's midpoint → slot 2 (append), line at the right edge
  const right = pickDropTarget({ x: 1100, y: 150 }, twoRowGeoms(), yes);
  assert.deepEqual(right.target, { kind: "cell", rowIdx: 0, cellIdx: 2 });
  assert.equal(right.indicator.x, 1200);
});

test("pickDropTarget: band edge strips mean a new row (gap), not a column join", () => {
  // top strip of row 0 (h=300 → edge = 80px clamp)
  const top = pickDropTarget({ x: 600, y: 20 }, twoRowGeoms(), yes);
  assert.deepEqual(top.target, { kind: "gap", idx: 0 });
  assert.equal(top.indicator.kind, "gap");
  // bottom strip of row 0 → gap between the rows, indicator at the midline
  const bottom = pickDropTarget({ x: 600, y: 290 }, twoRowGeoms(), yes);
  assert.deepEqual(bottom.target, { kind: "gap", idx: 1 });
  assert.equal(bottom.indicator.y, 308); // (300 + 316) / 2
});

test("pickDropTarget: between bands and past the last row snap to the nearest gap", () => {
  const between = pickDropTarget({ x: 600, y: 310 }, twoRowGeoms(), yes);
  assert.deepEqual(between.target, { kind: "gap", idx: 1 });
  const below = pickDropTarget({ x: 600, y: 700 }, twoRowGeoms(), yes);
  assert.deepEqual(below.target, { kind: "gap", idx: 2 });
  // way past the snap distance → no target
  assert.equal(pickDropTarget({ x: 600, y: 2000 }, twoRowGeoms(), yes), null);
});

test("pickDropTarget: invalid column join falls back to the nearest gap (no dead zones)", () => {
  const gapsOnly = (t) => t.kind === "gap";
  const picked = pickDropTarget({ x: 600, y: 100 }, twoRowGeoms(), gapsOnly);
  assert.deepEqual(picked.target, { kind: "gap", idx: 0 }); // y=100 is in row 0's upper half
  const picked2 = pickDropTarget({ x: 600, y: 200 }, twoRowGeoms(), gapsOnly);
  assert.deepEqual(picked2.target, { kind: "gap", idx: 1 });
  // nothing valid at all → null
  assert.equal(pickDropTarget({ x: 600, y: 150 }, twoRowGeoms(), () => false), null);
});

test("pickDropTarget + moveBlock + validateLayout: the oracle gates real column joins", () => {
  const blocks = [
    { id: 0, kind: "static", label: "a" },
    { id: 1, kind: "static", label: "b" },
    { id: 2, kind: "dynamic", label: "c" },
  ];
  const model = {
    rows: [
      { cells: [{ block: 0, span: 6, heightPx: null }, { block: 1, span: 6, heightPx: null }] },
      { cells: [{ block: 2, span: 12, heightPx: null }] },
    ],
  };
  const oracle = (from) => (t) => {
    try {
      validateLayout(blocks, deepCopyModel(moveBlock(model, from.rowIdx, from.cellIdx, t)));
      return true;
    } catch {
      return false;
    }
  };
  // dragging block 1 over the PINNED row's middle: the column join is invalid
  // (dynamics stay alone) and so is the gap BELOW it (crossing the pin), so
  // the picker falls back to the gap above — never a dead zone.
  const overPinned = pickDropTarget({ x: 600, y: 500 }, twoRowGeoms(), oracle({ rowIdx: 0, cellIdx: 1 }));
  assert.deepEqual(overPinned.target, { kind: "gap", idx: 1 });
  // reordering within the 6/6 row still resolves to a column slot
  const reorder = pickDropTarget({ x: 100, y: 150 }, twoRowGeoms(), oracle({ rowIdx: 0, cellIdx: 1 }));
  assert.deepEqual(reorder.target, { kind: "cell", rowIdx: 0, cellIdx: 0 });
});
