// The arranger overlay: a shadow-DOM panel listing the dive's blocks as
// draggable cards on a 12-column grid of rows. Hand-rolled pointer-event
// drag & resize (deliberately no react-grid-layout — see DESIGN.md).
//
// The layout model here IS the engine's layout model ({ rows: [{ cells }] }),
// and every tentative mutation is checked with the engine's validateLayout —
// the UI cannot express an arrangement the engine would reject (e.g. moving a
// block across a pinned dynamic block).
import {
  discoverBlocks,
  applyLayout,
  validateLayout,
  sqlGetDive,
  sqlStatementsForUpdate,
} from "../engine/index.mjs";
import { mapBlocksToDom, snapshotElement } from "./snapshot.js";
import { COLS, deepCopyModel as deepCopy, moveBlock } from "./layout-model.mjs";
import { classifyAuthError, authMessage, fmtExpiry } from "./token.mjs";

const hash = (s) => {
  let h = 5381;
  const t = s.replace(/\s+/g, " ");
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
  return String(h >>> 0);
};

const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .backdrop {
    position: fixed; inset: 0; z-index: 2147483646;
    background: rgba(20, 20, 24, 0.92);
    font: 13px/1.45 system-ui, sans-serif; color: #e8e8ea;
    display: flex; flex-direction: column;
  }
  .bar {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 16px; background: #17171b; border-bottom: 1px solid #333;
    flex: none;
  }
  .bar .title { font-weight: 700; font-size: 14px; }
  .bar .dive { font-family: monospace; font-size: 11px; color: #9a9aa2; }
  .bar .auth { font-size: 11px; color: #6a6a72; white-space: nowrap; }
  .bar .auth.warn { color: #e8c76a; }
  .bar .spacer { flex: 1; }
  .bar button {
    font: inherit; padding: 6px 14px; border-radius: 6px; cursor: pointer;
    border: 1px solid #444; background: #26262c; color: #e8e8ea;
  }
  .bar button:hover { background: #32323a; }
  .bar button.primary { background: #0777b3; border-color: #0777b3; font-weight: 600; }
  .bar button.primary:hover { background: #0a8bd0; }
  .bar button:disabled { opacity: 0.5; cursor: default; }
  .status { font-size: 12px; color: #9a9aa2; max-width: 40ch; }
  .status.err { color: #ff7b6b; }
  .status.okk { color: #7fd77f; }
  .canvas { flex: 1; overflow: auto; padding: 24px; }
  .rows { max-width: 1240px; margin: 0 auto; display: flex; flex-direction: column; gap: 10px; }
  .gap { height: 8px; border-radius: 4px; }
  .gap.target { background: #0777b3; }
  .row {
    display: grid; grid-template-columns: repeat(${COLS}, minmax(0, 1fr));
    gap: 10px; align-items: start; position: relative;
  }
  .row.target::before {
    content: ""; position: absolute; inset: -5px; border: 2px dashed #0777b3;
    border-radius: 8px; pointer-events: none;
  }
  .card {
    background: #1f1f24; border: 1px solid #3a3a42; border-radius: 8px;
    overflow: hidden; position: relative; min-width: 0;
  }
  .card.pinned { border-style: dashed; opacity: 0.85; }
  .card.dragging { opacity: 0.35; }
  .card header {
    display: flex; align-items: center; gap: 8px; padding: 6px 10px;
    background: #26262c; border-bottom: 1px solid #3a3a42; user-select: none;
  }
  .card header .grip { cursor: grab; color: #9a9aa2; font-size: 15px; touch-action: none; }
  .card header .label {
    font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .card header .meta { margin-left: auto; font-size: 11px; color: #9a9aa2; white-space: nowrap; }
  .badge {
    font-size: 10px; padding: 1px 6px; border-radius: 8px; background: #444; color: #ccc;
  }
  .badge.pin { background: #5a4a1f; color: #e8c76a; }
  .preview { position: relative; overflow: hidden; background: #fff; }
  .preview .scaler { transform-origin: 0 0; }
  .preview.code { background: #17171b; }
  .preview.code pre {
    margin: 0; padding: 10px; font: 10px/1.5 ui-monospace, monospace;
    color: #b8c8b8; white-space: pre-wrap; word-break: break-word; max-height: 180px; overflow: hidden;
  }
  .rz-e { position: absolute; top: 0; right: 0; width: 8px; height: 100%; cursor: ew-resize; touch-action: none; }
  .rz-s { position: absolute; bottom: 0; left: 0; height: 8px; width: 100%; cursor: ns-resize; touch-action: none; }
  .rz-e:hover, .rz-s:hover { background: rgba(7, 119, 179, 0.5); }
  .ghost {
    position: fixed; z-index: 2147483647; pointer-events: none; opacity: 0.9;
    border: 1px solid #0777b3; border-radius: 8px; background: #1f1f24;
    padding: 6px 12px; font-weight: 600; box-shadow: 0 8px 30px rgba(0,0,0,0.5);
  }
  .modal {
    position: fixed; inset: 6% 10%; z-index: 2147483647; background: #17171b;
    border: 1px solid #444; border-radius: 10px; display: flex; flex-direction: column;
  }
  .modal header { padding: 10px 14px; border-bottom: 1px solid #333; display: flex; }
  .modal header button { margin-left: auto; }
  .modal pre {
    flex: 1; overflow: auto; margin: 0; padding: 14px;
    font: 11px/1.5 ui-monospace, monospace; color: #cfe3cf;
  }
  .hint { text-align: center; color: #6a6a72; font-size: 11px; padding: 10px 0 30px; }
`;

export function openArranger({ diveId, source, runQueries, onClose, note, auth }) {
  // ── state ─────────────────────────────────────────────────────────
  let state;
  const previews = new Map(); // hash(block.code) -> {node,width,height} | "none"

  const setSource = (src) => {
    const { blocks, rows } = discoverBlocks(src);
    state = { source: src, blocks, model: { rows: rows.map((r) => ({ cells: r.cells.map((c) => ({ ...c })) })) } };
  };
  setSource(source);

  const blockById = (id) => state.blocks.find((b) => b.id === id);

  const captureSnapshots = () => {
    const dom = mapBlocksToDom(state.blocks);
    for (const b of state.blocks) {
      const key = hash(b.code);
      if (previews.has(key) && previews.get(key) !== "none") continue;
      const el = dom.get(b.id);
      const snap = el ? snapshotElement(el) : null;
      previews.set(key, snap || "none");
    }
  };
  try { captureSnapshots(); } catch { /* preview-only failure is fine */ }

  // ── shell ─────────────────────────────────────────────────────────
  const host = document.createElement("div");
  host.id = "dive-arranger-host";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CSS;
  shadow.appendChild(style);

  const backdrop = document.createElement("div");
  backdrop.className = "backdrop";
  backdrop.innerHTML = `
    <div class="bar">
      <span class="title">Dive Arranger</span>
      <span class="dive">${diveId}</span>
      <span class="auth" id="auth"></span>
      <span class="status" id="status">drag cards by ⠿ · drag right/bottom edges to resize</span>
      <span class="spacer"></span>
      <button id="code">View code</button>
      <button id="submit" class="primary">Submit to MotherDuck</button>
      <button id="close">Close</button>
    </div>
    <div class="canvas"><div class="rows" id="rows"></div>
      <div class="hint">pinned cards (dashed) come from conditionals/loops — v1 shows them in place but never moves them</div>
    </div>
  `;
  shadow.appendChild(backdrop);
  document.documentElement.appendChild(host);

  const $rows = shadow.getElementById("rows");
  const $status = shadow.getElementById("status");
  const setStatus = (msg, cls = "") => {
    $status.textContent = msg;
    $status.className = `status ${cls}`;
  };

  // Auth transparency (parity with the in-situ toolbar): source + expiry
  // only, never the token. `auth` is a live descriptor content.js updates in
  // place on token rotation; amber once under 5 minutes remain.
  const $auth = shadow.getElementById("auth");
  const renderAuth = () => {
    if (!auth) {
      $auth.textContent = "";
      return;
    }
    const label = auth.source === "page" ? "page session" : "options token";
    $auth.textContent = `auth: ${label} · exp ${fmtExpiry(auth.exp)}`;
    const msLeft = auth.exp == null ? Infinity : auth.exp - Date.now();
    $auth.className = `auth${msLeft < 5 * 60_000 ? " warn" : ""}`;
  };
  renderAuth();
  const authTimer = setInterval(renderAuth, 30_000);

  const close = () => {
    clearInterval(authTimer);
    host.remove();
    onClose?.();
  };
  shadow.getElementById("close").addEventListener("click", close);

  // ── validation oracle ─────────────────────────────────────────────
  const isValid = (model) => {
    try {
      validateLayout(state.blocks, deepCopy(model));
      return true;
    } catch {
      return false;
    }
  };

  // ── rendering ─────────────────────────────────────────────────────
  function render() {
    $rows.textContent = "";
    state.model.rows.forEach((row, rowIdx) => {
      $rows.appendChild(gapEl(rowIdx));
      const rowEl = document.createElement("div");
      rowEl.className = "row";
      rowEl.dataset.row = rowIdx;
      row.cells.forEach((cell, cellIdx) => {
        rowEl.appendChild(cardEl(row, cell, rowIdx, cellIdx));
      });
      $rows.appendChild(rowEl);
    });
    $rows.appendChild(gapEl(state.model.rows.length));
  }

  function gapEl(insertIdx) {
    const g = document.createElement("div");
    g.className = "gap";
    g.dataset.gap = insertIdx;
    return g;
  }

  function cardEl(row, cell, rowIdx, cellIdx) {
    const b = blockById(cell.block);
    const el = document.createElement("div");
    el.className = `card${b.kind === "dynamic" ? " pinned" : ""}`;
    el.style.gridColumn = `span ${cell.span ?? Math.floor(COLS / row.cells.length)}`;
    el.dataset.row = rowIdx;
    el.dataset.cell = cellIdx;

    const header = document.createElement("header");
    header.innerHTML = `
      ${b.kind === "dynamic" ? `<span class="badge pin">pinned</span>` : `<span class="grip" title="drag to move">⠿</span>`}
      <span class="label"></span>
      <span class="meta">${cell.span ?? 12}/${COLS}${cell.heightPx ? ` · ${cell.heightPx}px` : ""}</span>
    `;
    header.querySelector(".label").textContent = `${b.label}  ·  ${b.name}`;
    el.appendChild(header);

    const key = hash(b.code);
    const snap = previews.get(key);
    const prev = document.createElement("div");
    if (snap && snap !== "none") {
      prev.className = "preview";
      const scaler = document.createElement("div");
      scaler.className = "scaler";
      scaler.appendChild(snap.node.cloneNode(true));
      prev.appendChild(scaler);
      requestAnimationFrame(() => {
        const w = prev.clientWidth || 300;
        const scale = Math.min(1, w / snap.width);
        scaler.style.transform = `scale(${scale})`;
        scaler.style.width = `${snap.width}px`;
        prev.style.height = `${Math.min(cell.heightPx || 240, snap.height * scale)}px`;
      });
    } else {
      prev.className = "preview code";
      const pre = document.createElement("pre");
      pre.textContent = b.code.length > 700 ? b.code.slice(0, 700) + "\n…" : b.code;
      prev.appendChild(pre);
    }
    el.appendChild(prev);

    if (b.kind !== "dynamic") {
      const east = document.createElement("div");
      east.className = "rz-e";
      east.title = "drag to change width";
      el.appendChild(east);
      const south = document.createElement("div");
      south.className = "rz-s";
      south.title = "drag to set height · double-click to reset";
      el.appendChild(south);

      header.querySelector(".grip").addEventListener("pointerdown", (ev) => startDrag(ev, rowIdx, cellIdx, el));
      east.addEventListener("pointerdown", (ev) => startResizeW(ev, rowIdx, cellIdx, el));
      south.addEventListener("pointerdown", (ev) => startResizeH(ev, rowIdx, cellIdx, el));
      south.addEventListener("dblclick", () => {
        state.model.rows[rowIdx].cells[cellIdx].heightPx = null;
        render();
      });
    }
    return el;
  }

  // ── drag to move ──────────────────────────────────────────────────
  function startDrag(ev, fromRow, fromCell, cardNode) {
    ev.preventDefault();
    const blockId = state.model.rows[fromRow].cells[fromCell].block;
    const b = blockById(blockId);
    cardNode.classList.add("dragging");

    const ghost = document.createElement("div");
    ghost.className = "ghost";
    ghost.textContent = b.label;
    shadow.appendChild(ghost);

    let target = null; // {kind:"gap",idx} | {kind:"cell",rowIdx,cellIdx}

    // Shared with the in-iframe arranger: extension/layout-model.mjs.
    const buildModel = (t) => moveBlock(state.model, fromRow, fromCell, t);

    const clearHighlights = () => {
      for (const n of $rows.querySelectorAll(".target")) n.classList.remove("target");
    };

    const onMove = (e) => {
      ghost.style.left = `${e.clientX + 10}px`;
      ghost.style.top = `${e.clientY + 10}px`;
      clearHighlights();
      target = null;

      for (const rowEl of $rows.querySelectorAll(".row")) {
        const r = rowEl.getBoundingClientRect();
        if (e.clientY >= r.top && e.clientY <= r.bottom) {
          const rowIdx = Number(rowEl.dataset.row);
          const cells = [...rowEl.children];
          let cellIdx = cells.length;
          for (let i = 0; i < cells.length; i++) {
            const cr = cells[i].getBoundingClientRect();
            if (e.clientX < cr.left + cr.width / 2) {
              cellIdx = i;
              break;
            }
          }
          const t = { kind: "cell", rowIdx, cellIdx };
          if (isValid(buildModel(t))) {
            target = t;
            rowEl.classList.add("target");
          }
          return;
        }
      }
      let best = null;
      for (const gapEl_ of $rows.querySelectorAll(".gap")) {
        const r = gapEl_.getBoundingClientRect();
        const d = Math.abs(e.clientY - (r.top + r.height / 2));
        if (!best || d < best.d) best = { d, el: gapEl_ };
      }
      if (best && best.d < 120) {
        const t = { kind: "gap", idx: Number(best.el.dataset.gap) };
        if (isValid(buildModel(t))) {
          target = t;
          best.el.classList.add("target");
        }
      }
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      ghost.remove();
      cardNode.classList.remove("dragging");
      clearHighlights();
      if (target) {
        state.model = buildModel(target);
        render();
      }
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
  }

  // ── resize ────────────────────────────────────────────────────────
  function startResizeW(ev, rowIdx, cellIdx, el) {
    ev.preventDefault();
    const row = state.model.rows[rowIdx];
    const cell = row.cells[cellIdx];
    const startSpan = cell.span ?? COLS;
    const colW = el.getBoundingClientRect().width / startSpan;
    const startX = ev.clientX;
    const others = row.cells.reduce((a, c, i) => (i === cellIdx ? a : a + (c.span ?? COLS)), 0);

    const onMove = (e) => {
      let span = Math.round(startSpan + (e.clientX - startX) / colW);
      span = Math.max(1, Math.min(COLS - others, span));
      if (span !== cell.span) {
        cell.span = span;
        el.style.gridColumn = `span ${span}`;
        el.querySelector(".meta").textContent = `${span}/${COLS}${cell.heightPx ? ` · ${cell.heightPx}px` : ""}`;
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      render();
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
  }

  function startResizeH(ev, rowIdx, cellIdx, el) {
    ev.preventDefault();
    const cell = state.model.rows[rowIdx].cells[cellIdx];
    const startH = cell.heightPx ?? el.querySelector(".preview").getBoundingClientRect().height;
    const startY = ev.clientY;
    const prev = el.querySelector(".preview");

    const onMove = (e) => {
      const h = Math.max(60, Math.min(2000, Math.round(startH + (e.clientY - startY))));
      cell.heightPx = h;
      prev.style.height = `${h}px`;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      render();
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
  }

  // ── view code ─────────────────────────────────────────────────────
  shadow.getElementById("code").addEventListener("click", () => {
    shadow.querySelector(".modal")?.remove(); // replace an already-open modal
    let text;
    try {
      text = applyLayout(state.source, deepCopy(state.model)).code;
    } catch (e) {
      text = `// layout is not currently valid:\n// ${e.message}`;
    }
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.innerHTML = `<header><span>Source that Submit would write</span><button>Close</button></header><pre></pre>`;
    modal.querySelector("pre").textContent = text;
    modal.querySelector("button").addEventListener("click", () => modal.remove());
    shadow.appendChild(modal);
  });

  // ── submit ────────────────────────────────────────────────────────
  const $submit = shadow.getElementById("submit");
  $submit.addEventListener("click", async () => {
    $submit.disabled = true;
    try {
      setStatus("generating source …");
      const { code } = applyLayout(state.source, deepCopy(state.model));

      setStatus("writing to MotherDuck …");
      await runQueries(sqlStatementsForUpdate(diveId, code));

      setStatus("verifying read-back …");
      const rows = await runQueries([sqlGetDive(diveId)]);
      const readBack = rows?.[0]?.content;
      if (readBack !== code) {
        throw new Error("read-back does not match what was written — check the dive in MotherDuck");
      }
      discoverBlocks(readBack); // must still parse + discover

      setSource(readBack);
      render();
      setStatus(`saved ✓ ${new Date().toLocaleTimeString()} — reload the dive tab to see it live`, "okk");
    } catch (e) {
      // Same actionable-error treatment as the in-situ toolbar: auth failures
      // get authMessage; everything else passes through unchanged.
      const kind = classifyAuthError(e?.message);
      setStatus(kind === "unknown" ? `submit failed: ${e.message}` : authMessage(kind), "err");
    } finally {
      renderAuth(); // the query path may have adopted a rotated token
      $submit.disabled = false;
    }
  });

  render();
  if (note) setStatus(note, "err");
  return { close };
}
