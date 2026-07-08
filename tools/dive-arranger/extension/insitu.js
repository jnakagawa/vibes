// Top-frame controller for the in-situ (WYSIWYG) arranger. The rendered tiles
// live in the cross-origin sandbox iframe (motherduckusercontent.com); the
// drag UX runs there (frame.js). This module owns the SOURCE OF TRUTH:
//  - discovers blocks from the dive source (engine)
//  - hands the iframe a block manifest + layout model (postMessage bridge)
//  - validates every proposed mutation with the engine's validateLayout and
//    replies with the authoritative model
//  - renders a slim toolbar (status / View code / Submit / Cancel); Submit is
//    the ONLY write path (applyLayout → MD_UPDATE_DIVE_CONTENT → read-back)
//
// Throws (before showing any UI) if the iframe bridge can't be established or
// the frame can't map its tiles — content.js then falls back to the card
// overlay.
import {
  discoverBlocks,
  applyLayout,
  validateLayout,
  sqlGetDive,
  sqlStatementsForUpdate,
} from "../engine/index.mjs";
import { deepCopyModel } from "./layout-model.mjs";

const BRIDGE = "dive-arranger-bridge";
const FRAME_ORIGIN = "https://motherduckusercontent.com";

const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .bar {
    position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
    z-index: 2147483646; display: flex; align-items: center; gap: 12px;
    padding: 10px 16px; border-radius: 12px;
    background: #17171b; border: 1px solid #3a3a42; color: #e8e8ea;
    font: 13px/1.45 system-ui, sans-serif;
    box-shadow: 0 10px 40px rgba(0,0,0,.5); max-width: min(96vw, 980px);
  }
  .title { font-weight: 700; white-space: nowrap; }
  .dive { font-family: monospace; font-size: 10px; color: #9a9aa2; }
  .status { font-size: 12px; color: #9a9aa2; max-width: 44ch; overflow: hidden; text-overflow: ellipsis; }
  .status.err { color: #ff7b6b; }
  .status.okk { color: #7fd77f; }
  button {
    font: inherit; padding: 6px 14px; border-radius: 6px; cursor: pointer;
    border: 1px solid #444; background: #26262c; color: #e8e8ea; white-space: nowrap;
  }
  button:hover { background: #32323a; }
  button.primary { background: #0777b3; border-color: #0777b3; font-weight: 600; }
  button.primary:hover { background: #0a8bd0; }
  button:disabled { opacity: .5; cursor: default; }
  .modal {
    position: fixed; inset: 6% 10%; z-index: 2147483647; background: #17171b;
    border: 1px solid #444; border-radius: 10px; display: flex; flex-direction: column;
    font: 13px/1.45 system-ui, sans-serif; color: #e8e8ea;
  }
  .modal header { padding: 10px 14px; border-bottom: 1px solid #333; display: flex; align-items: center; }
  .modal header button { margin-left: auto; }
  .modal pre { flex: 1; overflow: auto; margin: 0; padding: 14px; font: 11px/1.5 ui-monospace, monospace; color: #cfe3cf; }
`;

const nonceStr = () =>
  [...crypto.getRandomValues(new Uint8Array(12))].map((x) => x.toString(16).padStart(2, "0")).join("");

const liteBlocks = (blocks) =>
  blocks.map((b) => ({ id: b.id, kind: b.kind, label: b.label, name: b.name, texts: b.texts }));

/**
 * Open the in-situ arranger. Resolves once the iframe has mapped its tiles
 * and the toolbar is up; REJECTS if the bridge/mapping fails (caller falls
 * back to the card overlay). Returns { close }.
 */
export async function openInSitu({ diveId, source, runQueries, onClose }) {
  let state;
  const setSource = (src) => {
    const { blocks, rows } = discoverBlocks(src);
    state = { source: src, blocks, model: deepCopyModel({ rows }) };
  };
  setSource(source); // DiveShapeError propagates — no fallback would help

  const findFrames = () =>
    [...document.querySelectorAll("iframe")].filter((f) =>
      (f.src || "").startsWith(FRAME_ORIGIN + "/"),
    );
  if (findFrames().length === 0) {
    throw new Error("no dive sandbox iframe (motherduckusercontent.com) found on this page");
  }

  const nonce = nonceStr();
  const send = (win, msg) =>
    win.postMessage({ source: BRIDGE, role: "top", nonce, ...msg }, FRAME_ORIGIN);
  const initPayload = () => ({
    type: "ARRANGE_INIT",
    blocks: liteBlocks(state.blocks),
    model: state.model,
  });

  // ── Handshake: INIT until acked, then wait for MAPPED ───────────────
  const { frameWin, mapped } = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearInterval(resendTimer);
      clearTimeout(deadline);
      window.removeEventListener("message", onMsg);
      fn(arg);
    };
    const onMsg = (ev) => {
      if (ev.origin !== FRAME_ORIGIN) return;
      const d = ev.data;
      if (!d || d.source !== BRIDGE || d.role !== "frame" || d.nonce !== nonce) return;
      if (d.type === "INIT_ACK") acked = true;
      if (d.type === "MAPPED") {
        if (!d.ok) {
          // The sandbox frame's own console is unreachable (cross-origin), so the
          // frame ships its mapping diagnostic up here — logged on app.motherduck.com
          // where it CAN be read. Shows expected model shape + each rejected
          // container candidate's children (class / kids / rowLike / srcCells).
          try {
            console.warn(
              "[dive-arranger] tile mapping failed:",
              d.reason,
              JSON.stringify({ expected: d.expected, diag: d.diag }, null, 2),
            );
            // Mirror onto the shared DOM so an external (main-world) check can
            // read the failure reason even though this console is isolated-world.
            document.documentElement.setAttribute(
              "data-dive-arranger-diag",
              JSON.stringify({ reason: d.reason, expected: d.expected, diag: d.diag }),
            );
          } catch {
            /* diag not serializable — ignore */
          }
        }
        d.ok
          ? finish(resolve, { frameWin: ev.source, mapped: d })
          : finish(reject, new Error(d.reason || "the dive frame could not map its tiles"));
      }
    };
    let acked = false;
    window.addEventListener("message", onMsg);
    const broadcast = () => {
      if (acked) return;
      // Re-query each tick: the MD app may remount the sandbox iframe (React
      // re-render, slow dive load) after the arranger opened.
      for (const f of findFrames()) {
        try {
          send(f.contentWindow, initPayload());
        } catch {
          /* frame not ready */
        }
      }
    };
    broadcast();
    const resendTimer = setInterval(broadcast, 600);
    const deadline = setTimeout(
      () =>
        finish(
          reject,
          new Error(
            acked
              ? "the dive frame accepted the request but never finished mapping"
              : "the dive frame did not respond — reload the tab so the iframe script loads",
          ),
        ),
      15000,
    );
  });

  // ── Toolbar ──────────────────────────────────────────────────────────
  const host = document.createElement("div");
  host.id = "dive-arranger-insitu";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CSS;
  shadow.appendChild(style);
  const bar = document.createElement("div");
  bar.className = "bar";
  bar.innerHTML = `
    <span class="title">Dive Arranger</span>
    <span class="dive"></span>
    <span class="status" id="status"></span>
    <button id="code">View code</button>
    <button id="submit" class="primary">Submit to MotherDuck</button>
    <button id="close">Close</button>
  `;
  bar.querySelector(".dive").textContent = diveId;
  shadow.appendChild(bar);
  document.documentElement.appendChild(host);

  const $status = shadow.getElementById("status");
  const setStatus = (msg, cls = "") => {
    $status.textContent = msg;
    $status.className = `status ${cls}`;
  };
  const inertNote = mapped.inert?.length
    ? ` (${mapped.inert.length} block${mapped.inert.length > 1 ? "s" : ""} not draggable: ${mapped.inert.join(", ")})`
    : "";
  setStatus(`drag tiles in the dive by ⠿ · drag right/bottom edges to resize${inertNote}`);

  // ── Session bridge: validate proposals, own the model ───────────────
  const onSessionMsg = (ev) => {
    if (ev.origin !== FRAME_ORIGIN || ev.source !== frameWin) return;
    const d = ev.data;
    if (!d || d.source !== BRIDGE || d.role !== "frame" || d.nonce !== nonce) return;
    if (d.type === "PROPOSE") {
      try {
        const m = deepCopyModel(d.model);
        validateLayout(state.blocks, m); // throws LayoutError on a bad model
        state.model = m;
        setStatus("layout changed — Submit to save it to the dive");
      } catch (e) {
        setStatus(`change rejected: ${e.message}`, "err");
      }
      // Authoritative model back (the accepted proposal or the previous one).
      send(frameWin, { type: "MODEL", model: state.model });
    }
  };
  window.addEventListener("message", onSessionMsg);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      send(frameWin, { type: "ARRANGE_CANCEL" });
    } catch {
      /* frame already gone */
    }
    window.removeEventListener("message", onSessionMsg);
    host.remove();
    onClose?.();
  };
  shadow.getElementById("close").addEventListener("click", close);

  // ── View code ────────────────────────────────────────────────────────
  shadow.getElementById("code").addEventListener("click", () => {
    shadow.querySelector(".modal")?.remove(); // replace an already-open modal
    let text;
    try {
      text = applyLayout(state.source, deepCopyModel(state.model)).code;
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

  // ── Submit (the only write path; explicit click only) ───────────────
  const $submit = shadow.getElementById("submit");
  $submit.addEventListener("click", async () => {
    $submit.disabled = true;
    try {
      setStatus("generating source …");
      const oldFlatIds = state.model.rows.flatMap((r) => r.cells.map((c) => c.block));
      const { code } = applyLayout(state.source, deepCopyModel(state.model));

      setStatus("writing to MotherDuck …");
      await runQueries(sqlStatementsForUpdate(diveId, code));

      setStatus("verifying read-back …");
      const rows = await runQueries([sqlGetDive(diveId)]);
      const readBack = rows?.[0]?.content;
      if (readBack !== code) {
        throw new Error("read-back does not match what was written — check the dive in MotherDuck");
      }

      // Re-discover from the saved source: block ids are re-assigned in the
      // new source order. applyLayout's self-check guarantees the flat block
      // sequence matches the submitted layout, so map old ids → new by order
      // and let the frame keep its tile handles.
      setSource(readBack);
      const newFlatIds = state.model.rows.flatMap((r) => r.cells.map((c) => c.block));
      if (newFlatIds.length === oldFlatIds.length) {
        send(frameWin, {
          type: "MODEL",
          model: state.model,
          blocks: liteBlocks(state.blocks),
          idMap: oldFlatIds.map((oldId, i) => [oldId, newFlatIds[i]]),
        });
      }
      setStatus(`saved ✓ ${new Date().toLocaleTimeString()} — reload the tab to re-render from source`, "okk");
    } catch (e) {
      setStatus(`submit failed: ${e.message}`, "err");
    } finally {
      $submit.disabled = false;
    }
  });

  return { close };
}
