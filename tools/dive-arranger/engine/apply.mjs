// Layout application: take a dive source + a layout (rows of cells referencing
// discovered block ids), rebuild the root element's children in that
// arrangement, and recast-print — everything not moved keeps its exact
// original text (comments, helpers, hooks, queries).
//
// Layout model (what the overlay UI produces):
//   { rows: [ { cells: [ { block: <id>, span?: 1..12, heightPx?: number } ] } ] }
//
// Multi-cell rows (and any cell with a height) are wrapped:
//   <div data-dive-arranger="row" style={{display:'grid', ...}}>
//     <div data-dive-arranger="cell" data-arranger-span="6" style={{...}}>
//       <OriginalBlock … />
//     </div>
//   </div>
// The data-dive-arranger markers let discovery unwrap these on the next edit,
// so arranging is idempotent — blocks never get buried in stale wrappers.
//
// Rows that discovery DECOMPOSED out of a source grid/flex container (see
// sourceRowPlan in discover.mjs) go through the same path: the first apply
// re-wraps their tiles into a marked arranger row (the original container
// element and its classes are replaced by the equivalent 12-col wrapper), so
// source rows and arranger rows share one canonical representation from then
// on. Re-discovery unwraps the marker row to the same blocks/spans/order —
// discover→apply→discover is stable.
import * as recast from "recast";
import { discoverBlocks, arrangerParser, significantChildren } from "./discover.mjs";
import { LayoutError, validateLayout, GRID_COLS, GRID_GAP } from "./validate.mjs";

const b = recast.types.builders;

// Validation lives in validate.mjs (recast-free, so the in-iframe content
// script can bundle it standalone); re-exported here for compatibility.
export { LayoutError, validateLayout };

// ── JSX construction (via template parsing, so recast pretty-prints) ─

function parseJsxTemplate(src) {
  // No parentheses around the template: recast records source parens and
  // would reprint them inside the JSX children, where a re-parse turns them
  // into literal "(" / ")" JSXText nodes.
  const ast = recast.parse(`const __t = ${src};`, { parser: arrangerParser });
  return ast.program.body[0].declarations[0].init;
}

function styleEntries(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`)
    .join(", ");
}

const SLOT = "__DiveArrangerSlot__";

function buildCell(cell) {
  const style = { gridColumn: `span ${cell.span}`, minWidth: 0 };
  if (cell.heightPx != null) {
    style.height = cell.heightPx;
    style.overflow = "auto";
  }
  const attrs = [
    `data-dive-arranger="cell"`,
    `data-arranger-span="${cell.span}"`,
    cell.heightPx != null ? `data-arranger-h="${cell.heightPx}"` : null,
    `style={{ ${styleEntries(style)} }}`,
  ].filter(Boolean).join(" ");
  return `<div ${attrs}><${SLOT} /></div>`;
}

function buildRowElement(row, blocksById) {
  const rowStyle = {
    display: "grid",
    gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`,
    gap: GRID_GAP,
    alignItems: "start",
  };
  const src = [
    `<div data-dive-arranger="row" style={{ ${styleEntries(rowStyle)} }}>`,
    ...row.cells.map((c) => `  ${buildCell(c)}`),
    `</div>`,
  ].join("\n");
  const el = parseJsxTemplate(src);

  // Replace each slot with the real (original, formatting-preserving) node.
  let i = 0;
  recast.types.visit(el, {
    visitJSXElement(path) {
      const name = path.node.openingElement.name;
      if (name.type === "JSXIdentifier" && name.name === SLOT) {
        const blk = blocksById.get(row.cells[i].block);
        i += 1;
        path.replace(blk.node);
        return false;
      }
      this.traverse(path);
    },
  });
  if (i !== row.cells.length) throw new LayoutError("internal: slot substitution mismatch");
  return el;
}

// ── Main entry ──────────────────────────────────────────────────────

/**
 * Apply a layout to a dive source. Returns { code, blocks, rows } where
 * `code` is the new source and blocks/rows are the POST-apply discovery
 * (useful to refresh the UI without re-fetching).
 */
export function applyLayout(source, layout) {
  const { ast, root, blocks } = discoverBlocks(source);
  const flat = validateLayout(blocks, layout);
  const blocksById = new Map(blocks.map((blk) => [blk.id, blk]));

  const newChildren = [];
  const nl = () => b.jsxText("\n");
  for (const row of layout.rows) {
    newChildren.push(nl());
    const solo = row.cells.length === 1;
    const cell = row.cells[0];
    const blk = blocksById.get(cell.block);
    const bare = solo && cell.span >= GRID_COLS && cell.heightPx == null;
    if (bare || blk.kind === "dynamic") {
      // Full-width unsized block (or pinned dynamic): emit the node untouched.
      newChildren.push(blk.node);
    } else {
      newChildren.push(buildRowElement(row, blocksById));
    }
  }
  newChildren.push(nl());

  root.children = newChildren;

  const code = recast.print(ast).code;

  // Self-check: the output must still parse, discover, and match the layout.
  const after = discoverBlocks(code);
  const expectedOrder = flat.map(({ blk }) => blk.kind + ":" + normalize(blk.code));
  const actualOrder = after.blocks.map((blk) => blk.kind + ":" + normalize(blk.code));
  if (expectedOrder.length !== actualOrder.length) {
    throw new LayoutError(
      `self-check failed: expected ${expectedOrder.length} blocks after apply, found ${actualOrder.length}: ` +
        after.blocks.map((blk) => `${blk.kind}:${blk.label}`).join(" | "),
    );
  }
  for (let i = 0; i < expectedOrder.length; i++) {
    if (expectedOrder[i] !== actualOrder[i]) {
      throw new LayoutError(`self-check failed: block ${i} does not match the requested layout`);
    }
  }

  return { code, blocks: after.blocks, rows: after.rows };
}

const normalize = (s) => s.replace(/\s+/g, " ").trim();

export { significantChildren };
