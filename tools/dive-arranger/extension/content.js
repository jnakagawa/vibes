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
import { resolveToken, classifyAuthError, authMessage, sourceLabel } from "./token.mjs";

const SOURCE = "dive-arranger";
const UUID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

// Build stamp on the SHARED DOM: the content script's console lives in the
// isolated world (not always visible to external readers), but the DOM is
// shared with the page, so an outside check can confirm which bundle is live.
try {
  document.documentElement.setAttribute("data-dive-arranger-build", "tokenresolver-1");
} catch {
  /* documentElement not ready — harmless */
}

const diveIdFromUrl = () => location.pathname.match(UUID_RE)?.[1]?.toLowerCase() ?? null;

// ── Live token capture ────────────────────────────────────────────────
// The MAIN-world token-sniffer (dist/token-sniffer.js, injected at
// document_start via the manifest) intercepts the MD app's OWN auth traffic
// and relays any MotherDuck-shaped JWT here over same-origin postMessage. The
// app fetches this token at load and auto-refreshes it, so a captured 'live'
// token is the freshest, self-rotating credential — preferred over storage
// scans (which find nothing on the current cookie-auth app). The token is held
// only in this in-memory variable; it is never logged or persisted here.
let liveToken = null;
window.addEventListener("message", (ev) => {
  // Same-origin, same-window only — reject anything cross-origin or reposted
  // from another frame/window.
  if (ev.source !== window || ev.origin !== location.origin) return;
  const d = ev.data;
  if (!d || d.source !== "dive-arranger-token" || typeof d.token !== "string") return;
  liveToken = d.token;
});

// ── Token discovery ───────────────────────────────────────────────────
// The resolver core (token.mjs, pure + unit-tested) picks the best token from
// ALL candidates: the live captured token (tagged 'live', preferred), every
// MotherDuck-shaped JWT in the page's local/sessionStorage (the content script
// shares the page origin's storage) tagged 'page', plus the Options fallback
// (chrome.storage.local) tagged 'fallback'. Expired and near-expiry tokens are
// dropped BEFORE selection, and the query path re-resolves once on an auth
// failure — the MD app rotates its token, so a fresher one may have arrived
// (via the sniffer) since launch.

function scanStorageForTokens() {
  const seen = new Set();
  const tokens = [];
  const add = (t) => {
    if (!seen.has(t)) {
      seen.add(t);
      tokens.push(t);
    }
  };
  for (const store of [window.localStorage, window.sessionStorage]) {
    try {
      for (let i = 0; i < store.length; i++) {
        const raw = store.getItem(store.key(i));
        if (!raw) continue;
        if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(raw)) add(raw);
        // Tokens are often nested in JSON blobs (auth caches etc.)
        else if (raw.length < 200000 && raw.includes("eyJ")) {
          for (const cand of raw.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g) || []) add(cand);
        }
      }
    } catch {
      /* storage access denied — move on */
    }
  }
  // MD-ness and expiry are judged by the resolver (tokenInfo), not here.
  return tokens;
}

async function gatherCandidates() {
  const candidates = [];
  // Live captured token FIRST — the resolver prefers source 'live'.
  if (liveToken) candidates.push({ token: liveToken, source: "live" });
  for (const token of scanStorageForTokens()) candidates.push({ token, source: "page" });
  try {
    const { mdToken } = await chrome.storage.local.get("mdToken");
    if (mdToken) candidates.push({ token: mdToken, source: "fallback" });
  } catch {
    // chrome.storage unreachable (e.g. the extension was just reloaded and
    // this content script is orphaned) — live/page candidates only.
  }
  return candidates;
}

// Date.now() lives HERE (the browser side); the resolver stays deterministic.
async function resolveAuth(nowMs) {
  return resolveToken(await gatherCandidates(), nowMs);
}

// sourceLabel (live session / page session / options token) is shared from
// token.mjs so the toolbar and error strings stay in sync.

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
  const resolved = await resolveAuth(Date.now());
  if (!resolved) {
    alert(
      "Dive Arranger: no unexpired MotherDuck token found — open or refresh an " +
        "app.motherduck.com tab so a session token is present, or paste one in the " +
        "extension Options (a short-lived token works).",
    );
    return;
  }
  // authState (token + metadata) stays private to this closure; authView is
  // the descriptor handed to the UIs — source + expiry only, NEVER the token.
  // Both are updated in place when the query path adopts a rotated token, so
  // the toolbar's auth line tracks reality.
  const authState = { token: resolved.token, source: resolved.source, exp: resolved.exp };
  const authView = { source: resolved.source, exp: resolved.exp };

  // Query path with one-shot re-resolve: on an auth-classified failure
  // (expired/scope), re-scan storage — the MD app may have rotated in a fresh
  // session token since we resolved — and retry ONCE, only if the fresh token
  // actually differs from the one that just failed (never loop). Non-auth
  // errors, and auth errors with no different token available, pass through.
  const runQueries = async (sqls) => {
    try {
      return await runQueriesWithToken(sqls, authState.token);
    } catch (e) {
      const kind = classifyAuthError(e?.message);
      if (kind !== "expired" && kind !== "scope") throw e;
      const fresh = await resolveAuth(Date.now());
      if (!fresh || fresh.token === authState.token) throw e;
      const rows = await runQueriesWithToken(sqls, fresh.token);
      Object.assign(authState, { token: fresh.token, source: fresh.source, exp: fresh.exp });
      Object.assign(authView, { source: fresh.source, exp: fresh.exp });
      return rows;
    }
  };

  const btn = ensureButton();

  // Preflight: validate auth with a trivial query BEFORE opening anything, so
  // a dead token surfaces as an actionable message instead of a cryptic
  // wasm/DuckDB dump mid-flow. (Benefits from the re-resolve retry above.)
  try {
    btn.textContent = "checking auth …";
    await runQueries(["SELECT 1"]);
  } catch (e) {
    btn.textContent = BTN_LABEL;
    const kind = classifyAuthError(e?.message);
    // e.message is token-free: md-main scrubs the token from bridge errors,
    // and local bridge failures (timeouts, injection) never carry it.
    alert(`Dive Arranger: ${authMessage(kind)}${kind === "unknown" ? `\n(${e.message})` : ""}`);
    return;
  }

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
      await openInSitu({ diveId, source, runQueries, onClose, auth: authView });
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
        auth: authView,
      });
    }
  } catch (e) {
    overlayOpen = false;
    const kind = classifyAuthError(e?.message);
    alert(
      kind === "unknown"
        ? `Dive Arranger: ${e.message}\n(auth: ${sourceLabel(authState.source)})`
        : `Dive Arranger: ${authMessage(kind)}`,
    );
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
