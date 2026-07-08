// MAIN-world script: runs @motherduck/wasm-client under app.motherduck.com's
// own CSP (which already permits wasm + blob workers — the MotherDuck app is
// itself a duckdb-wasm client). Injected on demand by the content script via
// a <script src=chrome.runtime.getURL(...)> tag; talks to the isolated-world
// content script over window.postMessage.
//
// Protocol (all messages carry { source: "dive-arranger" }):
//   to-main:    { dir: "to-main", id, token, sqls: [sql, ...] }
//   to-content: { dir: "to-content", id, ok, rows? , error? }
// The statements in `sqls` run sequentially on ONE connection (required for
// the SET VARIABLE + MD_UPDATE_DIVE_CONTENT pair); the reply carries the rows
// of the LAST statement.
import { MDConnection } from "@motherduck/wasm-client";

const SOURCE = "dive-arranger";

let connPromise = null;
let connToken = null;

function getConnection(token) {
  if (!connPromise || connToken !== token) {
    connToken = token;
    connPromise = (async () => {
      // Non-COI wasm build: works regardless of the page's cross-origin
      // isolation state (same choice the dive-builder predecessor made).
      const conn = MDConnection.create({ mdToken: token, useDuckDBWasmCOI: false });
      await conn.isInitialized();
      return conn;
    })();
    connPromise.catch(() => {
      connPromise = null;
      connToken = null;
    });
  }
  return connPromise;
}

// DuckDB values → structured-clone/JSON-safe values.
function plain(v) {
  if (v == null) return null;
  const t = typeof v;
  if (t === "bigint") {
    return v >= Number.MIN_SAFE_INTEGER && v <= Number.MAX_SAFE_INTEGER ? Number(v) : String(v);
  }
  if (t === "object") {
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(plain);
    if (ArrayBuffer.isView(v)) return Array.from(v);
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = plain(val);
    return o;
  }
  return v;
}

// The token must never leave this world in an error string: wasm/DuckDB
// errors can echo their inputs, and the reply travels into alert()/status
// text in the content script. Scrub it defensively before replying.
function scrubToken(msg, token) {
  const s = String(msg ?? "unknown error");
  return token ? s.split(token).join("[token]") : s;
}

// Injection guard: a content-script retry (e.g. after an init timeout) can
// inject this script a second time; without the guard both instances would
// answer every request — running each SQL batch, including the dive WRITE,
// twice. Only the first instance registers the query listener.
if (!window.__diveArrangerMdMainLoaded) {
  window.__diveArrangerMdMainLoaded = true;
  window.addEventListener("message", async (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.source !== SOURCE || d.dir !== "to-main") return;
    const reply = (payload) =>
      window.postMessage({ source: SOURCE, dir: "to-content", id: d.id, ...payload }, window.location.origin);
    try {
      if (!d.token) throw new Error("no MotherDuck token provided");
      if (!Array.isArray(d.sqls) || d.sqls.length === 0) throw new Error("no SQL to run");
      const conn = await getConnection(d.token);
      let rows = [];
      for (const sql of d.sqls) {
        const r = await conn.safeEvaluateQuery(String(sql));
        if (r.status === "error") {
          throw r.err instanceof Error ? r.err : new Error(String(r.err?.message ?? r.err));
        }
        rows = r.result.data.toRows().map((row) => {
          const o = {};
          for (const [k, v] of Object.entries(row)) o[k] = plain(v);
          return o;
        });
      }
      reply({ ok: true, rows });
    } catch (e) {
      reply({ ok: false, error: scrubToken(e?.message ?? e, d.token) });
    }
  });
}

// Always announce readiness — a re-injection must still resolve the content
// script's waiting bridge even though the listener above is registered once.
window.postMessage(
  { source: SOURCE, dir: "to-content", id: "__ready__", ok: true },
  window.location.origin,
);
