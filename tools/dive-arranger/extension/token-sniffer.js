// MAIN-world, document_start content script (injected via the manifest — NOT
// the on-demand <script> tag, which runs post-load and would miss the app's
// load-time token fetch). It runs in app.motherduck.com's OWN JS realm, BEFORE
// the app's scripts, and captures the app's live MotherDuck access token.
//
// Why this exists: the MotherDuck app authenticates via Auth0 httpOnly cookies
// and holds its DuckDB/MD access token IN MEMORY — there is no JWT in
// localStorage/sessionStorage/IndexedDB to scan. The app fetches that token
// once at page load and hands it to @motherduck/wasm-client. So the isolated
// content script's storage scan finds nothing usable on the current app. The
// only way to see the token is to intercept it at the transport layer as the
// app fetches (and periodically re-fetches) it.
//
// What it does: patches fetch / XMLHttpRequest / WebSocket, DEFENSIVELY and
// NON-BREAKINGLY (install-once guard, everything in try/catch, always delegate
// to the originals, never await on the hot path, never throw). When it spots a
// MotherDuck-shaped JWT it relays it to the extension's isolated content script
// over same-origin postMessage. The token stays in the browser; it is NEVER
// logged, persisted, thrown, or placed in any user-visible string.
import { extractMdJwt, decodeJwt } from "./token.mjs";

const RELAY_SOURCE = "dive-arranger-token";

// Install-once guard: the manifest injects this at document_start, but a stray
// second injection (or a re-registered content script) must not double-patch
// fetch/XHR/WebSocket (each patch would wrap the previous → duplicated work).
if (!window.__diveArrangerSnifferLoaded) {
  window.__diveArrangerSnifferLoaded = true;

  // Newest/longest-lived captured token wins. We compare by absolute expiry
  // (monotonic, no `now` needed): the app auto-refreshes, so a re-fetched
  // token carries a later `exp`. A non-expiring token (no exp claim) is best.
  let bestExp = -Infinity;
  let bestToken = null;

  // A header name we care about for token capture.
  const isAuthHeaderName = (name) => /^authorization$|^x-motherduck/i.test(String(name));

  // URLs that plausibly carry a token in their response/query — keeps response
  // body cloning and responseText reads off every unrelated request.
  const looksTokenish = (url) =>
    /token|auth|session|jwt|motherduck|login|refresh|flight|query/i.test(String(url || ""));

  // Relay a captured MD JWT to the isolated content script, keeping only the
  // longest-lived one seen. Same-origin only. The token is NEVER logged,
  // persisted, or thrown — it travels solely inside this postMessage payload.
  const relay = (token) => {
    try {
      if (!token || token === bestToken) return;
      let exp = Infinity;
      const p = decodeJwt(token);
      if (p && typeof p.exp === "number" && Number.isFinite(p.exp)) exp = p.exp * 1000;
      if (exp <= bestExp) return; // already hold an equal-or-longer-lived token
      bestExp = exp;
      bestToken = token;
      window.postMessage({ source: RELAY_SOURCE, token }, location.origin);
    } catch {
      /* never disturb the app over token relay */
    }
  };

  // Pull the first MD-shaped JWT out of an arbitrary string and relay it.
  const consider = (str) => {
    try {
      const token = extractMdJwt(str);
      if (token) relay(token);
    } catch {
      /* extraction is best-effort — never throw on the app's hot path */
    }
  };

  // Feed the Authorization / x-motherduck-* values from a header collection
  // (Headers instance, array of pairs, or plain object) into `consider`.
  const considerHeaders = (headers) => {
    try {
      if (!headers) return;
      if (typeof Headers !== "undefined" && headers instanceof Headers) {
        headers.forEach((value, name) => {
          if (isAuthHeaderName(name)) consider(String(value));
        });
      } else if (Array.isArray(headers)) {
        for (const pair of headers) {
          if (pair && isAuthHeaderName(pair[0])) consider(String(pair[1]));
        }
      } else if (typeof headers === "object") {
        for (const name of Object.keys(headers)) {
          if (isAuthHeaderName(name)) consider(String(headers[name]));
        }
      }
    } catch {
      /* header shape we don't recognize — ignore */
    }
  };

  const urlOf = (input) => {
    try {
      if (typeof input === "string") return input;
      if (input && typeof input === "object") return input.url || "";
    } catch {
      /* fall through */
    }
    return "";
  };

  // ── fetch ─────────────────────────────────────────────────────────────
  try {
    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = function (input, init) {
        // Request-header inspection (sync, cheap): Request object + init.headers.
        try {
          if (input && typeof input === "object") considerHeaders(input.headers);
          if (init) considerHeaders(init.headers);
        } catch {
          /* never block the request */
        }
        const promise = origFetch.apply(this, arguments);
        // Response-body inspection: fire-and-forget on a CLONE so we never touch
        // the app's own body stream and add ZERO latency to the hot path.
        try {
          if (promise && typeof promise.then === "function") {
            promise.then(
              (res) => {
                try {
                  if (res && looksTokenish(res.url || urlOf(input))) {
                    res
                      .clone()
                      .text()
                      .then(
                        (body) => consider(body),
                        () => {},
                      );
                  }
                } catch {
                  /* clone/read failed — irrelevant to the app */
                }
              },
              () => {},
            );
          }
        } catch {
          /* observation-only; never affect the returned promise */
        }
        return promise;
      };
    }
  } catch {
    /* leave fetch untouched if patching fails */
  }

  // ── XMLHttpRequest ─────────────────────────────────────────────────────
  try {
    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const origOpen = XHR.prototype.open;
      const origSetHeader = XHR.prototype.setRequestHeader;
      const origSend = XHR.prototype.send;

      XHR.prototype.open = function (method, url) {
        try {
          this.__diveArrangerUrl = url;
        } catch {
          /* frozen instance — ignore */
        }
        return origOpen.apply(this, arguments);
      };

      XHR.prototype.setRequestHeader = function (name, value) {
        try {
          if (isAuthHeaderName(name)) consider(String(value));
        } catch {
          /* observation-only */
        }
        return origSetHeader.apply(this, arguments);
      };

      XHR.prototype.send = function () {
        try {
          if (looksTokenish(this.__diveArrangerUrl)) {
            this.addEventListener("load", () => {
              try {
                // responseText throws for non-text responseTypes — guard it.
                if (this.responseType === "" || this.responseType === "text") {
                  consider(this.responseText);
                }
              } catch {
                /* not a text body — ignore */
              }
            });
          }
        } catch {
          /* never block the send */
        }
        return origSend.apply(this, arguments);
      };
    }
  } catch {
    /* leave XHR untouched if patching fails */
  }

  // ── WebSocket ──────────────────────────────────────────────────────────
  // MD flight/query sockets sometimes carry the token in the connect URL.
  try {
    const OrigWebSocket = window.WebSocket;
    if (typeof OrigWebSocket === "function") {
      class DiveArrangerWebSocket extends OrigWebSocket {
        constructor(...args) {
          // Inspect the URL BEFORE super() — safe (no `this` access yet).
          try {
            consider(String(args[0]));
          } catch {
            /* observation-only */
          }
          super(...args);
        }
      }
      window.WebSocket = DiveArrangerWebSocket;
    }
  } catch {
    /* leave WebSocket untouched if patching fails */
  }
}
