// Live control + clock for the ring (browser only).
//
// Live: the host publishes the performance state to a public ntfy.sh topic;
// phones subscribe over server-sent events and follow the newest `rev`.
// ntfy keeps recent messages, so a phone that joins late gets the current
// state immediately. If the relay is unreachable, phones keep playing from
// the state in their link — the piece is computed locally either way.
//
// Clock: every phone computes the piece from its own clock, so clocks must
// agree. Phones are NTP-synced and usually within a few tens of ms; this
// checks against the web server's Date header (1 s resolution, narrowed by
// sampling across second boundaries) and only corrects a clock that is
// clearly off.
(function (root) {
  'use strict';

  const RELAY = 'https://ntfy.sh';

  function newTopic() {
    const a = 'abcdefghijkmnpqrstuvwxyz23456789';
    let s = '';
    const r = crypto.getRandomValues(new Uint8Array(10));
    for (const b of r) s += a[b % a.length];
    return `nfring-${s}`;
  }

  class Live {
    constructor(topic, { onState, onJoin, onStatus } = {}) {
      this.topic = topic;
      this.onState = onState || (() => {});
      this.onJoin = onJoin || (() => {});
      this.onStatus = onStatus || (() => {});
      this.rev = -1;
      this.es = null;
    }
    connect() {
      if (this.es) this.es.close();
      this.onStatus('connecting');
      // since=all: replay what the relay still holds (the newest state wins)
      const es = new EventSource(`${RELAY}/${encodeURIComponent(this.topic)}/sse?since=all`);
      this.es = es;
      es.onopen = () => this.onStatus('live');
      es.onerror = () => this.onStatus(es.readyState === EventSource.CLOSED ? 'offline' : 'reconnecting');
      es.onmessage = e => {
        let m;
        try { m = JSON.parse(e.data); } catch (_) { return; }
        if (m.event !== 'message' || !m.message) return;
        let body;
        try { body = JSON.parse(m.message); } catch (_) { return; }
        if (body.k === 'state' && body.state && body.state.rev > this.rev) {
          this.rev = body.state.rev;
          this.onState(body.state);
        } else if (body.k === 'join') {
          this.onJoin(body, m.time * 1000);
        }
      };
    }
    async publish(obj) {
      const r = await fetch(`${RELAY}/${encodeURIComponent(this.topic)}`, {
        method: 'POST', body: JSON.stringify(obj),
      });
      if (!r.ok) throw new Error(`relay ${r.status}`);
    }
    close() { if (this.es) this.es.close(); }
  }

  // Bounds on (server - local) from Date headers: each response's second D was
  // current at some local instant between send and receive.
  async function syncClock(samples = 12) {
    const url = location.href.split('#')[0].split('?')[0];
    let lo = -Infinity, hi = Infinity, n = 0;
    for (let i = 0; i < samples; i++) {
      try {
        const t0 = Date.now();
        const r = await fetch(`${url}?clock=${Math.random().toString(36).slice(2)}`, { method: 'HEAD', cache: 'no-store' });
        const t1 = Date.now();
        const d = Date.parse(r.headers.get('date'));
        if (!isNaN(d)) { lo = Math.max(lo, d - t1); hi = Math.min(hi, d + 1000 - t0); n++; }
      } catch (_) { /* offline: keep the local clock */ }
      await new Promise(res => setTimeout(res, 90 + Math.random() * 80));
    }
    if (!n || lo > hi) return { offset: 0, err: null };
    // a clock that already fits the bounds is left alone (it is NTP-synced and
    // better than this estimate); one that doesn't is moved to the middle
    if (lo <= 0 && hi >= 0) return { offset: 0, err: (hi - lo) / 2 };
    return { offset: Math.round((lo + hi) / 2), err: (hi - lo) / 2 };
  }

  root.NearfieldLive = { RELAY, newTopic, Live, syncClock };
})(typeof globalThis !== 'undefined' ? globalThis : this);
