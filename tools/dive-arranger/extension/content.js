// Isolated-world content script (TOP frame, app.motherduck.com): detects dive
// pages, finds a MotherDuck token, bridges SQL to the main-world wasm client,
// and opens the arranger.
//
// The arranger itself prefers IN-SITU mode (insitu.js): the dive's rendered
// tiles live in a cross-origin sandbox iframe (motherduckusercontent.com),
// where dist/frame.js runs and puts drag handles on the REAL tiles. Only if
// that bridge cannot be established does this fall back to the card overlay.
//
// Activation: a floating "Arrange" button on any app.motherduck.com URL that
// contains a dive UUID, plus the toolbar action (via the service worker).
import { openArranger } from "./overlay.js";
import { openInSitu } from "./insitu.js";
import { sqlGetDive, DiveShapeError } from "../engine/index.mjs";

const SOURCE = "dive-arranger";
const UUID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

// Build stamp on the SHARED DOM: the content script's console lives in the
// isolated world (not always visible to external readers), but the DOM is
// shared with the page, so an outside check can confirm which bundle is live.
try {
  document.documentElement.setAttribute("data-dive-arranger-build", "modelaware-1");
} catch {
  /* documentElement not ready — harmless */
}

const diveIdFromUrl = () => location.pathname.match(UUID_RE)?.[1]?.toLowerCase() ?? null;

// ── Token discovery ───────────────────────────────────────────────────
// Priority: (1) a MotherDuck-looking JWT in the page's local/sessionStorage
// (the content script shares the page origin's storage), (2) the fallback
// token pasted in the extension options (chrome.storage.local).

function looksLikeMdJwt(value) {
  if (typeof value !== "string") return false;
  const m = value.match(/^eyJ[\w-]+\.([\w-]+)\.[\w-]+$/);
  if (!m) return false;
  try {
    const payload = JSON.parse(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")));
    return Boolean(payload.mdRegion || payload.tokenType || payload.tokenId);
  } catch {
    return false;
  }
}

function scanStorageForToken() {
  for (const store of [window.localStorage, window.sessionStorage]) {
    try {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        const raw = store.getItem(key);
        if (!raw) continue;
        if (looksLikeMdJwt(raw)) return raw;
        // Tokens are often nested in JSON blobs (auth caches etc.)
        if (raw.length < 200000 && raw.includes("eyJ")) {
          for (const cand of raw.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g) || []) {
            if (looksLikeMdJwt(cand)) return cand;
          }
        }
      }
    } catch {
      /* storage access denied — move on */
    }
  }
  return null;
}

async function findToken() {
  const fromPage = scanStorageForToken();
  if (fromPage) return { token: fromPage, source: "page storage" };
  const { mdToken } = await chrome.storage.local.get("mdToken");
  if (mdToken) return { token: mdToken, source: "extension options" };
  return null;
}

// ── Main-world bridge ─────────────────────────────────────────────────

let mainWorldReady = null;

function ensureMainWorld() {
  if (mainWorldReady) return mainWorldReady;
  mainWorldReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMsg);
      reject(new Error("MotherDuck wasm client did not initialize (main-world script timeout)"));
    }, 30000);
    const onMsg = (ev) => {
      const d = ev.data;
      if (ev.source === window && d?.source === SOURCE && d.dir === "to-content" && d.id === "__ready__") {
        clearTimeout(timer);
        window.removeEventListener("message", onMsg);
        resolve();
      }
    };
    window.addEventListener("message", onMsg);
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("dist/md-main.js");
    s.onerror = () => {
      clearTimeout(timer);
      reject(new Error("failed to inject the wasm client script"));
    };
    (document.head || document.documentElement).appendChild(s);
  });
  mainWorldReady.catch(() => {
    mainWorldReady = null;
  });
  return mainWorldReady;
}

let reqSeq = 0;
async function runQueriesWithToken(sqls, token) {
  await ensureMainWorld();
  const id = `q${++reqSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMsg);
      reject(new Error("MotherDuck query timed out (120s)"));
    }, 120000);
    const onMsg = (ev) => {
      const d = ev.data;
      if (ev.source !== window || d?.source !== SOURCE || d.dir !== "to-content" || d.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMsg);
      d.ok ? resolve(d.rows) : reject(new Error(d.error));
    };
    window.addEventListener("message", onMsg);
    window.postMessage({ source: SOURCE, dir: "to-main", id, token, sqls }, window.location.origin);
  });
}

// ── Launch flow ───────────────────────────────────────────────────────

let overlayOpen = false;

async function launch() {
  if (overlayOpen) return;
  const diveId = diveIdFromUrl();
  if (!diveId) {
    alert("Dive Arranger: no dive id found in this URL — open a dive first.");
    return;
  }
  let auth = null;
  try {
    auth = await findToken();
  } catch {
    // chrome.storage unreachable (e.g. the extension was just reloaded and
    // this content script is orphaned) — treat as "no token found".
  }
  if (!auth) {
    alert(
      "Dive Arranger: no MotherDuck token found in the page, and no fallback token is set.\n" +
        "Open the extension's Options page and paste a token (a short-lived token works).",
    );
    return;
  }
  const runQueries = (sqls) => runQueriesWithToken(sqls, auth.token);

  const btn = ensureButton();
  try {
    btn.textContent = "loading dive …";
    const rows = await runQueries([sqlGetDive(diveId)]);
    if (!rows?.length || rows[0].content == null) throw new Error("MD_GET_DIVE returned no content");
    const source = String(rows[0].content);
    const onClose = () => {
      overlayOpen = false;
    };
    overlayOpen = true;
    try {
      btn.textContent = "mapping tiles …";
      await openInSitu({ diveId, source, runQueries, onClose });
    } catch (bridgeErr) {
      // A dive the engine can't decompose fails the same way in either UI —
      // surface that instead of falling back.
      if (bridgeErr instanceof DiveShapeError) throw bridgeErr;
      // Degraded fallback: card overlay in the top frame (the iframe bridge
      // or tile mapping failed, so there are no rendered tiles to drag).
      openArranger({
        diveId,
        source,
        runQueries,
        note: `in-place mode unavailable: ${bridgeErr.message} — using card view`,
        onClose,
      });
    }
  } catch (e) {
    overlayOpen = false;
    alert(`Dive Arranger: ${e.message}\n(token source: ${auth.source})`);
  } finally {
    btn.textContent = BTN_LABEL;
  }
}

// ── Floating button ───────────────────────────────────────────────────

const BTN_LABEL = "⠿ Arrange";
let btnEl = null;

function ensureButton() {
  if (btnEl && btnEl.isConnected) return btnEl;
  btnEl = document.createElement("button");
  btnEl.textContent = BTN_LABEL;
  Object.assign(btnEl.style, {
    position: "fixed",
    right: "16px",
    bottom: "16px",
    zIndex: 2147483645,
    font: "600 12px system-ui, sans-serif",
    padding: "8px 14px",
    borderRadius: "18px",
    border: "1px solid #0777b3",
    background: "#0777b3",
    color: "#fff",
    cursor: "pointer",
    boxShadow: "0 2px 10px rgba(0,0,0,0.3)",
  });
  btnEl.addEventListener("click", launch);
  document.documentElement.appendChild(btnEl);
  return btnEl;
}

function syncButton() {
  if (diveIdFromUrl()) {
    ensureButton();
  } else if (btnEl) {
    btnEl.remove();
    btnEl = null;
  }
}

// The MD app is a SPA — watch for URL changes.
let lastHref = null;
setInterval(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    syncButton();
  }
}, 800);
syncButton();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "dive-arranger:open") launch();
});
