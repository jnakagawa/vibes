// Headless smoke test of the in-iframe arranger (extension/frame.js) against
// a minimal fake DOM: drives the real postMessage protocol (ARRANGE_INIT →
// INIT_ACK/MAPPED, MODEL, ARRANGE_CANCEL → EXITED) and asserts the grid
// placement + undo/restore semantics. This does NOT verify real-browser
// rendering, Chrome's iframe injection, or the drag pointer UX — those need a
// live session.
import { test } from "node:test";
import assert from "node:assert/strict";

// ── Minimal fake DOM ──────────────────────────────────────────────────

function makeEl(tag, attrs = {}) {
  const e = {
    tagName: String(tag).toUpperCase(),
    _attrs: { ...attrs },
    children: [],
    parentElement: null,
    _textParts: [],
    style: {},
    className: "",
    title: "",
    id: "",
    classList: { add() {}, remove() {} },
    rect: null,
    getAttribute(name) {
      return Object.hasOwn(this._attrs, name) ? this._attrs[name] : null;
    },
    setAttribute(name, value) {
      this._attrs[name] = String(value);
      if (name === "style") this.style = {}; // resetting inline styles, DOM-style
    },
    removeAttribute(name) {
      delete this._attrs[name];
      if (name === "style") this.style = {};
    },
    hasAttribute(name) {
      return Object.hasOwn(this._attrs, name);
    },
    get childElementCount() {
      return this.children.length;
    },
    get firstElementChild() {
      return this.children[0] ?? null;
    },
    get nextSibling() {
      if (!this.parentElement) return null;
      const i = this.parentElement.children.indexOf(this);
      return this.parentElement.children[i + 1] ?? null;
    },
    get parentNode() {
      return this.parentElement; // teardown's move-restore checks parentNode
    },
    get textContent() {
      return this._textParts.join("") + this.children.map((c) => c.textContent).join("");
    },
    set textContent(v) {
      this._textParts = v ? [String(v)] : [];
      for (const c of this.children) c.parentElement = null;
      this.children = [];
    },
    appendChild(node) {
      return this.insertBefore(node, null);
    },
    append(...nodes) {
      for (const n of nodes) this.appendChild(n);
    },
    insertBefore(node, ref) {
      if (node.parentElement) {
        const arr = node.parentElement.children;
        arr.splice(arr.indexOf(node), 1);
      }
      const i = ref ? this.children.indexOf(ref) : -1;
      if (i === -1) this.children.push(node);
      else this.children.splice(i, 0, node);
      node.parentElement = this;
      return node;
    },
    remove() {
      if (this.parentElement) {
        const arr = this.parentElement.children;
        arr.splice(arr.indexOf(this), 1);
        this.parentElement = null;
      }
    },
    _listeners: {},
    addEventListener(type, fn) {
      (this._listeners[type] ??= []).push(fn);
    },
    removeEventListener(type, fn) {
      const a = this._listeners[type];
      if (a) {
        const i = a.indexOf(fn);
        if (i >= 0) a.splice(i, 1);
      }
    },
    attachShadow() {
      const s = makeEl("shadow-root");
      this._shadow = s;
      return s;
    },
    getBoundingClientRect() {
      return this.rect ?? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    },
    querySelector() {
      return null;
    },
    *walk() {
      yield this;
      for (const c of this.children) yield* c.walk();
    },
  };
  return e;
}

function makeDocument(bodyChildren) {
  const documentElement = makeEl("html");
  const body = makeEl("body");
  documentElement.appendChild(body);
  for (const c of bodyChildren) body.appendChild(c);
  return {
    documentElement,
    body,
    createElement: (tag) => makeEl(tag),
    querySelector(sel) {
      const m = sel.match(/^\[([\w-]+)="([^"]*)"\]$/);
      if (!m) return null;
      for (const el of documentElement.walk()) {
        if (el.getAttribute?.(m[1]) === m[2]) return el;
      }
      return null;
    },
    createTreeWalker(root) {
      const texts = [];
      for (const el of root.walk()) {
        for (const t of el._textParts) texts.push({ nodeValue: t, parentElement: el });
      }
      let i = -1;
      return {
        nextNode() {
          i += 1;
          return texts[i] ?? null;
        },
      };
    },
  };
}

// ── Globals + module under test ───────────────────────────────────────

const sent = []; // messages the frame posts to the top
let messageListener = null;
const windowListeners = {}; // pointermove/pointerup registered during drags

globalThis.NodeFilter = { SHOW_TEXT: 4 };
globalThis.requestAnimationFrame = () => 1; // never re-entered — chrome geometry untested here
globalThis.cancelAnimationFrame = () => {};
globalThis.window = {
  top: Symbol("top"), // !== window → IN_FRAME
  parent: { postMessage: (msg) => sent.push(msg) },
  addEventListener: (type, fn) => {
    if (type === "message") messageListener = fn;
    else (windowListeners[type] ??= []).push(fn);
  },
  removeEventListener: (type, fn) => {
    const a = windowListeners[type];
    if (a) {
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    }
  },
};
globalThis.document = makeDocument([]);

await import("../extension/frame.js");

const TOP_ORIGIN = "https://app.motherduck.com";
// The bridge checks origin AND sender window (must be our parent).
const dispatch = (data) =>
  messageListener({ origin: TOP_ORIGIN, source: globalThis.window.parent, data });
const topMsg = (msg) => ({ source: "dive-arranger-bridge", role: "top", ...msg });
const drain = () => sent.splice(0, sent.length);

const tile = (text) => {
  const d = makeEl("div");
  const h = makeEl("h3");
  h._textParts = [text];
  d.appendChild(h);
  return d;
};

const bareModel = (n) => ({
  rows: Array.from({ length: n }, (_, i) => ({ cells: [{ block: i, span: 12, heightPx: null }] })),
});

test("frame session: init maps tiles, MODEL re-places the grid, CANCEL restores", async () => {
  // body > #root > container(3 tiles) — a fresh, never-arranged dive
  const t0 = tile("Alpha KPIs");
  const t1 = tile("Beta chart");
  const t2 = tile("Gamma table");
  t1._attrs.style = "color: red"; // pre-existing inline style must survive Cancel
  const container = makeEl("div");
  container.append(t0, t1, t2);
  const root = makeEl("div");
  root.appendChild(container);
  globalThis.document = makeDocument([root]);
  drain();

  const blocks = [
    { id: 0, kind: "static", label: "Alpha", name: "div", texts: ["Alpha KPIs"] },
    { id: 1, kind: "static", label: "Beta", name: "div", texts: ["Beta chart"] },
    { id: 2, kind: "static", label: "Gamma", name: "div", texts: ["Gamma table"] },
  ];
  dispatch(topMsg({ type: "ARRANGE_INIT", nonce: "n1", blocks, model: bareModel(3) }));

  const types = sent.map((m) => m.type);
  assert.deepEqual(types, ["INIT_ACK", "MAPPED"]);
  const mapped = sent[1];
  assert.equal(mapped.ok, true);
  assert.equal(mapped.tiles, 3);
  assert.deepEqual(mapped.inert, []);

  // container became an explicit 12-col grid; tiles placed in model order
  assert.equal(container.style.display, "grid");
  assert.equal(t0.style.gridRow, "1");
  assert.equal(t1.style.gridRow, "2");
  assert.equal(t2.style.gridRow, "3");
  assert.equal(t0.style.gridColumn, "1 / span 12");

  // top pushes an authoritative MODEL: 1↔2 swapped, 0 and 2 share a row
  drain();
  const newModel = {
    rows: [
      { cells: [{ block: 1, span: 12, heightPx: 300 }] },
      { cells: [{ block: 0, span: 6, heightPx: null }, { block: 2, span: 6, heightPx: null }] },
    ],
  };
  dispatch(topMsg({ type: "MODEL", nonce: "n1", model: newModel }));
  assert.equal(t1.style.gridRow, "1");
  assert.equal(t1.style.height, "300px");
  assert.equal(t0.style.gridRow, "2");
  assert.equal(t0.style.gridColumn, "1 / span 6");
  assert.equal(t2.style.gridRow, "2");
  assert.equal(t2.style.gridColumn, "7 / span 6");
  // pure style preview: the real DOM order was NOT touched
  assert.deepEqual(container.children, [t0, t1, t2]);

  // Cancel restores every inline style (and removes the chrome host)
  dispatch(topMsg({ type: "ARRANGE_CANCEL", nonce: "n1" }));
  assert.deepEqual(sent.map((m) => m.type), ["EXITED"]);
  assert.equal(container.getAttribute("style"), null);
  assert.equal(t0.getAttribute("style"), null);
  assert.equal(t1.getAttribute("style"), "color: red");
  assert.equal(
    globalThis.document.documentElement.children.some((c) => c.hasAttribute("data-dive-arranger-ui")),
    false,
  );
});

test("frame session: previously-arranged dive — wrapper rows are lifted and restored", async () => {
  // container: [ wrapper-row(cellA(tileA), cellB(tileB)), tileC ] like apply.mjs emits
  const tA = tile("Alpha KPIs");
  const tB = tile("Beta chart");
  const tC = tile("Gamma table");
  const cellA = makeEl("div", { "data-dive-arranger": "cell", "data-arranger-span": "6" });
  cellA.appendChild(tA);
  const cellB = makeEl("div", { "data-dive-arranger": "cell", "data-arranger-span": "6" });
  cellB.appendChild(tB);
  const wrapper = makeEl("div", { "data-dive-arranger": "row" });
  wrapper.append(cellA, cellB);
  const container = makeEl("div");
  container.append(wrapper, tC);
  globalThis.document = makeDocument([container]);
  drain();

  const blocks = [
    { id: 0, kind: "static", label: "Alpha", name: "div", texts: ["Alpha KPIs"] },
    { id: 1, kind: "static", label: "Beta", name: "div", texts: ["Beta chart"] },
    { id: 2, kind: "static", label: "Gamma", name: "div", texts: ["Gamma table"] },
  ];
  const model = {
    rows: [
      { cells: [{ block: 0, span: 6, heightPx: null }, { block: 1, span: 6, heightPx: null }] },
      { cells: [{ block: 2, span: 12, heightPx: null }] },
    ],
  };
  dispatch(topMsg({ type: "ARRANGE_INIT", nonce: "n2", blocks, model }));

  const mapped = sent.find((m) => m.type === "MAPPED");
  assert.equal(mapped?.ok, true);
  assert.equal(mapped.tiles, 3);

  // tiles lifted out of the wrapper cells to be direct grid children
  assert.equal(tA.parentElement, container);
  assert.equal(tB.parentElement, container);
  assert.equal(wrapper.style.display, "none");
  assert.equal(tA.style.gridColumn, "1 / span 6");
  assert.equal(tB.style.gridColumn, "7 / span 6");
  assert.equal(tC.style.gridRow, "2");

  // Cancel puts them BACK into their cells
  drain();
  dispatch(topMsg({ type: "ARRANGE_CANCEL", nonce: "n2" }));
  assert.deepEqual(sent.map((m) => m.type), ["EXITED"]);
  assert.equal(tA.parentElement, cellA);
  assert.equal(tB.parentElement, cellB);
  assert.equal(wrapper.getAttribute("style"), null);
  assert.deepEqual(container.children, [wrapper, tC]);
});

test("frame session: dynamic block output is pinned full-width between statics", async () => {
  const t0 = tile("Alpha KPIs");
  const d1 = tile("dyn item one");
  const d2 = tile("dyn item two");
  const t2 = tile("Gamma table");
  const container = makeEl("div");
  container.append(t0, d1, d2, t2);
  globalThis.document = makeDocument([container]);
  drain();

  const blocks = [
    { id: 0, kind: "static", label: "Alpha", name: "div", texts: ["Alpha KPIs"] },
    { id: 1, kind: "dynamic", label: "{conditional} #1", name: "?", texts: [] },
    { id: 2, kind: "static", label: "Gamma", name: "div", texts: ["Gamma table"] },
  ];
  dispatch(topMsg({ type: "ARRANGE_INIT", nonce: "n3", blocks, model: bareModel(3) }));

  const mapped = sent.find((m) => m.type === "MAPPED");
  assert.equal(mapped?.ok, true);
  assert.equal(mapped.tiles, 2); // the two statics
  assert.equal(mapped.pinned, 1);

  // dynamic's two rendered nodes each get their own full-width grid row
  assert.equal(t0.style.gridRow, "1");
  assert.equal(d1.style.gridRow, "2");
  assert.equal(d1.style.gridColumn, "1 / -1");
  assert.equal(d2.style.gridRow, "3");
  assert.equal(t2.style.gridRow, "4");

  dispatch(topMsg({ type: "ARRANGE_CANCEL", nonce: "n3" }));
});

// ── Pointer-drag simulation helpers ───────────────────────────────────

const fire = (el, type, ev) => {
  for (const fn of [...(el._listeners[type] || [])]) fn(ev);
};
const fireWindow = (type, ev) => {
  for (const fn of [...(windowListeners[type] || [])]) fn(ev);
};
const pointer = (clientX, clientY) => ({ clientX, clientY, preventDefault() {} });

// The chrome host lives in a shadow root on <html>; find its pieces there.
function chromeShadow() {
  const host = globalThis.document.documentElement.children.find((c) =>
    c.hasAttribute("data-dive-arranger-ui"),
  );
  return host?._shadow ?? null;
}
function findChrome(cls, titlePrefix) {
  const out = [];
  for (const el of chromeShadow().walk()) {
    if (el.className === cls && (!titlePrefix || el.title.startsWith(titlePrefix))) out.push(el);
  }
  return out;
}
const gripFor = (label) => findChrome("grip", label)[0];
const indicator = (cls) => findChrome(cls)[0];

const setRect = (el, left, top, right, bottom) => {
  el.rect = { left, top, right, bottom, width: right - left, height: bottom - top };
};

function drag(label, downAt, moveTo) {
  fire(gripFor(label), "pointerdown", pointer(...downAt));
  fireWindow("pointermove", pointer(...moveTo));
  const shown = {
    colline: indicator("colline").style.display,
    gapline: indicator("gapline").style.display,
    rowring: indicator("rowring").style.display,
  };
  fireWindow("pointerup", pointer(...moveTo));
  return shown;
}

const rowsOf = (model) => model.rows.map((r) => r.cells.map((c) => c.block));
const spansOf = (model) => model.rows.map((r) => r.cells.map((c) => c.span));

test("frame session: pointer drags — join as column, reorder within the row, extract with re-flow", async () => {
  const t0 = tile("Alpha KPIs");
  const t1 = tile("Beta chart");
  const t2 = tile("Gamma table");
  const container = makeEl("div");
  container.append(t0, t1, t2);
  const root = makeEl("div");
  root.appendChild(container);
  globalThis.document = makeDocument([root]);
  drain();

  const blocks = [
    { id: 0, kind: "static", label: "Alpha", name: "div", texts: ["Alpha KPIs"] },
    { id: 1, kind: "static", label: "Beta", name: "div", texts: ["Beta chart"] },
    { id: 2, kind: "static", label: "Gamma", name: "div", texts: ["Gamma table"] },
  ];
  dispatch(topMsg({ type: "ARRANGE_INIT", nonce: "n5", blocks, model: bareModel(3) }));
  assert.equal(sent.find((m) => m.type === "MAPPED")?.ok, true);

  // Emulate the browser layout for the current model: 3 stacked full-width
  // rows, 200px tall, 16px apart, container 1200px wide.
  setRect(container, 0, 0, 1200, 632);
  setRect(t0, 0, 0, 1200, 200);
  setRect(t1, 0, 216, 1200, 416);
  setRect(t2, 0, 432, 1200, 632);

  // ── 1. JOIN: drag Gamma into Alpha's row (mid-band, right half) ──────
  drain();
  let shown = drag("Gamma", [6, 438], [800, 100]);
  assert.equal(shown.colline, "block"); // column slot line was showing
  assert.equal(shown.rowring, "block");
  assert.equal(shown.gapline, "none");
  let proposed = sent.find((m) => m.type === "PROPOSE");
  assert.ok(proposed, "drop posted a PROPOSE");
  assert.deepEqual(rowsOf(proposed.model), [[0, 2], [1]]);
  assert.deepEqual(spansOf(proposed.model), [[6, 6], [12]]);

  // top validates and pushes the authoritative model back
  dispatch(topMsg({ type: "MODEL", nonce: "n5", model: proposed.model }));
  assert.equal(t0.style.gridColumn, "1 / span 6");
  assert.equal(t2.style.gridColumn, "7 / span 6");
  assert.equal(t2.style.gridRow, "1");
  assert.equal(t1.style.gridRow, "2");
  assert.deepEqual(container.children, [t0, t1, t2]); // style-only: DOM order untouched

  // ── 2. REORDER within the 6/6 row: drag Gamma to the left slot ───────
  setRect(t0, 0, 0, 592, 200);
  setRect(t2, 608, 0, 1200, 200);
  setRect(t1, 0, 216, 1200, 416);
  drain();
  shown = drag("Gamma", [614, 6], [100, 100]);
  assert.equal(shown.colline, "block");
  proposed = sent.find((m) => m.type === "PROPOSE");
  assert.deepEqual(rowsOf(proposed.model), [[2, 0], [1]]);
  assert.deepEqual(spansOf(proposed.model), [[6, 6], [12]]); // spans preserved on reorder

  dispatch(topMsg({ type: "MODEL", nonce: "n5", model: proposed.model }));
  assert.equal(t2.style.gridColumn, "1 / span 6");
  assert.equal(t0.style.gridColumn, "7 / span 6");

  // ── 3. EXTRACT: drag Alpha out below Beta — survivor re-flows to 12 ──
  setRect(t2, 0, 0, 592, 200);
  setRect(t0, 608, 0, 1200, 200);
  setRect(t1, 0, 216, 1200, 416);
  drain();
  shown = drag("Alpha", [614, 6], [600, 500]);
  assert.equal(shown.gapline, "block"); // new-row line was showing
  assert.equal(shown.colline, "none");
  proposed = sent.find((m) => m.type === "PROPOSE");
  assert.deepEqual(rowsOf(proposed.model), [[2], [1], [0]]);
  assert.deepEqual(spansOf(proposed.model), [[12], [12], [12]]); // Gamma re-flowed 6 → 12

  dispatch(topMsg({ type: "MODEL", nonce: "n5", model: proposed.model }));
  assert.equal(t2.style.gridColumn, "1 / span 12");
  assert.equal(t2.style.gridRow, "1");
  assert.equal(t1.style.gridRow, "2");
  assert.equal(t0.style.gridRow, "3");
  assert.deepEqual(container.children, [t0, t1, t2]);

  // Close restores everything
  drain();
  dispatch(topMsg({ type: "ARRANGE_CANCEL", nonce: "n5" }));
  assert.deepEqual(sent.map((m) => m.type), ["EXITED"]);
  assert.equal(container.getAttribute("style"), null);
  assert.equal(t0.getAttribute("style"), null);
  assert.equal(chromeShadow(), null);
});

test("frame session: SOURCE grid rows decompose — lift, place, drag, and restore", async () => {
  // Mirrors the chat dive: [grid(activity, errors), grid(spacer, funnel), modelmix]
  const tAct = tile("Activity chart");
  const tErr = tile("Errors chart");
  const spacer = makeEl("div"); // empty <div /> spacer column
  const tFun = tile("Session funnel");
  const tMix = tile("Model mix");
  const grid1 = makeEl("div", { class: "grid grid-cols-2 gap-8 mb-8" });
  grid1.append(tAct, tErr);
  const grid2 = makeEl("div", { class: "grid grid-cols-2 gap-8 mb-8" });
  grid2.append(spacer, tFun);
  const container = makeEl("div");
  container.append(grid1, grid2, tMix);
  globalThis.document = makeDocument([container]);
  drain();

  const blocks = [
    { id: 0, kind: "static", label: "activity", name: "div", texts: ["Activity chart"] },
    { id: 1, kind: "static", label: "errors", name: "div", texts: ["Errors chart"] },
    { id: 2, kind: "static", label: "<div> (empty)", name: "div", texts: [] },
    { id: 3, kind: "static", label: "funnel", name: "div", texts: ["Session funnel"] },
    { id: 4, kind: "static", label: "modelmix", name: "div", texts: ["Model mix"] },
  ];
  const model = {
    rows: [
      { cells: [{ block: 0, span: 6, heightPx: null }, { block: 1, span: 6, heightPx: null }] },
      { cells: [{ block: 2, span: 6, heightPx: null }, { block: 3, span: 6, heightPx: null }] },
      { cells: [{ block: 4, span: 12, heightPx: null }] },
    ],
  };
  dispatch(topMsg({ type: "ARRANGE_INIT", nonce: "n6", blocks, model }));

  const mapped = sent.find((m) => m.type === "MAPPED");
  assert.equal(mapped?.ok, true);
  assert.equal(mapped.tiles, 5); // spacer included — it is a real block
  assert.deepEqual(mapped.inert, []);

  // tiles lifted OUT of the source grids to be direct grid children
  assert.equal(tAct.parentElement, container);
  assert.equal(tErr.parentElement, container);
  assert.equal(spacer.parentElement, container);
  assert.equal(tFun.parentElement, container);
  assert.equal(grid1.style.display, "none");
  assert.equal(grid2.style.display, "none");

  // placement matches the decomposed model (6/6 rows, spacer holds its column)
  assert.equal(container.style.display, "grid");
  assert.equal(tAct.style.gridRow, "1");
  assert.equal(tAct.style.gridColumn, "1 / span 6");
  assert.equal(tErr.style.gridRow, "1");
  assert.equal(tErr.style.gridColumn, "7 / span 6");
  assert.equal(spacer.style.gridRow, "2");
  assert.equal(spacer.style.gridColumn, "1 / span 6");
  assert.equal(tFun.style.gridRow, "2");
  assert.equal(tFun.style.gridColumn, "7 / span 6");
  assert.equal(tMix.style.gridRow, "3");
  assert.equal(tMix.style.gridColumn, "1 / span 12");

  // ── drag Errors out to the bottom: its own row; Activity re-flows to 12 ──
  setRect(container, 0, 0, 1200, 632);
  setRect(tAct, 0, 0, 592, 200);
  setRect(tErr, 608, 0, 1200, 200);
  setRect(spacer, 0, 216, 592, 216);
  setRect(tFun, 608, 216, 1200, 416);
  setRect(tMix, 0, 432, 1200, 632);
  drain();
  const shown = drag("errors", [614, 6], [600, 700]);
  assert.equal(shown.gapline, "block");
  const proposed = sent.find((m) => m.type === "PROPOSE");
  assert.ok(proposed, "drop posted a PROPOSE");
  assert.deepEqual(rowsOf(proposed.model), [[0], [2, 3], [4], [1]]);
  assert.deepEqual(spansOf(proposed.model), [[12], [6, 6], [12], [12]]);

  dispatch(topMsg({ type: "MODEL", nonce: "n6", model: proposed.model }));
  assert.equal(tAct.style.gridColumn, "1 / span 12");
  assert.equal(tErr.style.gridRow, "4");
  // style-only preview: real DOM order untouched (tiles stay where lifted)
  assert.deepEqual(container.children, [tAct, tErr, grid1, spacer, tFun, grid2, tMix]);

  // ── Cancel restores the source grids exactly ──
  drain();
  dispatch(topMsg({ type: "ARRANGE_CANCEL", nonce: "n6" }));
  assert.deepEqual(sent.map((m) => m.type), ["EXITED"]);
  assert.deepEqual(container.children, [grid1, grid2, tMix]);
  assert.deepEqual(grid1.children, [tAct, tErr]);
  assert.deepEqual(grid2.children, [spacer, tFun]);
  assert.equal(grid1.getAttribute("style"), null);
  assert.notEqual(grid1.style.display, "none");
  assert.equal(container.getAttribute("style"), null);
});

test("frame session: decoy grid/flex siblings don't inflate the wrapper count", async () => {
  // The real chat dive: the tile container also holds a `flex` controls bar and
  // a `grid grid-cols-4` KPI block that discovery keeps WHOLE (dynamic/te­xt
  // children) — NOT decomposed. Only the two grid-cols-2 rows are wrapped. The
  // DOM side must not treat the controls/KPI containers as source rows.
  const h1 = tile("Zero Build Chat");
  const controls = makeEl("div", { class: "flex flex-wrap items-center gap-2" });
  controls.append(tile("daily"), tile("hourly"), tile("range"));
  const kpi = makeEl("div", { class: "grid grid-cols-4 gap-8 mb-8" });
  kpi.append(tile("New wallets"), tile("Fetches"), tile("Errors kpi"), tile("Threads"));
  const tAct = tile("Activity chart");
  const tErr = tile("Errors chart");
  const grid1 = makeEl("div", { class: "grid grid-cols-2 gap-8 mb-8" });
  grid1.append(tAct, tErr);
  const spacer = makeEl("div");
  const tFun = tile("Session funnel");
  const grid2 = makeEl("div", { class: "grid grid-cols-2 gap-8 mb-8" });
  grid2.append(spacer, tFun);
  const tMix = tile("Model mix");
  const tFeed = tile("Raw feed");
  const container = makeEl("div");
  container.append(h1, controls, kpi, grid1, grid2, tMix, tFeed);
  globalThis.document = makeDocument([container]);
  drain();

  const blocks = [
    { id: 0, kind: "static", label: "h1", name: "h1", texts: ["Zero Build Chat"] },
    { id: 1, kind: "static", label: "controls", name: "div", texts: [] },
    { id: 2, kind: "static", label: "kpi", name: "div", texts: [] },
    { id: 3, kind: "static", label: "activity", name: "div", texts: ["Activity chart"] },
    { id: 4, kind: "static", label: "errors", name: "div", texts: ["Errors chart"] },
    { id: 5, kind: "static", label: "<div> (empty)", name: "div", texts: [] },
    { id: 6, kind: "static", label: "funnel", name: "div", texts: ["Session funnel"] },
    { id: 7, kind: "static", label: "modelmix", name: "div", texts: ["Model mix"] },
    { id: 8, kind: "static", label: "feed", name: "div", texts: ["Raw feed"] },
  ];
  const model = {
    rows: [
      { cells: [{ block: 0, span: 12, heightPx: null }] },
      { cells: [{ block: 1, span: 12, heightPx: null }] },
      { cells: [{ block: 2, span: 12, heightPx: null }] },
      { cells: [{ block: 3, span: 6, heightPx: null }, { block: 4, span: 6, heightPx: null }] },
      { cells: [{ block: 5, span: 6, heightPx: null }, { block: 6, span: 6, heightPx: null }] },
      { cells: [{ block: 7, span: 12, heightPx: null }] },
      { cells: [{ block: 8, span: 12, heightPx: null }] },
    ],
  };
  dispatch(topMsg({ type: "ARRANGE_INIT", nonce: "n7", blocks, model }));

  const mapped = sent.find((m) => m.type === "MAPPED");
  assert.equal(mapped?.ok, true);
  assert.equal(mapped.tiles, 9); // 5 solo statics + 4 cells (act/err/spacer/funnel)
  assert.deepEqual(mapped.inert, []);

  // Only the two grid-cols-2 rows were decomposed and lifted …
  assert.equal(tAct.parentElement, container);
  assert.equal(tErr.parentElement, container);
  assert.equal(spacer.parentElement, container);
  assert.equal(tFun.parentElement, container);
  assert.equal(grid1.style.display, "none");
  assert.equal(grid2.style.display, "none");
  // … the controls/KPI decoys were mapped as WHOLE tiles, never touched
  assert.equal(controls.parentElement, container);
  assert.equal(kpi.parentElement, container);
  assert.notEqual(controls.style.display, "none");
  assert.notEqual(kpi.style.display, "none");

  // decomposed placement is correct
  assert.equal(tAct.style.gridColumn, "1 / span 6");
  assert.equal(tErr.style.gridColumn, "7 / span 6");
  assert.equal(spacer.style.gridColumn, "1 / span 6");
  assert.equal(tFun.style.gridColumn, "7 / span 6");

  dispatch(topMsg({ type: "ARRANGE_CANCEL", nonce: "n7" }));
});

test("frame bridge: messages not sent by the parent window are ignored", () => {
  const container = makeEl("div");
  container.append(tile("Alpha KPIs"));
  globalThis.document = makeDocument([container]);
  drain();
  const blocks = [{ id: 0, kind: "static", label: "Alpha", name: "div", texts: ["Alpha KPIs"] }];
  // right origin, wrong sender window (e.g. a sibling frame that got a handle)
  messageListener({
    origin: TOP_ORIGIN,
    source: {},
    data: topMsg({ type: "ARRANGE_INIT", nonce: "nx", blocks, model: bareModel(1) }),
  });
  assert.deepEqual(sent, []); // no INIT_ACK, no session started
});

test("frame session: teardown mid-drag is inert — no throw, no stray PROPOSE", async () => {
  const t0 = tile("Alpha KPIs");
  const t1 = tile("Beta chart");
  const t2 = tile("Gamma table");
  const container = makeEl("div");
  container.append(t0, t1, t2);
  const root = makeEl("div");
  root.appendChild(container);
  globalThis.document = makeDocument([root]);
  drain();

  const blocks = [
    { id: 0, kind: "static", label: "Alpha", name: "div", texts: ["Alpha KPIs"] },
    { id: 1, kind: "static", label: "Beta", name: "div", texts: ["Beta chart"] },
    { id: 2, kind: "static", label: "Gamma", name: "div", texts: ["Gamma table"] },
  ];
  dispatch(topMsg({ type: "ARRANGE_INIT", nonce: "n8", blocks, model: bareModel(3) }));
  assert.equal(sent.find((m) => m.type === "MAPPED")?.ok, true);

  setRect(container, 0, 0, 1200, 632);
  setRect(t0, 0, 0, 1200, 200);
  setRect(t1, 0, 216, 1200, 416);
  setRect(t2, 0, 432, 1200, 632);

  // Start a drag, then cancel the session WHILE the pointer is still down.
  drain();
  fire(gripFor("Gamma"), "pointerdown", pointer(6, 438));
  dispatch(topMsg({ type: "ARRANGE_CANCEL", nonce: "n8" }));
  // The drag's window listeners are still registered — they must be inert now
  // (before the guard, this pointermove crashed on the null session).
  fireWindow("pointermove", pointer(800, 100));
  fireWindow("pointerup", pointer(800, 100));

  assert.deepEqual(sent.map((m) => m.type), ["EXITED"]); // no PROPOSE
  assert.equal(container.getAttribute("style"), null); // restore intact
  assert.equal(t2.getAttribute("style"), null);
});

test("frame session: a superseded INIT's retry loop goes dead (no late MAPPED, no session clobber)", async () => {
  // First INIT arrives while the dive hasn't rendered yet — mapping retries.
  globalThis.document = makeDocument([]);
  drain();
  const blocks = [
    { id: 0, kind: "static", label: "Alpha", name: "div", texts: ["Alpha KPIs"] },
    { id: 1, kind: "static", label: "Beta", name: "div", texts: ["Beta chart"] },
    { id: 2, kind: "static", label: "Gamma", name: "div", texts: ["Gamma table"] },
  ];
  dispatch(topMsg({ type: "ARRANGE_INIT", nonce: "sA", blocks, model: bareModel(3) }));
  assert.deepEqual(sent.map((m) => m.type), ["INIT_ACK"]);

  // The dive finishes rendering AND a new arrange run (new nonce) starts.
  const t0 = tile("Alpha KPIs");
  const t1 = tile("Beta chart");
  const t2 = tile("Gamma table");
  const container = makeEl("div");
  container.append(t0, t1, t2);
  const root = makeEl("div");
  root.appendChild(container);
  globalThis.document = makeDocument([root]);
  dispatch(topMsg({ type: "ARRANGE_INIT", nonce: "sB", blocks, model: bareModel(3) }));
  const mappedB = sent.filter((m) => m.type === "MAPPED");
  assert.equal(mappedB.length, 1);
  assert.equal(mappedB[0].nonce, "sB");
  assert.equal(mappedB[0].ok, true);

  // Wait past sA's retry interval: it must never map — a late sA success
  // would overwrite sB's session and lose its undo log.
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(sent.filter((m) => m.type === "MAPPED" && m.nonce === "sA").length, 0);

  // … and sB's session still cancels/restores cleanly.
  drain();
  dispatch(topMsg({ type: "ARRANGE_CANCEL", nonce: "sB" }));
  assert.deepEqual(sent.map((m) => m.type), ["EXITED"]);
  assert.equal(container.getAttribute("style"), null);
  assert.equal(t0.getAttribute("style"), null);
});

test("frame session: unmappable page reports MAPPED ok:false (after retries)", async () => {
  // container child count ≠ block count and no anchors match
  const container = makeEl("div");
  container.append(tile("something"), tile("else"));
  globalThis.document = makeDocument([container]);
  drain();

  const blocks = [
    { id: 0, kind: "static", label: "A", name: "div", texts: ["No Such Text"] },
    { id: 1, kind: "static", label: "B", name: "div", texts: ["Also Missing"] },
    { id: 2, kind: "static", label: "C", name: "div", texts: [] },
  ];
  dispatch(topMsg({ type: "ARRANGE_INIT", nonce: "n4", blocks, model: bareModel(3) }));
  assert.deepEqual(sent.map((m) => m.type), ["INIT_ACK"]); // mapping retries in background

  // wait out the 6s retry window
  await new Promise((r) => setTimeout(r, 7000));
  const mapped = sent.find((m) => m.type === "MAPPED");
  assert.equal(mapped?.ok, false);
  assert.ok(mapped.reason);
});
