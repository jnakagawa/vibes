// Pure token-resolver core: expiry-aware MotherDuck JWT selection plus
// auth-error classification and the user-facing strings for both.
// No DOM, no chrome.*, and deliberately no Date.now() — callers pass `nowMs`
// so every function is deterministic and Node-testable (harness/token.test.mjs).
//
// Token safety: nothing in this module ever logs, stores, or embeds a token
// in a produced string. `authMessage` returns fixed text; `fmtExpiry` formats
// a timestamp; `tokenInfo`/`resolveToken` only carry the token forward as a
// field for the caller to use.

/**
 * A token whose remaining life is under this margin is treated as expired:
 * by the time the wasm client connects and the query runs, a near-dead token
 * would fail anyway — never select one.
 */
export const SKEW_MS = 45_000;

/**
 * Base64url-decode a JWT's payload segment. Returns the payload object, or
 * null for anything that isn't a well-formed three-segment JWT with a JSON
 * object payload. Never throws.
 */
export function decodeJwt(token) {
  if (typeof token !== "string") return null;
  const m = token.match(/^eyJ[\w-]+\.([\w-]+)\.[\w-]+$/);
  if (!m) return null;
  try {
    const payload = JSON.parse(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Does a decoded JWT payload look like a MotherDuck token? Same heuristic
 * the storage scan has always used: MD tokens carry mdRegion / tokenType /
 * tokenId claims that generic auth JWTs don't.
 */
export function isMdJwt(payload) {
  return Boolean(payload && (payload.mdRegion || payload.tokenType || payload.tokenId));
}

/**
 * Find the first MotherDuck-shaped JWT inside an arbitrary string — an
 * `Authorization: Bearer …` header, an `x-motherduck-*` header, a JSON
 * response body, or a WebSocket connect URL. Scans every JWT-looking
 * substring and returns the first whose payload passes `isMdJwt`, or null
 * when there is none (non-MD JWTs and garbage are ignored). Never throws.
 *
 * This is what the MAIN-world token-sniffer uses to lift the MD app's OWN
 * live, auto-rotating access token out of its network traffic — the app keeps
 * that token in memory (no localStorage JWT to scan), so intercepting the
 * transport is the only way to see it.
 */
export function extractMdJwt(str) {
  if (typeof str !== "string" || !str.includes("eyJ")) return null;
  const matches = str.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g);
  if (!matches) return null;
  for (const candidate of matches) {
    if (isMdJwt(decodeJwt(candidate))) return candidate;
  }
  return null;
}

/**
 * Inspect one token: `{ token, source?, exp, expired, msLeft }`, or null if
 * it isn't a MotherDuck JWT.
 *  - `exp` — ms since epoch (JWT `exp` is in SECONDS → ×1000), or null when
 *    the token has no (numeric) exp claim: no claim means non-expiring.
 *  - `msLeft` — exp − nowMs, or Infinity for non-expiring tokens.
 *  - `expired` — true when msLeft < SKEW_MS (near-dead counts as dead).
 */
export function tokenInfo(token, nowMs, source) {
  const payload = decodeJwt(token);
  if (!isMdJwt(payload)) return null;
  const exp =
    typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  const msLeft = exp == null ? Infinity : exp - nowMs;
  const info = { token, exp, expired: msLeft < SKEW_MS, msLeft };
  if (source !== undefined) info.source = source;
  return info;
}

/**
 * Pick the best usable token from `candidates` = [{ token, source }] where
 * source is 'live' (captured from the MD app's OWN network traffic by the
 * token-sniffer), 'page' (found in the MD tab's storage), or 'fallback'
 * (Options). Non-MD/garbage candidates and expired/near-expiry tokens are
 * dropped; the survivors rank by source ('live' before 'page' before
 * 'fallback' — the live token is the credential the app itself fetched and
 * auto-rotates, so it's the freshest), then by msLeft descending. Returns the
 * winning tokenInfo (with source) or null when nothing valid remains.
 */
export function resolveToken(candidates, nowMs) {
  const usable = [];
  for (const c of candidates ?? []) {
    const info = c && tokenInfo(c.token, nowMs, c.source);
    if (info && !info.expired) usable.push(info);
  }
  if (usable.length === 0) return null;
  const srcRank = (s) => (s === "live" ? 0 : s === "page" ? 1 : 2);
  usable.sort((a, b) => srcRank(a.source) - srcRank(b.source) || b.msLeft - a.msLeft);
  return usable[0];
}

/**
 * Human-readable label for a token source, for the UI's token-free auth line:
 * 'live' → "live session" (the app's own auto-rotating token), 'page' →
 * "page session", anything else → "options token".
 */
export function sourceLabel(source) {
  return source === "live" ? "live session" : source === "page" ? "page session" : "options token";
}

/**
 * Bucket an error message: 'expired' | 'scope' | 'network' | 'unknown'.
 * Heuristic string matching over wasm-client/DuckDB/HTTP error text — checked
 * in order (auth beats scope beats network) and DEFAULTS to 'unknown', so the
 * arranger's own pipeline errors ("read-back does not match…", LayoutError
 * text) are never misdrawn as auth problems. The numeric codes use word
 * boundaries so a 401/403 inside a longer number can't match.
 */
export function classifyAuthError(message) {
  const s = String(message ?? "");
  if (/expired|jwt|unauthor|invalid token|\b401\b/i.test(s)) return "expired";
  if (/read[- ]?only|permission|forbidden|not allowed|\b403\b|\bwrite\b/i.test(s)) return "scope";
  if (/network|fetch|connect|timed? ?out|offline/i.test(s)) return "network";
  return "unknown";
}

const AUTH_MESSAGES = {
  expired:
    "Your MotherDuck session token expired — refresh the MotherDuck tab, then click Arrange again.",
  scope:
    "This token is read-only; saving a layout needs a read/write token (set one in the extension Options).",
  network: "Couldn't reach MotherDuck — check your connection and retry.",
  unknown:
    "MotherDuck rejected the request — refresh the MotherDuck tab and try again, or set a fresh token in the extension Options.",
};

/** Short, actionable user-facing string for a classifyAuthError kind. */
export function authMessage(kind) {
  return AUTH_MESSAGES[kind] ?? AUTH_MESSAGES.unknown;
}

/**
 * "3:47pm"-style local wall-clock rendering of an expiry (ms since epoch),
 * or "no expiry" for null/undefined/non-finite. Dependency-free on purpose.
 */
export function fmtExpiry(exp) {
  if (exp == null || !Number.isFinite(exp)) return "no expiry";
  const d = new Date(exp);
  const h12 = d.getHours() % 12 || 12;
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${h12}:${mm}${d.getHours() >= 12 ? "pm" : "am"}`;
}
