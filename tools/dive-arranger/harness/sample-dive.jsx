// dive-arranger harness sample — THROWAWAY dive, safe to delete.
// This comment, the helpers, and the hook logic below must survive a
// round-trip byte-for-byte (recast only reprints what moves).
const GREETING = "hello from the arranger harness"; // module-level helper (must survive)

const PALETTE = {
  bg: "#f8f8f8",
  text: "#231f20", // brand ink
};

function Badge({ label }) {
  return <span style={{ padding: 4, background: PALETTE.bg }}>{label}</span>;
}

export default function ArrangerSample() {
  const items = ["alpha-item", "beta-item", "gamma-item"];
  const showNote = items.length > 2; // derived flag (must survive)
  return (
    <div style={{ padding: 24, background: PALETTE.bg, color: PALETTE.text }}>
      <div id="alpha">
        <h2>Alpha</h2>
        <p>First block — a KPI strip stand-in.</p>
      </div>
      <div id="beta">
        <h2>Beta</h2>
        <Badge label={GREETING} />
      </div>
      {showNote ? <div id="note">Conditional note — pinned, never moves.</div> : null}
      <div id="gamma">
        <h2>Gamma</h2>
        <ul>{items.map((x) => <li key={x}>{x}</li>)}</ul>
      </div>
      <div id="delta">
        <h2>Delta</h2>
        {/* keep this inner comment */}
        <p>Last block.</p>
      </div>
    </div>
  );
}
