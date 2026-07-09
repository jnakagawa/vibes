(() => {
  // extension/token.mjs
  function decodeJwt(token) {
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
  function isMdJwt(payload) {
    return Boolean(payload && (payload.mdRegion || payload.tokenType || payload.tokenId));
  }
  function extractMdJwt(str) {
    if (typeof str !== "string" || !str.includes("eyJ")) return null;
    const matches = str.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g);
    if (!matches) return null;
    for (const candidate of matches) {
      if (isMdJwt(decodeJwt(candidate))) return candidate;
    }
    return null;
  }

  // extension/token-sniffer.js
  var RELAY_SOURCE = "dive-arranger-token";
  if (!window.__diveArrangerSnifferLoaded) {
    window.__diveArrangerSnifferLoaded = true;
    let bestExp = -Infinity;
    let bestToken = null;
    const isAuthHeaderName = (name) => /^authorization$|^x-motherduck/i.test(String(name));
    const looksTokenish = (url) => /token|auth|session|jwt|motherduck|login|refresh|flight|query/i.test(String(url || ""));
    const relay = (token) => {
      try {
        if (!token || token === bestToken) return;
        let exp = Infinity;
        const p = decodeJwt(token);
        if (p && typeof p.exp === "number" && Number.isFinite(p.exp)) exp = p.exp * 1e3;
        if (exp <= bestExp) return;
        bestExp = exp;
        bestToken = token;
        window.postMessage({ source: RELAY_SOURCE, token }, location.origin);
      } catch {
      }
    };
    const consider = (str) => {
      try {
        const token = extractMdJwt(str);
        if (token) relay(token);
      } catch {
      }
    };
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
      }
    };
    const urlOf = (input) => {
      try {
        if (typeof input === "string") return input;
        if (input && typeof input === "object") return input.url || "";
      } catch {
      }
      return "";
    };
    try {
      const origFetch = window.fetch;
      if (typeof origFetch === "function") {
        window.fetch = function(input, init) {
          try {
            if (input && typeof input === "object") considerHeaders(input.headers);
            if (init) considerHeaders(init.headers);
          } catch {
          }
          const promise = origFetch.apply(this, arguments);
          try {
            if (promise && typeof promise.then === "function") {
              promise.then(
                (res) => {
                  try {
                    if (res && looksTokenish(res.url || urlOf(input))) {
                      res.clone().text().then(
                        (body) => consider(body),
                        () => {
                        }
                      );
                    }
                  } catch {
                  }
                },
                () => {
                }
              );
            }
          } catch {
          }
          return promise;
        };
      }
    } catch {
    }
    try {
      const XHR = window.XMLHttpRequest;
      if (XHR && XHR.prototype) {
        const origOpen = XHR.prototype.open;
        const origSetHeader = XHR.prototype.setRequestHeader;
        const origSend = XHR.prototype.send;
        XHR.prototype.open = function(method, url) {
          try {
            this.__diveArrangerUrl = url;
          } catch {
          }
          return origOpen.apply(this, arguments);
        };
        XHR.prototype.setRequestHeader = function(name, value) {
          try {
            if (isAuthHeaderName(name)) consider(String(value));
          } catch {
          }
          return origSetHeader.apply(this, arguments);
        };
        XHR.prototype.send = function() {
          try {
            if (looksTokenish(this.__diveArrangerUrl)) {
              this.addEventListener("load", () => {
                try {
                  if (this.responseType === "" || this.responseType === "text") {
                    consider(this.responseText);
                  }
                } catch {
                }
              });
            }
          } catch {
          }
          return origSend.apply(this, arguments);
        };
      }
    } catch {
    }
    try {
      const OrigWebSocket = window.WebSocket;
      if (typeof OrigWebSocket === "function") {
        class DiveArrangerWebSocket extends OrigWebSocket {
          constructor(...args) {
            try {
              consider(String(args[0]));
            } catch {
            }
            super(...args);
          }
        }
        window.WebSocket = DiveArrangerWebSocket;
      }
    } catch {
    }
  }
})();
