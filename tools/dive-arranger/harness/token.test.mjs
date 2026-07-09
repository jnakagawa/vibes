// Pure tests for the token resolver (extension/token.mjs): JWT decoding,
// expiry-aware token selection, auth-error classification, and the
// user-facing strings. No DOM, no chrome.*, no Date.now() — every function
// takes time as a parameter, so these tests are fully deterministic.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeJwt,
  isMdJwt,
  extractMdJwt,
  tokenInfo,
  resolveToken,
  sourceLabel,
  classifyAuthError,
  authMessage,
  fmtExpiry,
  SKEW_MS,
} from "../extension/token.mjs";

// ── fixtures ──────────────────────────────────────────────────────────

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const makeJwt = (payload) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.sig`;

const NOW = 1_750_000_000_000; // fixed "now" in ms
const secs = (ms) => Math.floor(ms / 1000);

// ── decodeJwt ─────────────────────────────────────────────────────────

test("decodeJwt: decodes the payload of a well-formed JWT", () => {
  const p = decodeJwt(makeJwt({ mdRegion: "us-east-1", exp: 1234 }));
  assert.equal(p.mdRegion, "us-east-1");
  assert.equal(p.exp, 1234);
});

test("decodeJwt: garbage and non-string input → null, never throws", () => {
  assert.equal(decodeJwt("not a jwt"), null);
  assert.equal(decodeJwt("eyJhbGc"), null); // one segment
  assert.equal(decodeJwt("eyJhbGc.!!!.sig"), null); // invalid base64url chars
  assert.equal(decodeJwt(`${b64url({ a: 1 })}.${Buffer.from("not json").toString("base64url")}.sig`), null);
  assert.equal(decodeJwt(null), null);
  assert.equal(decodeJwt(undefined), null);
  assert.equal(decodeJwt(12345), null);
  assert.equal(decodeJwt(""), null);
});

// ── isMdJwt ───────────────────────────────────────────────────────────

test("isMdJwt: matches the mdRegion/tokenType/tokenId heuristic", () => {
  assert.equal(isMdJwt({ mdRegion: "us-east-1" }), true);
  assert.equal(isMdJwt({ tokenType: "read_write" }), true);
  assert.equal(isMdJwt({ tokenId: "abc" }), true);
  assert.equal(isMdJwt({ sub: "someone", iss: "other-idp" }), false);
  assert.equal(isMdJwt(null), false);
  assert.equal(isMdJwt({}), false);
});

// ── extractMdJwt ──────────────────────────────────────────────────────

test("extractMdJwt: finds an MD JWT inside a Bearer authorization header", () => {
  const jwt = makeJwt({ mdRegion: "us-east-1", exp: 1234 });
  assert.equal(extractMdJwt(`Bearer ${jwt}`), jwt);
});

test("extractMdJwt: finds an MD JWT inside a JSON response body", () => {
  const jwt = makeJwt({ tokenId: "abc", exp: 1234 });
  const body = JSON.stringify({ ok: true, access_token: jwt, ttl: 3600 });
  assert.equal(extractMdJwt(body), jwt);
});

test("extractMdJwt: finds an MD JWT in a WebSocket connect URL query param", () => {
  const jwt = makeJwt({ tokenType: "read_write" });
  assert.equal(extractMdJwt(`wss://flight.motherduck.com/?database=x&token=${jwt}&v=2`), jwt);
});

test("extractMdJwt: returns null for garbage / non-JWT strings", () => {
  assert.equal(extractMdJwt("no token here"), null);
  assert.equal(extractMdJwt("Bearer eyJhbGc"), null); // truncated, one segment
  assert.equal(extractMdJwt(""), null);
  assert.equal(extractMdJwt(null), null);
  assert.equal(extractMdJwt(undefined), null);
  assert.equal(extractMdJwt(12345), null);
});

test("extractMdJwt: ignores non-MD JWTs (Auth0/other-IdP tokens)", () => {
  const auth0 = makeJwt({ sub: "user|123", iss: "auth0", aud: "md-app" });
  assert.equal(extractMdJwt(`Bearer ${auth0}`), null);
});

test("extractMdJwt: skips a leading non-MD JWT and returns the MD one", () => {
  const auth0 = makeJwt({ sub: "user|123", iss: "auth0" });
  const md = makeJwt({ mdRegion: "eu-west-1", exp: 9999 });
  // Both present in one blob (e.g. a token-exchange response) — MD one wins.
  const body = JSON.stringify({ id_token: auth0, md_token: md });
  assert.equal(extractMdJwt(body), md);
});

// ── tokenInfo ─────────────────────────────────────────────────────────

test("tokenInfo: JWT exp is seconds — parsed to ms; healthy token not expired", () => {
  const expMs = NOW + 60 * 60 * 1000; // one hour left
  const info = tokenInfo(makeJwt({ mdRegion: "r", exp: secs(expMs) }), NOW);
  assert.equal(info.exp, secs(expMs) * 1000);
  assert.equal(info.expired, false);
  assert.equal(info.msLeft, secs(expMs) * 1000 - NOW);
});

test("tokenInfo: past exp → expired, negative msLeft", () => {
  const info = tokenInfo(makeJwt({ tokenId: "t", exp: secs(NOW - 10_000) }), NOW);
  assert.equal(info.expired, true);
  assert.ok(info.msLeft < 0);
});

test("tokenInfo: near-expiry within SKEW is treated as expired (never select a near-dead token)", () => {
  const justInside = tokenInfo(makeJwt({ tokenId: "t", exp: secs(NOW + SKEW_MS - 1000) }), NOW);
  assert.equal(justInside.expired, true);
  const atBoundary = tokenInfo(makeJwt({ tokenId: "t", exp: secs(NOW + SKEW_MS) }), NOW);
  assert.equal(atBoundary.expired, false); // msLeft === SKEW_MS is still usable
});

test("tokenInfo: no exp claim ⇒ non-expiring (exp null, msLeft Infinity)", () => {
  const info = tokenInfo(makeJwt({ mdRegion: "r", tokenType: "read_write" }), NOW);
  assert.equal(info.exp, null);
  assert.equal(info.msLeft, Infinity);
  assert.equal(info.expired, false);
});

test("tokenInfo: non-numeric exp claim is ignored (treated as non-expiring)", () => {
  const info = tokenInfo(makeJwt({ mdRegion: "r", exp: "soon" }), NOW);
  assert.equal(info.exp, null);
  assert.equal(info.msLeft, Infinity);
});

test("tokenInfo: non-MD JWTs and garbage → null", () => {
  assert.equal(tokenInfo(makeJwt({ sub: "someone-else" }), NOW), null);
  assert.equal(tokenInfo("garbage", NOW), null);
  assert.equal(tokenInfo(null, NOW), null);
});

test("tokenInfo: carries the source tag through when given", () => {
  const info = tokenInfo(makeJwt({ tokenId: "t" }), NOW, "page");
  assert.equal(info.source, "page");
});

// ── resolveToken ──────────────────────────────────────────────────────

const cand = (payload, source) => ({ token: makeJwt(payload), source });

test("resolveToken: drops expired candidates and falls through to the next valid one", () => {
  const expired = cand({ tokenId: "old", exp: secs(NOW - 1000) }, "page");
  const valid = cand({ tokenId: "fb", exp: secs(NOW + 3_600_000) }, "fallback");
  const best = resolveToken([expired, valid], NOW);
  assert.equal(best.source, "fallback");
  assert.equal(best.token, valid.token);
  assert.equal(best.expired, false);
});

test("resolveToken: prefers page over fallback even when the fallback lives longer", () => {
  const page = cand({ tokenId: "p", exp: secs(NOW + 10 * 60_000) }, "page");
  const fallback = cand({ tokenId: "f", exp: secs(NOW + 100 * 60_000) }, "fallback");
  const best = resolveToken([fallback, page], NOW);
  assert.equal(best.source, "page");
  assert.equal(best.token, page.token);
});

test("resolveToken: within a source, picks max msLeft (a no-exp token beats short-lived)", () => {
  const shortLived = cand({ tokenId: "s", exp: secs(NOW + 5 * 60_000) }, "page");
  const longLived = cand({ tokenId: "l", exp: secs(NOW + 50 * 60_000) }, "page");
  const forever = cand({ tokenId: "inf" }, "page");
  assert.equal(resolveToken([shortLived, longLived], NOW).token, longLived.token);
  assert.equal(resolveToken([shortLived, forever, longLived], NOW).token, forever.token);
});

test("resolveToken: null when empty, all expired, or nothing MD-shaped", () => {
  assert.equal(resolveToken([], NOW), null);
  assert.equal(resolveToken(null, NOW), null);
  assert.equal(resolveToken([cand({ tokenId: "x", exp: secs(NOW - 1) }, "page")], NOW), null);
  assert.equal(
    resolveToken([{ token: "garbage", source: "page" }, cand({ sub: "not-md" }, "fallback")], NOW),
    null,
  );
});

test("resolveToken: near-expiry (within SKEW) candidates are dropped like expired ones", () => {
  const nearDead = cand({ tokenId: "nd", exp: secs(NOW + SKEW_MS - 1000) }, "page");
  const healthy = cand({ tokenId: "ok", exp: secs(NOW + 3_600_000) }, "fallback");
  assert.equal(resolveToken([nearDead], NOW), null);
  assert.equal(resolveToken([nearDead, healthy], NOW).source, "fallback");
});

test("resolveToken: tolerates malformed candidate entries", () => {
  const good = cand({ tokenId: "g", exp: secs(NOW + 3_600_000) }, "page");
  const best = resolveToken([{}, { source: "page" }, null, good], NOW);
  assert.equal(best.token, good.token);
});

test("resolveToken: live beats an equally-fresh page token (live is preferred)", () => {
  const expMs = secs(NOW + 30 * 60_000);
  const live = cand({ tokenId: "L", exp: expMs }, "live");
  const page = cand({ tokenId: "P", exp: expMs }, "page");
  const best = resolveToken([page, live], NOW);
  assert.equal(best.source, "live");
  assert.equal(best.token, live.token);
});

test("resolveToken: live beats page even when page lives longer (source ranks first)", () => {
  const live = cand({ tokenId: "L", exp: secs(NOW + 6 * 60_000) }, "live");
  const page = cand({ tokenId: "P", exp: secs(NOW + 60 * 60_000) }, "page");
  assert.equal(resolveToken([page, live], NOW).source, "live");
});

test("resolveToken: an expired live token is dropped for a valid page/fallback token", () => {
  const deadLive = cand({ tokenId: "L", exp: secs(NOW - 1000) }, "live");
  const page = cand({ tokenId: "P", exp: secs(NOW + 30 * 60_000) }, "page");
  const fallback = cand({ tokenId: "F", exp: secs(NOW + 90 * 60_000) }, "fallback");
  const best = resolveToken([deadLive, page, fallback], NOW);
  assert.equal(best.source, "page"); // page still ranks above fallback
  assert.equal(best.token, page.token);
  // with only the dead live + fallback, fallback wins
  assert.equal(resolveToken([deadLive, fallback], NOW).source, "fallback");
});

// ── sourceLabel ───────────────────────────────────────────────────────

test("sourceLabel: distinct, token-free labels for each source", () => {
  assert.equal(sourceLabel("live"), "live session");
  assert.equal(sourceLabel("page"), "page session");
  assert.equal(sourceLabel("fallback"), "options token");
  assert.equal(sourceLabel(undefined), "options token"); // anything unknown → options
});

// ── classifyAuthError ─────────────────────────────────────────────────

test("classifyAuthError: expired/auth bucket", () => {
  for (const msg of [
    "token expired",
    "JWT is expired",
    "Invalid JWT",
    "Unauthorized",
    "unauthorized: signature verification failed",
    "invalid token supplied",
    "HTTP 401",
  ]) {
    assert.equal(classifyAuthError(msg), "expired", msg);
  }
});

test("classifyAuthError: scope bucket", () => {
  for (const msg of [
    "database is read-only",
    "read only token cannot run DDL",
    "permission denied",
    "Forbidden",
    "operation not allowed",
    "HTTP 403",
    "requires write access",
  ]) {
    assert.equal(classifyAuthError(msg), "scope", msg);
  }
});

test("classifyAuthError: network bucket", () => {
  for (const msg of [
    "network error",
    "Failed to fetch",
    "could not connect to server",
    "MotherDuck query timed out (120s)",
    "request timeout",
    "you appear to be offline",
  ]) {
    assert.equal(classifyAuthError(msg), "network", msg);
  }
});

test("classifyAuthError: auth wins over scope when both match (401 Forbidden)", () => {
  assert.equal(classifyAuthError("401 Forbidden"), "expired");
});

test("classifyAuthError: DEFAULTS to unknown — incl. the arranger's own errors", () => {
  for (const msg of [
    "",
    null,
    undefined,
    "something exploded",
    // our own pipeline errors must never be misclassified as auth:
    "read-back does not match what was written — check the dive in MotherDuck",
    "row spans must sum to ≤ 12",
    "MD_GET_DIVE returned no content",
    "no MotherDuck token provided",
  ]) {
    assert.equal(classifyAuthError(msg), "unknown", String(msg));
  }
});

// ── authMessage ───────────────────────────────────────────────────────

test("authMessage: every kind gets a distinct, actionable, token-free string", () => {
  const kinds = ["expired", "scope", "network", "unknown"];
  const msgs = kinds.map(authMessage);
  assert.equal(new Set(msgs).size, kinds.length); // all distinct
  for (const m of msgs) {
    assert.ok(typeof m === "string" && m.length > 20, m);
    assert.ok(!m.includes("eyJ"), "must never embed a token");
  }
  assert.match(authMessage("expired"), /refresh/i);
  assert.match(authMessage("scope"), /read\/write|read.write/i);
  assert.match(authMessage("network"), /connection|retry/i);
});

test("authMessage: unrecognized kind falls back to the unknown message", () => {
  assert.equal(authMessage("bogus"), authMessage("unknown"));
  assert.equal(authMessage(undefined), authMessage("unknown"));
});

// ── fmtExpiry ─────────────────────────────────────────────────────────

test("fmtExpiry: local-time h:mm(am|pm), no-expiry for null", () => {
  // Build instants from LOCAL wall-clock parts so the expected strings hold
  // in any timezone the test runs in.
  assert.equal(fmtExpiry(new Date(2026, 6, 8, 15, 47).getTime()), "3:47pm");
  assert.equal(fmtExpiry(new Date(2026, 6, 8, 9, 5).getTime()), "9:05am");
  assert.equal(fmtExpiry(new Date(2026, 6, 8, 0, 30).getTime()), "12:30am");
  assert.equal(fmtExpiry(new Date(2026, 6, 8, 12, 0).getTime()), "12:00pm");
  assert.equal(fmtExpiry(null), "no expiry");
  assert.equal(fmtExpiry(undefined), "no expiry");
});

// ── SKEW_MS ───────────────────────────────────────────────────────────

test("SKEW_MS: a sane safety margin (30s–2min)", () => {
  assert.ok(Number.isFinite(SKEW_MS) && SKEW_MS >= 30_000 && SKEW_MS <= 120_000);
});
