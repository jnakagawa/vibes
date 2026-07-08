// Pure engine tests — no network, no MotherDuck. `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverBlocks,
  applyLayout,
  LayoutError,
  DiveShapeError,
  sqlStatementsForUpdate,
  encodeContentBase64,
} from "../engine/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = readFileSync(path.join(HERE, "sample-dive.jsx"), "utf8");
const CHAT = readFileSync(path.join(HERE, "sample-chat-dive.jsx"), "utf8");

// Deep-copy discovery rows into a layout (applyLayout mutates its input).
const layoutOf = (rows) => ({ rows: rows.map((r) => ({ cells: r.cells.map((c) => ({ ...c })) })) });
const spansOf = (rows) => rows.map((r) => r.cells.map((c) => c.span));
const squash = (s) => s.replace(/\s+/g, " ").trim();

test("discovers the sample dive's five blocks with kinds and labels", () => {
  const { blocks, rows } = discoverBlocks(SAMPLE);
  assert.equal(blocks.length, 5);
  assert.deepEqual(blocks.map((b) => b.kind), ["static", "static", "dynamic", "static", "static"]);
  assert.deepEqual(blocks.map((b) => b.label).slice(0, 2), ["alpha", "beta"]);
  assert.equal(rows.length, 5); // unarranged: one full-width row per block
  // gamma's .map is INSIDE the block, so gamma is still movable
  assert.equal(blocks[3].kind, "static");
});

test("reorders within a segment, wraps a two-up row, sets a height", () => {
  const layout = {
    rows: [
      { cells: [{ block: 1, span: 6 }, { block: 0, span: 6, heightPx: 240 }] },
      { cells: [{ block: 2 }] }, // pinned conditional stays put
      { cells: [{ block: 4 }] },
      { cells: [{ block: 3 }] },
    ],
  };
  const { code } = applyLayout(SAMPLE, layout);

  // beta now precedes alpha
  assert.ok(code.indexOf('id="beta"') < code.indexOf('id="alpha"'));
  // delta precedes gamma
  assert.ok(code.indexOf('id="delta"') < code.indexOf('id="gamma"'));
  // arranger wrappers present with span + height markers
  assert.match(code, /data-dive-arranger="row"/);
  assert.match(code, /data-arranger-span="6"/);
  assert.match(code, /data-arranger-h="240"/);
  // untouched code survives byte-exactly
  assert.ok(code.includes('const GREETING = "hello from the arranger harness"; // module-level helper (must survive)'));
  assert.ok(code.includes("{/* keep this inner comment */}"));
  assert.ok(code.includes('const showNote = items.length > 2; // derived flag (must survive)'));
  assert.ok(code.includes('"#231f20", // brand ink'));
  // still a single default export component
  assert.equal((code.match(/export default/g) || []).length, 1);
});

test("apply is idempotent: re-discovery unwraps arranger rows back to blocks", () => {
  const layout = {
    rows: [
      { cells: [{ block: 1, span: 6 }, { block: 0, span: 6, heightPx: 240 }] },
      { cells: [{ block: 2 }] },
      { cells: [{ block: 4 }] },
      { cells: [{ block: 3 }] },
    ],
  };
  const first = applyLayout(SAMPLE, layout);
  const again = discoverBlocks(first.code);
  assert.equal(again.blocks.length, 5);
  assert.deepEqual(again.blocks.map((b) => b.label), [
    "beta", "alpha", "{conditional} #2", "delta", "gamma",
  ]);
  // prior layout is recovered from the wrappers
  assert.deepEqual(again.rows[0].cells.map((c) => c.span), [6, 6]);
  assert.equal(again.rows[0].cells[1].heightPx, 240);

  // second apply: restore original order — wrappers must not accumulate
  const restore = {
    rows: [
      { cells: [{ block: 1 }] }, // alpha (id 1 in the NEW discovery order)
      { cells: [{ block: 0 }] }, // beta
      { cells: [{ block: 2 }] },
      { cells: [{ block: 4 }] }, // gamma
      { cells: [{ block: 3 }] }, // delta
    ],
  };
  const second = applyLayout(first.code, restore);
  assert.equal((second.code.match(/data-dive-arranger="row"/g) || []).length, 0);
  assert.ok(second.code.indexOf('id="alpha"') < second.code.indexOf('id="beta"'));
});

test("rejects moving a static block across a pinned dynamic block", () => {
  const layout = {
    rows: [
      { cells: [{ block: 3 }] }, // gamma hoisted above the conditional — illegal
      { cells: [{ block: 0 }] },
      { cells: [{ block: 1 }] },
      { cells: [{ block: 2 }] },
      { cells: [{ block: 4 }] },
    ],
  };
  assert.throws(() => applyLayout(SAMPLE, layout), LayoutError);
});

test("rejects resizing or pairing a dynamic block", () => {
  const base = [
    { cells: [{ block: 0 }] },
    { cells: [{ block: 1 }] },
  ];
  assert.throws(
    () => applyLayout(SAMPLE, { rows: [...base, { cells: [{ block: 2, span: 6 }, { block: 3, span: 6 }] }, { cells: [{ block: 4 }] }] }),
    LayoutError,
  );
});

test("rejects incomplete layouts and duplicate blocks", () => {
  assert.throws(() => applyLayout(SAMPLE, { rows: [{ cells: [{ block: 0 }] }] }), LayoutError);
  assert.throws(
    () =>
      applyLayout(SAMPLE, {
        rows: [0, 0, 1, 2, 3, 4].map((i) => ({ cells: [{ block: i }] })),
      }),
    LayoutError,
  );
});

test("handles arrow-body components and identifier default exports", () => {
  const arrow = `
const Dive = () => (
  <section>
    <div id="one">One</div>
    <div id="two">Two</div>
  </section>
);
export default Dive;
`;
  const { blocks } = discoverBlocks(arrow);
  assert.deepEqual(blocks.map((b) => b.label), ["one", "two"]);

  const swapped = applyLayout(arrow, {
    rows: [{ cells: [{ block: 1 }] }, { cells: [{ block: 0 }] }],
  });
  assert.ok(swapped.code.indexOf('id="two"') < swapped.code.indexOf('id="one"'));
});

test("descends through single-child provider wrappers to the layout root", () => {
  const wrapped = `
export default function Dive() {
  return (
    <Provider>
      <div className="page">
        <div id="a">A</div>
        <div id="b">B</div>
        <div id="c">C</div>
      </div>
    </Provider>
  );
}
`;
  const { blocks } = discoverBlocks(wrapped);
  assert.deepEqual(blocks.map((b) => b.label), ["a", "b", "c"]);
});

test("uses the last top-level return (early loading guards are fine)", () => {
  const guarded = `
export default function Dive() {
  const q = { isLoading: true };
  if (q.isLoading) return <div>loading…</div>;
  return (
    <main>
      <div id="x">X</div>
      <div id="y">Y</div>
    </main>
  );
}
`;
  const { blocks } = discoverBlocks(guarded);
  assert.deepEqual(blocks.map((b) => b.label), ["x", "y"]);
});

test("errors clearly on unsupported shapes", () => {
  assert.throws(() => discoverBlocks("const x = 1;"), DiveShapeError);
  assert.throws(
    () => discoverBlocks("export default function D() { return null; }"),
    DiveShapeError,
  );
});

test("fragment roots work", () => {
  const frag = `
export default function Dive() {
  return (
    <>
      <div id="p">P</div>
      <div id="q">Q</div>
    </>
  );
}
`;
  const { blocks } = discoverBlocks(frag);
  assert.deepEqual(blocks.map((b) => b.label), ["p", "q"]);
  const out = applyLayout(frag, { rows: [{ cells: [{ block: 1 }] }, { cells: [{ block: 0 }] }] });
  assert.ok(out.code.indexOf('id="q"') < out.code.indexOf('id="p"'));
});

test("grouping every static block into rows still round-trips (no descent into row wrappers)", () => {
  const simple = `
export default function Dive() {
  return (
    <main>
      <div id="a">Aaaa</div>
      <div id="b">Bbbb</div>
    </main>
  );
}
`;
  const grouped = applyLayout(simple, {
    rows: [{ cells: [{ block: 0, span: 6 }, { block: 1, span: 6 }] }],
  });
  // root now has a single child: the arranger row. Re-discovery must unwrap
  // it (two blocks), not descend into it.
  const re = discoverBlocks(grouped.code);
  assert.deepEqual(re.blocks.map((b) => b.label), ["a", "b"]);
  assert.deepEqual(re.rows[0].cells.map((c) => c.span), [6, 6]);
  // and a further apply must not nest wrappers
  const back = applyLayout(grouped.code, {
    rows: [{ cells: [{ block: 0 }] }, { cells: [{ block: 1 }] }],
  });
  assert.equal((back.code.match(/data-dive-arranger/g) || []).length, 0);
});

// ── Source row-container decomposition (grid grid-cols-N / flex rows) ──

test("decomposes top-level source grid rows into independently movable blocks", () => {
  const { blocks, rows } = discoverBlocks(CHAT);
  assert.deepEqual(blocks.map((b) => b.label), [
    "header",
    "activity",
    "errors",
    "<div> (empty)", // the spacer column is kept as a block
    "funnel",
    "{conditional} #5",
    "modelmix",
    "latency",
  ]);
  assert.deepEqual(blocks.map((b) => b.kind), [
    "static", "static", "static", "static", "static", "dynamic", "static", "static",
  ]);
  // each grid grid-cols-2 row becomes ONE model row with two 6/6 cells
  assert.deepEqual(rows.map((r) => r.cells.map((c) => c.block)), [[0], [1, 2], [3, 4], [5], [6, 7]]);
  assert.deepEqual(spansOf(rows), [[12], [6, 6], [6, 6], [12], [6, 6]]);
});

test("decomposed tiles move independently; extracting one collapses the source grid", () => {
  const { rows } = discoverBlocks(CHAT);
  const layout = layoutOf(rows);
  layout.rows[1].cells.reverse(); // swap Activity ∥ Errors within their row
  layout.rows.splice(
    2, 1,
    { cells: [{ block: 4, span: 12 }] }, // funnel extracted to full width…
    { cells: [{ block: 3, span: 12 }] }, // …its spacer reflows alone
  );
  const { code } = applyLayout(CHAT, layout);

  assert.ok(code.indexOf('id="errors"') < code.indexOf('id="activity"'));
  // the original source grid containers are dissolved into arranger rows
  assert.equal((code.match(/className="grid grid-cols-2/g) || []).length, 0);
  assert.match(code, /data-dive-arranger="row"/);
  // untouched code survives byte-exactly
  assert.ok(code.includes("const fmtCount = (n) => n.toLocaleString(); // helper (must survive)"));
  assert.ok(code.includes("{/* activity chart body (must survive) */}"));
  assert.ok(code.includes("const loading = data.days.length === 0; // derived flag (must survive)"));

  const re = discoverBlocks(code);
  assert.deepEqual(spansOf(re.rows), [[12], [6, 6], [12], [12], [12], [6, 6]]);
  assert.deepEqual(re.blocks.map((b) => b.label), [
    "header", "errors", "activity", "funnel", "<div> (empty)", "{conditional} #5", "modelmix", "latency",
  ]);
});

test("decomposed tiles still cannot cross the pinned conditional", () => {
  const { rows } = discoverBlocks(CHAT);
  const layout = layoutOf(rows);
  // hoist modelmix (after the pin) above the conditional — illegal
  const [mix] = layout.rows[4].cells.splice(0, 1);
  layout.rows[4].cells[0].span = 12;
  layout.rows.splice(3, 0, { cells: [{ block: mix.block, span: 12 }] });
  assert.throws(() => applyLayout(CHAT, layout), LayoutError);
});

test("discover→apply→discover is stable for decomposed source rows", () => {
  const d1 = discoverBlocks(CHAT);
  const a1 = applyLayout(CHAT, layoutOf(d1.rows)); // identity layout
  const d2 = discoverBlocks(a1.code);
  assert.deepEqual(d2.blocks.map((b) => b.label), d1.blocks.map((b) => b.label));
  assert.deepEqual(d2.blocks.map((b) => b.kind), d1.blocks.map((b) => b.kind));
  assert.deepEqual(spansOf(d2.rows), spansOf(d1.rows));
  assert.deepEqual(
    d2.blocks.map((b) => squash(b.code)),
    d1.blocks.map((b) => squash(b.code)),
  );
  // …and a second identity apply is byte-stable (wrappers never accumulate)
  const a2 = applyLayout(a1.code, layoutOf(d2.rows));
  assert.equal(a2.code, a1.code);
});

test("grid-cols-4 and inline repeat(4, …) both decompose to 3/3/3/3", () => {
  const four = `
export default function D() {
  return (
    <main>
      <div className="grid grid-cols-4 gap-4">
        <div id="a">Aaa</div><div id="b">Bbb</div><div id="c">Ccc</div><div id="d">Ddd</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
        <div id="e">Eee</div><div id="f">Fff</div><div id="g">Ggg</div><div id="h">Hhh</div>
      </div>
    </main>
  );
}
`;
  const { blocks, rows } = discoverBlocks(four);
  assert.equal(blocks.length, 8);
  assert.deepEqual(spansOf(rows), [[3, 3, 3, 3], [3, 3, 3, 3]]);
});

test("flex rows decompose with an equal split; flex-col and col-span grids derive correctly", () => {
  const src = `
export default function D() {
  return (
    <main>
      <div className="flex gap-4">
        <div id="l">Lll</div><div id="r">Rrr</div>
      </div>
      <div className="flex flex-col">
        <div id="v1">Vvv</div><div id="v2">Www</div>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div id="wide" className="col-span-2">Wide</div><div id="thin">Thin</div>
      </div>
    </main>
  );
}
`;
  const { blocks, rows } = discoverBlocks(src);
  // flex row → two 6/6 blocks; flex-col stays ONE block; col-span-2 of 3 → 8/4
  assert.deepEqual(spansOf(rows), [[6, 6], [12], [8, 4]]);
  assert.deepEqual(blocks.map((b) => b.label), ["l", "r", "<div>", "wide", "thin"]);
});

test("a source row with a dynamic child stays one opaque block, as before", () => {
  const src = `
export default function D() {
  const flag = true;
  return (
    <main>
      <div id="solo">Solo</div>
      <div className="grid grid-cols-2 gap-4">
        {flag ? <div id="maybe">Maybe</div> : null}
        <div id="always">Always</div>
      </div>
    </main>
  );
}
`;
  const { blocks, rows } = discoverBlocks(src);
  // the grid is NOT decomposed (a dynamic cell can't satisfy the pinned-alone
  // rule) — it stays a single movable static block
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => b.kind), ["static", "static"]);
  assert.deepEqual(spansOf(rows), [[12], [12]]);
});

test("a root whose single child is a source grid row still decomposes it", () => {
  const src = `
export default function D() {
  return (
    <div className="page">
      <div className="grid grid-cols-2 gap-4">
        <div id="left">Left</div>
        <div id="right">Right</div>
      </div>
    </div>
  );
}
`;
  const { blocks, rows } = discoverBlocks(src);
  assert.deepEqual(blocks.map((b) => b.label), ["left", "right"]);
  assert.deepEqual(spansOf(rows), [[6, 6]]);
});

test("grid children that would wrap to a second CSS row stay one block", () => {
  const src = `
export default function D() {
  return (
    <main>
      <div className="grid grid-cols-2 gap-4">
        <div id="a">Aaa</div><div id="b">Bbb</div><div id="c">Ccc</div>
      </div>
      <div id="tail">Tail</div>
    </main>
  );
}
`;
  const { blocks } = discoverBlocks(src);
  assert.equal(blocks.length, 2); // wrapping grid kept opaque + tail
});

// ── Deleting blocks (a layout may omit STATIC blocks; dynamics never) ──

test("delete: omitting the empty spacer <div/> from its 2-col row drops the node and reflows the sibling", () => {
  const { blocks, rows } = discoverBlocks(CHAT);
  assert.equal(blocks[3].label, "<div> (empty)"); // the spacer column
  const layout = layoutOf(rows);
  layout.rows[2] = { cells: [{ block: 4, span: 12 }] }; // funnel reflowed solo; spacer (3) deleted
  const { code } = applyLayout(CHAT, layout);

  // output re-parses and re-discovers exactly one fewer block; the spacer node is gone
  const re = discoverBlocks(code);
  assert.equal(re.blocks.length, blocks.length - 1);
  assert.ok(!re.blocks.some((b) => b.label === "<div> (empty)"));
  // the spacer node is gone from the COMPONENT (the file's leading comment
  // legitimately mentions "<div />" and must survive byte-exactly)
  assert.ok(!code.slice(code.indexOf("export default")).includes("<div />"));
  // the surviving sibling is a full-width solo row now
  const funnelId = re.blocks.find((b) => b.label === "funnel").id;
  const funnelRow = re.rows.find((r) => r.cells.some((c) => c.block === funnelId));
  assert.deepEqual(funnelRow.cells.map((c) => [c.block, c.span]), [[funnelId, 12]]);
  // everything else survives byte-exactly
  assert.ok(code.includes("const fmtCount = (n) => n.toLocaleString(); // helper (must survive)"));
  assert.ok(code.includes("{/* activity chart body (must survive) */}"));
});

test("delete: omitting a real chart tile removes its node and its text from the output", () => {
  const { blocks, rows } = discoverBlocks(CHAT);
  const layout = layoutOf(rows);
  layout.rows[4] = { cells: [{ block: 6, span: 12 }] }; // modelmix solo; latency (7) deleted
  const { code } = applyLayout(CHAT, layout);
  assert.ok(!code.includes('id="latency"'));
  assert.ok(!code.includes("p50 / p95 per day")); // the deleted node's text is gone
  const re = discoverBlocks(code);
  assert.equal(re.blocks.length, blocks.length - 1);
  assert.ok(code.includes('id="modelmix"'));
});

test("delete: a layout omitting a DYNAMIC block throws LayoutError", () => {
  const { rows } = discoverBlocks(CHAT);
  const layout = layoutOf(rows);
  layout.rows.splice(3, 1); // drop the pinned conditional's row
  assert.throws(() => applyLayout(CHAT, layout), LayoutError);
  assert.throws(() => applyLayout(CHAT, layout), /cannot be deleted/);
});

test("delete: adjacent to a pinned dynamic still validates; a cross-segment move still fails", () => {
  const { rows } = discoverBlocks(CHAT);
  // delete funnel (4) — the tile directly ABOVE the pinned conditional (5)
  const del = layoutOf(rows);
  del.rows[2] = { cells: [{ block: 3, span: 12 }] }; // spacer survives, reflowed
  const { code } = applyLayout(CHAT, del);
  assert.ok(!code.includes('id="funnel"'));
  assert.equal(discoverBlocks(code).blocks.length, 7);

  // …but with that delete in place, hoisting modelmix (6) above the pin still fails
  const crossed = layoutOf(rows);
  crossed.rows[2] = { cells: [{ block: 3, span: 12 }] }; // funnel deleted
  const [mix] = crossed.rows[4].cells.splice(0, 1);
  crossed.rows[4].cells[0].span = 12;
  crossed.rows.splice(3, 0, { cells: [{ block: mix.block, span: 12 }] });
  assert.throws(() => applyLayout(CHAT, crossed), LayoutError);
});

test("base64 content routing round-trips unicode and quotes", () => {
  const nasty = `const s = 'it\\'s'; // ünïcødé ✓ \`backticks\` "quotes" \${tpl}`;
  const b64 = encodeContentBase64(nasty);
  assert.equal(Buffer.from(b64, "base64").toString("utf8"), nasty);
  const stmts = sqlStatementsForUpdate("12345678-1234-1234-1234-123456789abc", nasty);
  assert.equal(stmts.length, 2);
  assert.match(stmts[0], /^SET VARIABLE dive_arranger_content = decode\(from_base64\('[A-Za-z0-9+/=]+'\)\)$/);
  assert.match(stmts[1], /^FROM MD_UPDATE_DIVE_CONTENT\(id := '12345678-1234-1234-1234-123456789abc', content := getvariable\('dive_arranger_content'\)\)$/);
});

test("rejects non-UUID dive ids (no SQL injection surface)", () => {
  assert.throws(() => sqlStatementsForUpdate("abc'); DROP TABLE x; --", "x"), /not a dive UUID/);
});
