// dive-arranger harness sample #2 — THROWAWAY fixture, tests only.
// Resembles the Zero Build Chat dive's layout: top-level SOURCE grid rows
// (`grid grid-cols-2`) holding side-by-side chart tiles, one row using an
// empty <div /> spacer column to right-align a single tile, and a pinned
// conditional between rows. The helpers/comments must survive byte-exactly.
const fmtCount = (n) => n.toLocaleString(); // helper (must survive)

export default function ChatEventsDive() {
  const data = { days: [1, 2, 3] };
  const loading = data.days.length === 0; // derived flag (must survive)
  return (
    <div style={{ padding: 24, fontFamily: "sans-serif" }}>
      <div id="header">
        <h1>Zero Build Chat</h1>
        <p>Daily chat events: {fmtCount(1234)}</p>
      </div>
      <div className="grid grid-cols-2 gap-8 mb-8">
        <div id="activity">
          <h2>Activity</h2>
          {/* activity chart body (must survive) */}
          <p>Chat events per day</p>
        </div>
        <div id="errors">
          <h2>Errors</h2>
          <p>Error rate by model</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-8 mb-8">
        <div />
        <div id="funnel">
          <h2>Session funnel</h2>
          <p>Prompt to completion</p>
        </div>
      </div>
      {loading ? <div>loading…</div> : null}
      <div className="grid grid-cols-2 gap-8">
        <div id="modelmix">
          <h2>Model mix</h2>
          <p>Requests by model</p>
        </div>
        <div id="latency">
          <h2>Latency</h2>
          <p>p50 / p95 per day</p>
        </div>
      </div>
    </div>
  );
}
