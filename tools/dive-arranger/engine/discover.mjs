// Block discovery: parse an arbitrary dive source and find its rearrangeable
// blocks generically — the top-level children of the JSX element returned by
// the dive's single default-export component.
//
// recast + @babel/parser so the file round-trips with comments/formatting
// preserved: only nodes we actually move get reprinted; everything else keeps
// its original text.
import * as recast from "recast";
import { parse as babelParse } from "@babel/parser";
import { classifyRowContainer, gridChildUnits, sourceRowSpans } from "./rowcontainer.mjs";

// ── Parsing ─────────────────────────────────────────────────────────

const BABEL_OPTIONS = {
  sourceType: "module",
  allowUndeclaredExports: true,
  errorRecovery: false,
  // recast needs the token stream to reprint faithfully.
  tokens: true,
  // "typescript" is required for TS-style dives (e.g. the Growth KPIs dive uses
  // `(v: unknown): number`, `useDiveState<T>()`, `type X = ...`). babel supports
  // jsx + typescript together (the .tsx grammar); without it, a TS annotation
  // throws `Unexpected token, expected ","`.
  plugins: ["jsx", "typescript"],
};

export const arrangerParser = {
  parse: (src) => babelParse(src, BABEL_OPTIONS),
};

export function parseDive(source) {
  return recast.parse(String(source), { parser: arrangerParser });
}

export function printDive(ast) {
  return recast.print(ast).code;
}

// ── Locating the component ──────────────────────────────────────────

function isFunctionNode(node) {
  return (
    node &&
    (node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression")
  );
}

// Resolve the default export to a function node. Handles:
//   export default function Dive() {}
//   export default () => (...)
//   const Dive = () => (...); export default Dive;
//   export default memo(Dive) / memo(() => ...)
export function findDefaultExportComponent(ast) {
  const body = ast.program.body;
  const exportDecl = body.find((n) => n.type === "ExportDefaultDeclaration");
  if (!exportDecl) {
    throw new DiveShapeError("no `export default` found — a dive must default-export its component");
  }

  const resolve = (node, depth = 0) => {
    if (!node || depth > 4) return null;
    if (isFunctionNode(node)) return node;
    if (node.type === "Identifier") {
      const name = node.name;
      for (const stmt of body) {
        if (stmt.type === "FunctionDeclaration" && stmt.id && stmt.id.name === name) return stmt;
        if (stmt.type === "VariableDeclaration") {
          for (const d of stmt.declarations) {
            if (d.id.type === "Identifier" && d.id.name === name && d.init) {
              return resolve(d.init, depth + 1);
            }
          }
        }
        if (
          stmt.type === "ExportNamedDeclaration" &&
          stmt.declaration &&
          stmt.declaration.type === "FunctionDeclaration" &&
          stmt.declaration.id?.name === name
        ) {
          return stmt.declaration;
        }
      }
      return null;
    }
    // memo(Component), forwardRef(fn), etc: unwrap a call around a component.
    if (node.type === "CallExpression" && node.arguments.length >= 1) {
      return resolve(node.arguments[0], depth + 1);
    }
    return null;
  };

  const fn = resolve(exportDecl.declaration);
  if (!fn) {
    throw new DiveShapeError("could not resolve the default export to a function component");
  }
  return fn;
}

// The JSX the component returns. Arrow expression bodies and the LAST
// direct `return <jsx>` of the function body are supported; early returns
// (loading guards etc.) before it are fine and left untouched.
export function findReturnedJsx(fn) {
  if (fn.type === "ArrowFunctionExpression" && fn.body.type !== "BlockStatement") {
    const b = fn.body;
    if (b.type === "JSXElement" || b.type === "JSXFragment") return b;
    throw new DiveShapeError("component's arrow body is not a JSX element");
  }
  const stmts = fn.body.body;
  let found = null;
  for (const s of stmts) {
    if (
      s.type === "ReturnStatement" &&
      s.argument &&
      (s.argument.type === "JSXElement" || s.argument.type === "JSXFragment")
    ) {
      found = s.argument;
    }
  }
  if (!found) {
    throw new DiveShapeError(
      "no `return <jsx>` found at the top level of the component body (conditional-only returns are out of scope)",
    );
  }
  return found;
}

// ── Children / attribute helpers ────────────────────────────────────

export function significantChildren(node) {
  const children = node.children || [];
  return children.filter((c) => {
    if (c.type === "JSXText") return c.value.trim() !== "";
    if (c.type === "JSXExpressionContainer") return c.expression.type !== "JSXEmptyExpression";
    return true;
  });
}

export function getStringAttr(node, name) {
  if (node.type !== "JSXElement") return null;
  for (const a of node.openingElement.attributes || []) {
    if (a.type === "JSXAttribute" && a.name.type === "JSXIdentifier" && a.name.name === name) {
      if (a.value && a.value.type === "StringLiteral") return a.value.value;
      if (
        a.value &&
        a.value.type === "JSXExpressionContainer" &&
        (a.value.expression.type === "StringLiteral" || a.value.expression.type === "NumericLiteral")
      ) {
        return String(a.value.expression.value);
      }
    }
  }
  return null;
}

export function elementName(node) {
  if (node.type === "JSXFragment") return "<>";
  if (node.type !== "JSXElement") return node.type;
  const n = node.openingElement.name;
  if (n.type === "JSXIdentifier") return n.name;
  if (n.type === "JSXMemberExpression") {
    const parts = [];
    let cur = n;
    while (cur.type === "JSXMemberExpression") {
      parts.unshift(cur.property.name);
      cur = cur.object;
    }
    parts.unshift(cur.name);
    return parts.join(".");
  }
  return "?";
}

// Wrappers this tool wrote on a previous pass (recognized so a second edit
// sees the original blocks again instead of one opaque row).
export const ROW_MARKER = "data-dive-arranger";
const isArrangerRow = (n) => getStringAttr(n, ROW_MARKER) === "row";
const isArrangerCell = (n) => getStringAttr(n, ROW_MARKER) === "cell";

// ── Source row containers (one-level decomposition) ─────────────────

// A lowercase host element (<div>, <section>, …): renders exactly one DOM
// element, which the in-frame tile mapping depends on. (<Card/> could render
// null or a fragment.)
function isHostElement(node) {
  return (
    node.type === "JSXElement" &&
    node.openingElement.name.type === "JSXIdentifier" &&
    /^[a-z]/.test(node.openingElement.name.name)
  );
}

// Read a string-valued property out of an inline style={{ … }} object.
function styleStringProp(node, prop) {
  if (node.type !== "JSXElement") return null;
  for (const a of node.openingElement.attributes || []) {
    if (a.type !== "JSXAttribute" || a.name.name !== "style") continue;
    if (a.value?.type !== "JSXExpressionContainer") continue;
    const obj = a.value.expression;
    if (obj.type !== "ObjectExpression") continue;
    for (const p of obj.properties) {
      if (p.type !== "ObjectProperty" && p.type !== "Property") continue;
      const key =
        p.key.type === "Identifier" ? p.key.name :
        p.key.type === "StringLiteral" ? p.key.value : null;
      if (key === prop && p.value.type === "StringLiteral") return p.value.value;
    }
  }
  return null;
}

/**
 * Decompose a top-level child that is itself a side-by-side ROW CONTAINER —
 * e.g. `<div className="grid grid-cols-2 gap-8"> <div>{chart}</div>
 * <div>{chart}</div> </div>` — into its element children as separate blocks
 * forming a multi-column row, so each tile is independently movable (without
 * this, the whole wrapper is one opaque 12/12 block). Descends exactly ONE
 * level, and only at the top level of the layout root.
 *
 * Returns { cells: [{ node, span }] } or null when out of scope. Conservative
 * vetoes (the container then stays ONE movable block, exactly as before):
 *  - container or any child is not a lowercase host element;
 *  - any dynamic child ({cond ? …}, {xs.map(…)}) or text child — a dynamic
 *    cell could never satisfy validateLayout's "pinned = alone in its own
 *    full-width row" rule, so the container is kept whole instead;
 *  - grid children whose column units exceed the template (CSS would wrap
 *    them to a second visual row).
 *
 * Spans come from the template: grid-cols-2 → 6/6, grid-cols-4 (or an inline
 * repeat(4, …)) → 3/3/3/3, flex rows equal-split.
 *
 * EMPTY SPACER children (e.g. `<div />` used to right-align a single tile)
 * are KEPT as real span-carrying blocks rather than dropped: that reproduces
 * the original visual exactly (the real tile keeps its column) and
 * round-trips cleanly — apply re-wraps the spacer into an ordinary arranger
 * cell, and if the real tile is later moved away the spacer reflows like any
 * other block (a full-width empty <div/> renders as nothing).
 */
export function sourceRowPlan(node) {
  if (!isHostElement(node)) return null;
  if (getStringAttr(node, ROW_MARKER) != null) return null;
  const info = classifyRowContainer({
    classAttr: getStringAttr(node, "className") || "",
    display: styleStringProp(node, "display"),
    gridTemplateColumns: styleStringProp(node, "gridTemplateColumns"),
    flexDirection: styleStringProp(node, "flexDirection"),
  });
  if (!info) return null;
  const kids = significantChildren(node);
  if (kids.length < 2 || !kids.every(isHostElement)) return null;
  const units = kids.map((k) =>
    info.kind === "grid" ? gridChildUnits(getStringAttr(k, "className") || "", info.cols) : 1,
  );
  const spans = sourceRowSpans(info, units);
  if (!spans) return null;
  return { cells: kids.map((k, i) => ({ node: k, span: spans[i] })) };
}

// ── Labels & anchor texts (for cards + DOM snapshot matching) ───────

function collectTexts(node, out, cap) {
  if (!node || out.length >= cap) return;
  if (node.type === "JSXText") {
    const t = node.value.replace(/\s+/g, " ").trim();
    if (t.length >= 3) out.push(t);
    return;
  }
  if (node.type === "JSXElement" || node.type === "JSXFragment") {
    for (const c of node.children || []) collectTexts(c, out, cap);
  } else if (node.type === "JSXExpressionContainer") {
    const e = node.expression;
    if (e.type === "StringLiteral" && e.value.trim().length >= 3) out.push(e.value.trim());
    if (e.type === "ConditionalExpression" || e.type === "LogicalExpression") {
      // dig one level into simple conditionals for anchor text
      for (const k of ["consequent", "alternate", "right"]) {
        if (e[k] && (e[k].type === "JSXElement" || e[k].type === "JSXFragment")) {
          collectTexts(e[k], out, cap);
        }
      }
    }
  }
}

const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

function findHeadingText(node) {
  if (!node) return null;
  if (node.type === "JSXElement") {
    if (HEADINGS.has(elementName(node))) {
      const texts = [];
      collectTexts(node, texts, 2);
      if (texts.length) return texts.join(" ").slice(0, 60);
    }
    for (const c of significantChildren(node)) {
      const t = findHeadingText(c);
      if (t) return t;
    }
  }
  return null;
}

function blockLabel(node, index) {
  if (node.type === "JSXElement") {
    const explicit =
      getStringAttr(node, "data-arranger-name") || getStringAttr(node, "id") || null;
    if (explicit) return explicit;
    const heading = findHeadingText(node);
    if (heading) return heading;
    // Empty spacer columns (kept as blocks so decomposed source rows keep
    // their alignment) get a recognizable label.
    if (significantChildren(node).length === 0) return `<${elementName(node)}> (empty)`;
    return `<${elementName(node)}>`;
  }
  if (node.type === "JSXExpressionContainer") {
    const e = node.expression;
    const kind =
      e.type === "ConditionalExpression" ? "conditional" :
      e.type === "LogicalExpression" ? "conditional" :
      e.type === "CallExpression" ? "expression" : "expression";
    return `{${kind}} #${index}`;
  }
  return `block #${index}`;
}

// ── Discovery ───────────────────────────────────────────────────────

export class DiveShapeError extends Error {}

// If the returned root is just a chain of single-child wrappers
// (<Provider><div>{blocks}</div></Provider>), descend to the element that
// actually holds multiple children.
function descendToLayoutRoot(root) {
  let cur = root;
  for (let i = 0; i < 4; i++) {
    const kids = significantChildren(cur);
    // Never descend INTO an arranger row wrapper: a layout that groups every
    // block into one row leaves the root with a single row-wrapper child,
    // which must be unwrapped as a row, not treated as the layout root.
    // Likewise never descend INTO a source row container: a root whose single
    // child is a multi-column grid/flex row must decompose it as a row, not
    // treat it as the layout root (its children would lose their columns).
    if (
      kids.length === 1 &&
      kids[0].type === "JSXElement" &&
      !isArrangerRow(kids[0]) &&
      !sourceRowPlan(kids[0])
    ) {
      cur = kids[0];
    } else {
      break;
    }
  }
  return cur;
}

/**
 * Discover the rearrangeable blocks of a dive.
 *
 * Returns { ast, root, blocks, rows }:
 *  - blocks: [{ id, kind: 'static'|'dynamic', node, label, name, code, texts }]
 *    in source order; `id` is the source-order index (the stable handle the
 *    layout model uses).
 *  - rows: the CURRENT layout as rows of cells [{ block, span, heightPx }] —
 *    reconstructed from arranger wrappers if this dive was arranged before,
 *    else one full-width row per block.
 */
export function discoverBlocks(source) {
  const ast = parseDive(source);
  const fn = findDefaultExportComponent(ast);
  const returned = findReturnedJsx(fn);
  const root = descendToLayoutRoot(returned);

  const blocks = [];
  const rows = [];

  const addBlock = (node, { span = 12, heightPx = null, row }) => {
    const id = blocks.length;
    const kind = node.type === "JSXExpressionContainer" ? "dynamic" : "static";
    const texts = [];
    collectTexts(node, texts, 8);
    blocks.push({
      id,
      kind,
      node,
      name: elementName(node),
      label: blockLabel(node, id),
      code: recast.print(node).code,
      texts,
    });
    row.cells.push({ block: id, span, heightPx });
  };

  for (const child of significantChildren(root)) {
    if (child.type === "JSXElement" && isArrangerRow(child)) {
      const row = { cells: [] };
      rows.push(row);
      for (const cell of significantChildren(child)) {
        if (cell.type === "JSXElement" && isArrangerCell(cell)) {
          const span = Number(getStringAttr(cell, "data-arranger-span") || 12) || 12;
          const hRaw = getStringAttr(cell, "data-arranger-h");
          const heightPx = hRaw ? Number(hRaw) || null : null;
          const inner = significantChildren(cell);
          if (inner.length === 1) {
            addBlock(inner[0], { span, heightPx, row });
          } else {
            // Unexpected cell contents — treat the cell itself as a block so
            // nothing is lost.
            addBlock(cell, { span, heightPx, row });
          }
        } else {
          // A non-cell child inside one of our rows: keep it as a block.
          addBlock(cell, { span: 12, heightPx: null, row });
        }
      }
      if (row.cells.length === 0) rows.pop(); // empty stale wrapper: drop it
    } else {
      // A top-level child that is itself a multi-column row container in the
      // DIVE'S OWN source (grid grid-cols-N / inline grid / flex row) is
      // decomposed one level: its element children become separate blocks
      // forming a row, same representation as an arranger-authored row.
      const srcRow = child.type === "JSXElement" ? sourceRowPlan(child) : null;
      const row = { cells: [] };
      rows.push(row);
      if (srcRow) {
        for (const cell of srcRow.cells) {
          addBlock(cell.node, { span: cell.span, heightPx: null, row });
        }
      } else {
        addBlock(child, { span: 12, heightPx: null, row });
      }
    }
  }

  if (blocks.length === 0) {
    throw new DiveShapeError("the component's root element has no children to arrange");
  }

  return { ast, fn, root, blocks, rows };
}
