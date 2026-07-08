// Content script for the dive SANDBOX IFRAME (https://motherduckusercontent.com,
// injected via all_frames). MotherDuck renders the dive's tiles inside this
// cross-origin frame, so the WYSIWYG drag experience lives HERE, on the real
// rendered tiles — the top-frame extension code never sees them.
//
// Responsibilities:
//  - map the dive's top-level rendered tiles to the source blocks the top
//    frame discovered (positional + anchor-text alignment; see frame-map.mjs)
//  - switch the tile container to an explicit 12-column grid and place every
//    tile from the layout model → live in-place preview (reorders, side-by-
//    side rows, spans, heights) with style-only mutations after a one-time
//    unwrap of previous arranger row wrappers (undo-logged for Cancel)
//  - draw drag/resize chrome ON the real tiles (grip, edge handles, badges)
//  - report every committed mutation to the top frame (postMessage), which
//    owns the source of truth (engine discover/validate/apply + Submit)
//
// This script is dormant until the top frame sends ARRANGE_INIT. All bridge
// messages are checked both ways (origin, and here also the sender window —
// only our own parent may drive a session) and carry a per-session nonce.
import { validateLayout, GRID_COLS, GRID_GAP } from "../engine/validate.mjs";
import { classifyRowContainer } from "../engine/rowcontainer.mjs";
import { deepCopyModel, moveBlock, pickDropTarget, COLS } from "./layout-model.mjs";
import { alignRowsToChildren } from "./frame-map.mjs";

const BRIDGE = "dive-arranger-bridge";
const TOP_ORIGIN = "https://app.motherduck.com";
const UI_ATTR = "data-dive-arranger-ui";

const IN_FRAME = window !== window.top;

let session = null;

const post = (msg) => window.parent.postMessage({ source: BRIDGE, role: "frame", ...msg }, TOP_ORIGIN);

// ── Bridge ────────────────────────────────────────────────────────────

if (IN_FRAME) {
  window.addEventListener("message", (ev) => {
    // Origin AND sender-window check: only our own top frame may drive a
    // session (another same-origin frame could otherwise reach us).
    if (ev.origin !== TOP_ORIGIN || ev.source !== window.parent) return;
    const d = ev.data;
    if (!d || d.source !== BRIDGE || d.role !== "top") return;
    if (d.type === "ARRANGE_INIT") return onInit(d);
    if (!session || d.nonce !== session.nonce) return;
    if (d.type === "MODEL") return onModel(d);
    if (d.type === "ARRANGE_CANCEL") return onCancel();
  });
}

const initsSeen = new Set();
let activeInitNonce = null;

function onInit(d) {
  if (!d.nonce || !Array.isArray(d.blocks) || !d.model) return;
  if (session && session.nonce === d.nonce) {
    post({ type: "INIT_ACK", nonce: d.nonce });
    return; // duplicate INIT (top retries until acked); MAPPED was/will be sent
  }
  if (initsSeen.has(d.nonce)) return; // mapping attempt already in flight
  initsSeen.add(d.nonce);
  activeInitNonce = d.nonce;
  post({ type: "INIT_ACK", nonce: d.nonce });
  if (session) teardown(true); // stale session from a previous arrange run

  // The dive may still be rendering (queries in flight) — retry mapping
  // briefly before giving up.
  const deadline = Date.now() + 6000;
  const attempt = () => {
    // A newer ARRANGE_INIT superseded this one while it was retrying: go
    // dead — a late success here would overwrite the newer session (and
    // silently lose its undo log).
    if (activeInitNonce !== d.nonce) return;
    let result = null;
    let err = null;
    try {
      result = startSession(d);
    } catch (e) {
      err = e;
      // startSession registers the session (with its undo log) BEFORE any DOM
      // surgery, so a partial failure can always be rolled back.
      if (session && session.nonce === d.nonce) teardown(true);
    }
    if (result) {
      post({
        type: "MAPPED",
        nonce: d.nonce,
        ok: true,
        tiles: result.tiles,
        pinned: result.pinned,
        inert: result.inert,
      });
      return;
    }
    if (Date.now() < deadline) {
      setTimeout(attempt, 500);
    } else {
      post({
        type: "MAPPED",
        nonce: d.nonce,
        ok: false,
        reason: err?.message || "could not match the rendered tiles to the source blocks",
        expected: { blocks: d.blocks.length, rows: d.model.rows.map((r) => r.cells.length) },
        diag: lastMapDiag,
      });
    }
  };
  attempt();
}

function onModel(d) {
  if (!session || !d.model) return;
  if (Array.isArray(d.idMap)) {
    const remap = new Map(d.idMap);
    const remapMap = (m) => {
      const out = new Map();
      for (const [k, v] of m) out.set(remap.has(k) ? remap.get(k) : k, v);
      return out;
    };
    session.tiles = remapMap(session.tiles);
    session.dynEls = remapMap(session.dynEls);
  }
  if (Array.isArray(d.blocks)) session.blocks = d.blocks;
  session.model = deepCopyModel(d.model);
  layoutFrame();
  rebuildChrome();
}

function onCancel() {
  teardown(true);
  post({ type: "EXITED" });
}

// ── Mapping: container + tiles ────────────────────────────────────────

function findTextElement(needle) {
  const root = document.body || document.documentElement;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeValue && n.nodeValue.includes(needle)) return n.parentElement;
  }
  return null;
}

function ancestorChain(el) {
  const chain = [];
  for (let cur = el; cur; cur = cur.parentElement) chain.push(cur);
  return chain;
}

function anchorElementsFor(blocks) {
  const els = [];
  for (const b of blocks) {
    if (b.kind !== "static") continue;
    for (const t of [...(b.texts || [])].sort((a, z) => z.length - a.length)) {
      const el = findTextElement(t);
      if (el) {
        els.push(el);
        break;
      }
    }
  }
  return els;
}

function* containerCandidates(blocks) {
  // 1) A previous arrangement left our wrapper markers in the DOM: their
  //    parent IS the tile container.
  const marker = document.querySelector('[data-dive-arranger="row"]');
  if (marker?.parentElement) yield { el: marker.parentElement, trusted: true };

  // 2) Lowest common ancestor of the blocks' anchor texts.
  const anchors = anchorElementsFor(blocks);
  if (anchors.length >= 2) {
    let common = null;
    for (const el of anchors) {
      const chain = ancestorChain(el);
      if (!common) {
        common = chain;
      } else {
        const set = new Set(chain);
        common = common.filter((a) => set.has(a));
      }
    }
    // The LCA itself, then a couple of its ancestors (the anchors may all sit
    // one level deeper than the real tile container) — alignment gates each.
    for (let i = 0; i < 3 && common?.[i]; i++) yield { el: common[i], trusted: true };
  }

  // 3) Positional backstop: descend from <body> through single-child shells,
  //    then a shallow BFS for multi-child elements. Untrusted — only accepted
  //    when an anchor confirms it (or the dive has no anchor text at all).
  let cur = document.body;
  for (let i = 0; i < 8 && cur && cur.childElementCount === 1; i++) cur = cur.firstElementChild;
  if (cur) {
    const queue = [{ el: cur, depth: 0 }];
    let n = 0;
    while (queue.length && n < 40) {
      const { el, depth } = queue.shift();
      n += 1;
      if (el.childElementCount >= 2) yield { el, trusted: false };
      if (depth < 3) for (const c of el.children) queue.push({ el: c, depth: depth + 1 });
    }
  }
}

const SKIP_TAGS = ["SCRIPT", "STYLE", "LINK", "TEMPLATE", "NOSCRIPT"];

// Recognize a rendered SOURCE row container (the dive's own grid/flex row, e.g.
// `grid grid-cols-2`). We read COMPUTED style, not just inline style + class:
// MotherDuck's renderer may express the grid via Tailwind, a CSS module, or
// emotion, so the literal class string can't be relied on — but `display:grid`
// with N resolved tracks always shows up in the computed style. Same classifier
// the engine uses on the JSX side, so both sides agree on what a row is.
function rowContainerInfo(el) {
  let cs = null;
  try {
    if (typeof getComputedStyle === "function") cs = getComputedStyle(el);
  } catch {
    /* detached node / non-browser harness — fall back to inline + class */
  }
  return classifyRowContainer({
    classAttr: el.getAttribute("class") || "",
    display: cs?.display || el.style?.display || null,
    gridTemplateColumns: cs?.gridTemplateColumns || el.style?.gridTemplateColumns || null,
    flexDirection: cs?.flexDirection || el.style?.flexDirection || null,
  });
}

function describeChildren(container, blocks) {
  const els = [...container.children].filter(
    (el) => !SKIP_TAGS.includes(el.tagName) && !el.hasAttribute(UI_ATTR),
  );
  const desc = els.map((el) => {
    const wrapper = el.getAttribute("data-dive-arranger") === "row";
    const cellCount = wrapper
      ? [...el.children].filter((c) => c.getAttribute?.("data-dive-arranger") === "cell").length
      : 0;
    // rowLike marks a child that COULD be a decomposed source row; whether it
    // actually IS one (srcCells) is decided model-aware by assignSrcRows, since
    // a dive's tile container also holds non-decomposed grid/flex blocks (a KPI
    // `grid-cols-4`, a `flex` controls bar) that must map as WHOLE tiles.
    let rowLike = false;
    let rowChildCount = 0;
    if (!wrapper && el.getAttribute("data-dive-arranger") == null) {
      const info = rowContainerInfo(el);
      if (info) {
        const n = [...el.children].filter((c) => !SKIP_TAGS.includes(c.tagName)).length;
        if (n >= 2) {
          rowLike = true;
          rowChildCount = n;
        }
      }
    }
    return { wrapper, cellCount, srcCells: 0, rowLike, rowChildCount, anchors: new Set(), el };
  });
  for (const b of blocks) {
    if (b.kind !== "static") continue;
    for (const t of [...(b.texts || [])].sort((a, z) => z.length - a.length)) {
      const hits = desc.filter((c) => !c.wrapper && c.el.textContent.includes(t));
      if (hits.length === 1) {
        hits[0].anchors.add(b.id);
        break;
      }
    }
  }
  return desc;
}

// Decide which row-like children are ACTUAL decomposed source rows by matching
// them to the model's wrapped rows (2+ cells) greedily in document order:
// child element-count must equal the row's cell count, and — when the row's
// cells carry anchor text — that text must appear inside the child. This keeps
// the DOM side in lockstep with discovery: a `grid-cols-4` KPI or a `flex`
// controls bar that discovery kept WHOLE won't match any 2-cell row, so it
// stays a plain single tile instead of inflating the wrapper count.
function assignSrcRows(desc, model, blocks) {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const longestText = (id) => {
    const b = byId.get(id);
    if (!b || b.kind !== "static") return null;
    const ts = (b.texts || []).filter(Boolean);
    return ts.length ? ts.slice().sort((a, z) => z.length - a.length)[0] : null;
  };
  const wrapped = model.rows
    .map((row) => ({
      cellCount: row.cells.length,
      texts: row.cells.map((c) => longestText(c.block)).filter(Boolean),
    }))
    .filter((r) => r.cellCount >= 2);

  let from = 0;
  for (const row of wrapped) {
    for (let j = from; j < desc.length; j++) {
      const c = desc[j];
      if (c.wrapper || !c.rowLike || c.srcCells || c.rowChildCount !== row.cellCount) continue;
      const txt = c.el.textContent || "";
      if (row.texts.length && !row.texts.every((t) => txt.includes(t))) continue;
      c.srcCells = row.cellCount;
      from = j + 1;
      break;
    }
  }
}

// Compact, log-friendly summary of one rejected container candidate — posted to
// the top frame on mapping failure so a failed session is diagnosable from the
// app.motherduck.com console (the sandbox frame's own console is unreachable).
function briefCand(cand, desc, why) {
  return {
    trusted: !!cand.trusted,
    why,
    children: desc.slice(0, 16).map((c) => ({
      tag: c.el.tagName,
      cls: (c.el.getAttribute("class") || "").slice(0, 44),
      kids: c.el.childElementCount,
      wrapper: c.wrapper,
      rowLike: c.rowLike,
      srcCells: c.srcCells,
      anchors: [...c.anchors],
    })),
  };
}

let lastMapDiag = null;

function locateTiles(blocks, model) {
  const kinds = new Map(blocks.map((b) => [b.id, b.kind]));
  const anyAnchorText = blocks.some((b) => b.kind === "static" && (b.texts || []).length > 0);
  const seen = new Set();
  const diag = [];
  for (const cand of containerCandidates(blocks)) {
    if (!cand.el || seen.has(cand.el)) continue;
    seen.add(cand.el);
    const desc = describeChildren(cand.el, blocks);
    if (desc.length === 0) continue;
    assignSrcRows(desc, model, blocks);
    const anchorsFound = desc.some((c) => c.anchors.size > 0);
    if (!cand.trusted && anyAnchorText && !anchorsFound) {
      diag.push(briefCand(cand, desc, "untrusted candidate, no anchor text matched"));
      continue;
    }
    // Pass 1 treats matched source row containers as wrapper-like children, so a
    // decomposed multi-cell model row maps onto ONE container child. Pass 2
    // ignores the srcrow classification — a dive whose grid classes are dynamic
    // in the source (never decomposed) still maps even when its rendered DOM
    // looks grid-like.
    const passes = desc.some((c) => c.srcCells) ? [true, false] : [false];
    for (const useSrc of passes) {
      const view = useSrc
        ? desc.map((c) => (c.srcCells ? { ...c, wrapper: true, cellCount: c.srcCells } : c))
        : desc;
      const alignment = alignRowsToChildren(model.rows, kinds, view);
      if (alignment) return { container: cand.el, desc: view, alignment };
    }
    diag.push(briefCand(cand, desc, "no row↔child alignment"));
  }
  lastMapDiag = diag.slice(0, 4);
  return null;
}

// ── Session setup: flatten wrappers, grid the container, build chrome ─

function startSession(d) {
  const model = deepCopyModel(d.model);
  const blocks = d.blocks;
  const found = locateTiles(blocks, model);
  if (!found) return null;
  const { container, desc, alignment } = found;

  const tiles = new Map(); // blockId -> { el, lift?: { cellEl, wrapperEl } }
  const dynEls = new Map(); // blockId -> [el, ...] (pinned dynamic output)
  const inert = [];
  const wrappers = [];

  for (const a of alignment) {
    const row = model.rows[a.rowIdx];
    if (a.via === "wrapper") {
      const wrapperEl = desc[a.childIdxs[0]].el;
      wrappers.push(wrapperEl);
      if (wrapperEl.getAttribute("data-dive-arranger") === "row") {
        // Arranger-authored row: marked cells hold the tiles.
        const cellEls = [...wrapperEl.children].filter(
          (c) => c.getAttribute?.("data-dive-arranger") === "cell",
        );
        if (cellEls.length !== row.cells.length) return null;
        row.cells.forEach((cell, k) => {
          const cellEl = cellEls[k];
          const el = cellEl.childElementCount === 1 ? cellEl.firstElementChild : cellEl;
          tiles.set(cell.block, { el, lift: { cellEl, wrapperEl } });
        });
      } else {
        // SOURCE row container (the dive's own grid/flex row): its element
        // children ARE the tiles — spacer columns included, since discovery
        // keeps them as blocks so the counts and spans line up.
        const cellEls = [...wrapperEl.children].filter((c) => !SKIP_TAGS.includes(c.tagName));
        if (cellEls.length !== row.cells.length) return null;
        row.cells.forEach((cell, k) => {
          tiles.set(cell.block, { el: cellEls[k], lift: { wrapperEl } });
        });
      }
    } else if (a.via === "dynamic") {
      dynEls.set(row.cells[0].block, a.childIdxs.map((j) => desc[j].el));
    } else if (a.via === "inert") {
      inert.push(row.cells[0].block);
    } else {
      tiles.set(row.cells[0].block, { el: desc[a.childIdxs[0]].el });
    }
  }

  // Register the session BEFORE any DOM mutation: every change below is
  // undo-logged on it, so a mid-setup failure (or Cancel) can roll back.
  const undo = [];
  const baseStyle = new Map();
  session = {
    nonce: d.nonce,
    blocks,
    model,
    container,
    tiles,
    dynEls,
    inert,
    baseStyle,
    undo,
    chrome: [],
    host: null,
    shadow: null,
    raf: 0,
    drag: null,
  };

  // Base styles (layoutFrame composes placement on top of the element's
  // ORIGINAL inline style every pass; Cancel restores originals).
  const capture = (el) => {
    if (baseStyle.has(el)) return;
    const value = el.getAttribute("style");
    baseStyle.set(el, value ?? "");
    undo.push({ kind: "style", el, value });
  };

  capture(container);
  for (const w of wrappers) capture(w);
  for (const { el } of tiles.values()) capture(el);
  for (const els of dynEls.values()) for (const el of els) capture(el);

  // One-time DOM surgery: lift blocks out of previous arranger wrappers so
  // every tile is a direct child of the container, then hide the wrappers.
  for (const row of model.rows) {
    for (const cell of row.cells) {
      const t = tiles.get(cell.block);
      if (!t?.lift) continue;
      undo.push({ kind: "move", el: t.el, parent: t.el.parentElement, next: t.el.nextSibling });
      container.insertBefore(t.el, t.lift.wrapperEl);
    }
  }
  for (const w of wrappers) w.style.display = "none";

  container.style.display = "grid";
  container.style.gridTemplateColumns = `repeat(${GRID_COLS}, minmax(0, 1fr))`;
  container.style.gap = `${GRID_GAP}px`;
  container.style.alignItems = "start";

  layoutFrame();
  buildHost();
  rebuildChrome();
  tick();

  return {
    tiles: tiles.size,
    pinned: dynEls.size,
    inert: inert.map((id) => blocks.find((b) => b.id === id)?.label ?? String(id)),
  };
}

function teardown(restore) {
  if (!session) return;
  cancelAnimationFrame(session.raf);
  session.host?.remove();
  if (restore) {
    for (let i = session.undo.length - 1; i >= 0; i--) {
      const u = session.undo[i];
      try {
        if (u.kind === "style") {
          u.value == null ? u.el.removeAttribute("style") : u.el.setAttribute("style", u.value);
        } else {
          u.parent.insertBefore(u.el, u.next && u.next.parentNode === u.parent ? u.next : null);
        }
      } catch {
        /* node gone (React re-rendered) — restore what we can */
      }
    }
  }
  session = null;
}

// ── Grid preview: place every tile from the model ─────────────────────

function layoutFrame() {
  const s = session;
  let r = 1;
  for (const row of s.model.rows) {
    const solo = row.cells.length === 1;
    if (solo && s.dynEls.has(row.cells[0].block)) {
      for (const el of s.dynEls.get(row.cells[0].block)) {
        el.setAttribute("style", s.baseStyle.get(el) || "");
        el.style.gridRow = String(r++);
        el.style.gridColumn = "1 / -1";
        el.style.minWidth = "0";
      }
      continue;
    }
    let col = 1;
    let any = false;
    for (const cell of row.cells) {
      const span = cell.span ?? Math.max(1, Math.floor(COLS / row.cells.length));
      const t = s.tiles.get(cell.block);
      if (t) {
        const el = t.el;
        el.setAttribute("style", s.baseStyle.get(el) || "");
        el.style.gridRow = String(r);
        el.style.gridColumn = `${col} / span ${span}`;
        el.style.minWidth = "0";
        if (cell.heightPx != null) {
          el.style.height = `${cell.heightPx}px`;
          el.style.overflow = "auto";
        }
        any = true;
      }
      col += span;
    }
    if (any) r += 1;
  }
}

// ── Chrome (grips, resize handles, badges) over the real tiles ────────

const CHROME_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .box {
    position: fixed; border: 1.5px dashed rgba(7,119,179,.6); border-radius: 6px;
    pointer-events: none;
  }
  .box.pinned { border-color: rgba(200,170,70,.55); }
  .box.dragging { opacity: .35; }
  .grip {
    position: fixed; pointer-events: auto; cursor: grab; touch-action: none;
    background: #0777b3; color: #fff; border-radius: 6px; padding: 2px 8px;
    font: 600 12px/1.4 system-ui, sans-serif; user-select: none;
    box-shadow: 0 1px 6px rgba(0,0,0,.35);
  }
  .meta {
    position: fixed; pointer-events: none;
    background: rgba(23,23,27,.85); color: #cfe3cf; border-radius: 6px;
    padding: 1px 7px; font: 600 10px/1.5 system-ui, sans-serif; white-space: nowrap;
  }
  .pinbadge {
    position: fixed; pointer-events: none;
    background: #5a4a1f; color: #e8c76a; border-radius: 6px;
    padding: 1px 7px; font: 600 10px/1.5 system-ui, sans-serif;
  }
  .rz-e { position: fixed; width: 10px; cursor: ew-resize; pointer-events: auto; touch-action: none; border-radius: 3px; }
  .rz-s { position: fixed; height: 10px; cursor: ns-resize; pointer-events: auto; touch-action: none; border-radius: 3px; }
  .rz-e:hover, .rz-s:hover { background: rgba(7,119,179,.5); }
  .gapline { position: fixed; height: 4px; border-radius: 2px; background: #0777b3; display: none; pointer-events: none; }
  .colline { position: fixed; width: 4px; border-radius: 2px; background: #0777b3; display: none; pointer-events: none; }
  .rowring { position: fixed; border: 2px dashed #0777b3; border-radius: 8px; display: none; pointer-events: none; }
  .ghost {
    position: fixed; pointer-events: none; display: none;
    background: rgba(31,31,36,.92); color: #fff; border: 1px solid #0777b3;
    border-radius: 6px; padding: 4px 10px; font: 600 12px system-ui, sans-serif;
    box-shadow: 0 8px 30px rgba(0,0,0,.5); max-width: 40ch; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
`;

function buildHost() {
  const host = document.createElement("div");
  host.setAttribute(UI_ATTR, "1");
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    zIndex: 2147483646,
    pointerEvents: "none",
  });
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CHROME_CSS;
  shadow.appendChild(style);
  const layer = document.createElement("div");
  shadow.appendChild(layer);
  const gapline = document.createElement("div");
  gapline.className = "gapline";
  const colline = document.createElement("div");
  colline.className = "colline";
  const rowring = document.createElement("div");
  rowring.className = "rowring";
  const ghost = document.createElement("div");
  ghost.className = "ghost";
  shadow.append(gapline, colline, rowring, ghost);
  document.documentElement.appendChild(host);
  session.host = host;
  session.shadow = shadow;
  session.layer = layer;
  session.gapline = gapline;
  session.colline = colline;
  session.rowring = rowring;
  session.ghost = ghost;
}

function labelOf(blockId) {
  return session.blocks.find((b) => b.id === blockId)?.label ?? `block ${blockId}`;
}

function rebuildChrome() {
  const s = session;
  s.layer.textContent = "";
  s.chrome = [];

  for (const [blockId, t] of s.tiles) {
    const box = document.createElement("div");
    box.className = "box";
    const grip = document.createElement("div");
    grip.className = "grip";
    grip.textContent = "⠿";
    grip.title = `${labelOf(blockId)} — drag to move`;
    const meta = document.createElement("div");
    meta.className = "meta";
    const east = document.createElement("div");
    east.className = "rz-e";
    east.title = "drag to change width";
    const south = document.createElement("div");
    south.className = "rz-s";
    south.title = "drag to set height · double-click to reset";
    s.layer.append(box, grip, meta, east, south);
    grip.addEventListener("pointerdown", (ev) => startDrag(ev, blockId));
    east.addEventListener("pointerdown", (ev) => startResizeW(ev, blockId));
    south.addEventListener("pointerdown", (ev) => startResizeH(ev, blockId));
    south.addEventListener("dblclick", () => {
      const loc = findCell(s.model, blockId);
      if (!loc) return;
      s.model.rows[loc.rowIdx].cells[loc.cellIdx].heightPx = null;
      layoutFrame();
      propose();
    });
    s.chrome.push({ kind: "tile", blockId, el: t.el, box, grip, meta, east, south });
  }

  for (const [blockId, els] of s.dynEls) {
    if (!els.length) continue;
    const box = document.createElement("div");
    box.className = "box pinned";
    const badge = document.createElement("div");
    badge.className = "pinbadge";
    badge.textContent = "pinned";
    badge.title = `${labelOf(blockId)} — conditional/loop output; the arranger never moves it`;
    s.layer.append(box, badge);
    s.chrome.push({ kind: "pinned", blockId, els, box, badge });
  }
}

function unionRect(els) {
  let rect = null;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) continue;
    rect = rect
      ? {
          left: Math.min(rect.left, r.left),
          top: Math.min(rect.top, r.top),
          right: Math.max(rect.right, r.right),
          bottom: Math.max(rect.bottom, r.bottom),
        }
      : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }
  return rect;
}

function place(el, rect) {
  el.style.left = `${rect.left}px`;
  el.style.top = `${rect.top}px`;
  if (rect.width != null) el.style.width = `${rect.width}px`;
  if (rect.height != null) el.style.height = `${rect.height}px`;
}

function updateChrome() {
  const s = session;
  for (const c of s.chrome) {
    const rect = c.kind === "tile" ? unionRect([c.el]) : unionRect(c.els);
    const parts =
      c.kind === "tile" ? [c.box, c.grip, c.meta, c.east, c.south] : [c.box, c.badge];
    if (!rect) {
      for (const p of parts) p.style.display = "none";
      continue;
    }
    for (const p of parts) p.style.display = "";
    const w = rect.right - rect.left;
    const h = rect.bottom - rect.top;
    place(c.box, { left: rect.left - 2, top: rect.top - 2, width: w + 4, height: h + 4 });
    if (c.kind === "pinned") {
      place(c.badge, { left: rect.left + 6, top: rect.top + 6 });
      continue;
    }
    place(c.grip, { left: rect.left + 6, top: rect.top + 6 });
    const loc = findCell(s.model, c.blockId);
    if (loc) {
      const cell = s.model.rows[loc.rowIdx].cells[loc.cellIdx];
      const span = cell.span ?? COLS;
      c.meta.textContent = `${span}/${COLS}${cell.heightPx ? ` · ${cell.heightPx}px` : ""}`;
    }
    place(c.meta, { left: Math.max(rect.left + 40, rect.right - 90), top: rect.top + 6 });
    place(c.east, { left: rect.right - 5, top: rect.top, height: h });
    place(c.south, { left: rect.left, top: rect.bottom - 5, width: w });
  }
}

function tick() {
  if (!session) return;
  updateChrome();
  session.raf = requestAnimationFrame(tick);
}

// ── Model helpers ─────────────────────────────────────────────────────

function findCell(model, blockId) {
  for (let r = 0; r < model.rows.length; r++) {
    const i = model.rows[r].cells.findIndex((c) => c.block === blockId);
    if (i !== -1) return { rowIdx: r, cellIdx: i };
  }
  return null;
}

function isValid(proposed) {
  try {
    validateLayout(session.blocks, deepCopyModel(proposed));
    return true;
  } catch {
    return false;
  }
}

function propose() {
  post({ type: "PROPOSE", nonce: session.nonce, model: session.model });
}

// Per-row geometry (viewport coords) for hit-testing drop targets.
function rowGeometry() {
  const s = session;
  return s.model.rows.map((row) => {
    const els = [];
    const cellRects = [];
    for (const cell of row.cells) {
      const t = s.tiles.get(cell.block);
      if (t) {
        els.push(t.el);
        cellRects.push({ block: cell.block, rect: unionRect([t.el]) });
      } else if (s.dynEls.has(cell.block)) {
        for (const el of s.dynEls.get(cell.block)) els.push(el);
        cellRects.push({ block: cell.block, rect: unionRect(s.dynEls.get(cell.block)) });
      } else {
        cellRects.push({ block: cell.block, rect: null });
      }
    }
    return { rect: unionRect(els), cellRects };
  });
}

// ── Drag to move ──────────────────────────────────────────────────────

function startDrag(ev, blockId) {
  ev.preventDefault();
  const s = session;
  const from = findCell(s.model, blockId);
  if (!from || s.drag) return;
  const chrome = s.chrome.find((c) => c.kind === "tile" && c.blockId === blockId);
  chrome?.box.classList.add("dragging");
  if (chrome) chrome.el.style.opacity = "0.45";

  s.ghost.textContent = labelOf(blockId);
  s.ghost.style.display = "block";
  s.drag = { blockId, from, target: null };

  const clearIndicators = () => {
    s.gapline.style.display = "none";
    s.colline.style.display = "none";
    s.rowring.style.display = "none";
  };

  const onMove = (e) => {
    if (session !== s) return; // torn down mid-drag (Cancel / superseding INIT)
    s.ghost.style.left = `${e.clientX + 12}px`;
    s.ghost.style.top = `${e.clientY + 12}px`;
    clearIndicators();
    s.drag.target = null;

    // All targeting logic is pure (layout-model.mjs): inside a row band, the
    // top/bottom edge strips mean "new row above/below", the middle means
    // "join this row as a column at the x-derived slot"; outside every band,
    // the nearest row gap wins. Every candidate is gated by the engine's
    // validateLayout, with fallbacks so no spot is a dead zone.
    const picked = pickDropTarget({ x: e.clientX, y: e.clientY }, rowGeometry(), (t) =>
      isValid(moveBlock(s.model, from.rowIdx, from.cellIdx, t)),
    );
    if (!picked) return;
    s.drag.target = picked.target;

    if (picked.indicator.kind === "gap") {
      const cr = s.container.getBoundingClientRect();
      place(s.gapline, { left: cr.left, top: picked.indicator.y - 2, width: cr.width });
      s.gapline.style.display = "block";
    } else {
      const row = picked.indicator.row;
      place(s.rowring, {
        left: row.left - 5,
        top: row.top - 5,
        width: row.right - row.left + 10,
        height: row.bottom - row.top + 10,
      });
      s.rowring.style.display = "block";
      // Vertical slot line BETWEEN columns (or at the row's edges) so a
      // column drop reads differently from a new-row drop.
      place(s.colline, {
        left: picked.indicator.x - 2,
        top: row.top - 5,
        height: row.bottom - row.top + 10,
      });
      s.colline.style.display = "block";
    }
  };

  const onUp = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    s.ghost.style.display = "none";
    clearIndicators();
    chrome?.box.classList.remove("dragging");
    if (chrome) chrome.el.style.opacity = "";
    const target = s.drag?.target;
    s.drag = null;
    if (target && session === s) {
      s.model = moveBlock(s.model, from.rowIdx, from.cellIdx, target);
      layoutFrame();
      propose();
    }
  };
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
}

// ── Resize ────────────────────────────────────────────────────────────

function startResizeW(ev, blockId) {
  ev.preventDefault();
  const s = session;
  const loc = findCell(s.model, blockId);
  if (!loc) return;
  const row = s.model.rows[loc.rowIdx];
  const cell = row.cells[loc.cellIdx];
  const startSpan = cell.span ?? Math.max(1, Math.floor(COLS / row.cells.length));
  const cr = s.container.getBoundingClientRect();
  const colStep = (cr.width - GRID_GAP * (COLS - 1)) / COLS + GRID_GAP;
  const startX = ev.clientX;
  const others = row.cells.reduce(
    (a, c, i) => (i === loc.cellIdx ? a : a + (c.span ?? Math.floor(COLS / row.cells.length))),
    0,
  );

  const onMove = (e) => {
    if (session !== s) return; // torn down mid-resize
    let span = Math.round(startSpan + (e.clientX - startX) / colStep);
    span = Math.max(1, Math.min(COLS - others, span));
    if (span !== cell.span) {
      cell.span = span;
      layoutFrame();
    }
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    if (session === s) propose();
  };
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
}

function startResizeH(ev, blockId) {
  ev.preventDefault();
  const s = session;
  const loc = findCell(s.model, blockId);
  if (!loc) return;
  const cell = s.model.rows[loc.rowIdx].cells[loc.cellIdx];
  const tile = s.tiles.get(blockId);
  const startH = cell.heightPx ?? (tile ? tile.el.getBoundingClientRect().height : 240);
  const startY = ev.clientY;

  const onMove = (e) => {
    if (session !== s) return; // torn down mid-resize
    const h = Math.max(60, Math.min(2000, Math.round(startH + (e.clientY - startY))));
    if (h !== cell.heightPx) {
      cell.heightPx = h;
      layoutFrame();
    }
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    if (session === s) propose();
  };
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
}
