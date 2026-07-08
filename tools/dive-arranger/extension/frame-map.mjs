// Pure alignment of model rows ↔ rendered container children. No DOM here —
// frame.js turns the container's element children into abstract descriptors
// and this module decides which child(ren) each model row rendered to.
// Node-testable (harness/frame-logic.test.mjs).
//
// Inputs:
//   rows   — the discovery/layout model rows: [{ cells: [{block, span, heightPx}] }]
//   kinds  — Map<blockId, "static"|"dynamic">
//   children — one descriptor per container ELEMENT child, in DOM order:
//     { wrapper: boolean,           // has data-dive-arranger="row"
//       cellCount: number,          // wrapper only: # of data-dive-arranger="cell" children
//       anchors: Set<blockId> }     // static blocks whose anchor text this child (alone) contains
//
// Output: array over rows — { rowIdx, childIdxs: number[], via } — or null when
// no consistent alignment exists (caller falls back to the top-frame overlay).
//   - wrapper row  → childIdxs = [the wrapper child]        (via "wrapper")
//   - bare static  → childIdxs = [one child]                (via "anchor" | "position")
//     …or [] when the row sits between two pinned dynamics and can't be told
//     apart from their output (via "inert": tile gets no drag affordance).
//   - dynamic      → childIdxs = 0..n children              (via "dynamic")

export function alignRowsToChildren(rows, kinds, children) {
  const kindOf = (id) => (kinds instanceof Map ? kinds.get(id) : kinds[id]);

  const slots = rows.map((row, i) => {
    const solo = row.cells.length === 1;
    const c0 = row.cells[0];
    const dynamic = solo && kindOf(c0.block) === "dynamic";
    // Mirrors apply.mjs's `bare` rule: solo, full-width, no fixed height →
    // rendered without a wrapper. Dynamics are ALWAYS rendered bare.
    const bare = solo && (c0.span == null || c0.span >= 12) && c0.heightPx == null;
    return {
      rowIdx: i,
      dynamic,
      wrapped: !dynamic && !bare,
      cellCount: row.cells.length,
      blockIds: row.cells.map((c) => c.block),
    };
  });

  // ── Phase A: wrapper children ↔ wrapped slots, strictly 1:1 in order ──
  const wrappedSlots = slots.filter((s) => s.wrapped);
  const wrapperChildren = children.flatMap((c, i) => (c.wrapper ? [i] : []));
  if (wrappedSlots.length !== wrapperChildren.length) return null;
  let fixed = wrappedSlots.map((s, k) => ({ slot: s.rowIdx, child: wrapperChildren[k], via: "wrapper" }));
  for (const f of fixed) {
    if ((children[f.child].cellCount ?? 0) !== slots[f.slot].cellCount) return null;
  }

  // ── Phase B: anchor texts pin bare static slots to specific children ──
  const anchorFixed = [];
  const claimedChildren = new Set(fixed.map((f) => f.child));
  for (const s of slots) {
    if (s.wrapped || s.dynamic) continue;
    const bid = s.blockIds[0];
    const matches = children.flatMap((c, i) =>
      !c.wrapper && !claimedChildren.has(i) && c.anchors?.has(bid) ? [i] : [],
    );
    if (matches.length === 1) anchorFixed.push({ slot: s.rowIdx, child: matches[0], via: "anchor" });
  }
  // Two slots anchoring the same child → both anchors are unreliable; drop them.
  const childUses = new Map();
  for (const f of anchorFixed) childUses.set(f.child, (childUses.get(f.child) || 0) + 1);
  fixed = fixed.concat(anchorFixed.filter((f) => childUses.get(f.child) === 1));

  // ── Phase C: fixed points must be order-consistent ──
  const consistent = (list) => {
    const sorted = [...list].sort((a, z) => a.slot - z.slot);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].child <= sorted[i - 1].child) return null;
    }
    return sorted;
  };
  let pins = consistent(fixed);
  if (!pins) {
    // Anchors misfired (repeated text etc.) — retry with the wrappers only.
    pins = consistent(fixed.filter((f) => f.via === "wrapper"));
    if (!pins) return null;
  }

  // ── Phase D: fill the gaps between consecutive fixed points ──
  const result = slots.map((s) => ({ rowIdx: s.rowIdx, childIdxs: [], via: "none" }));
  for (const f of pins) result[f.slot] = { rowIdx: f.slot, childIdxs: [f.child], via: f.via };

  const bounds = [{ slot: -1, child: -1 }, ...pins, { slot: slots.length, child: children.length }];
  for (let k = 0; k < bounds.length - 1; k++) {
    const lo = bounds[k];
    const hi = bounds[k + 1];
    const segSlots = [];
    for (let i = lo.slot + 1; i < hi.slot; i++) segSlots.push(i);
    const segChildren = [];
    for (let j = lo.child + 1; j < hi.child; j++) segChildren.push(j);
    if (segSlots.length === 0) {
      if (segChildren.length > 0) return null; // rendered output nobody owns
      continue;
    }

    const dynPositions = segSlots.filter((i) => slots[i].dynamic);
    if (dynPositions.length === 0) {
      // Statics only: counts must match exactly → positional 1:1.
      if (segSlots.length !== segChildren.length) return null;
      segSlots.forEach((slotIdx, k2) => {
        result[slotIdx] = { rowIdx: slotIdx, childIdxs: [segChildren[k2]], via: "position" };
      });
      continue;
    }

    // Dynamics render 0..n children each. Statics BEFORE the first dynamic and
    // AFTER the last one are unambiguous (one child each, from the edges);
    // everything in between goes to the first dynamic slot as one region.
    const firstDyn = segSlots.indexOf(dynPositions[0]);
    const lastDyn = segSlots.indexOf(dynPositions[dynPositions.length - 1]);
    const leading = segSlots.slice(0, firstDyn);
    const trailing = segSlots.slice(lastDyn + 1);
    if (segChildren.length < leading.length + trailing.length) return null;

    leading.forEach((slotIdx, k2) => {
      result[slotIdx] = { rowIdx: slotIdx, childIdxs: [segChildren[k2]], via: "position" };
    });
    trailing.forEach((slotIdx, k2) => {
      const j = segChildren[segChildren.length - trailing.length + k2];
      result[slotIdx] = { rowIdx: slotIdx, childIdxs: [j], via: "position" };
    });

    const middle = segChildren.slice(leading.length, segChildren.length - trailing.length);
    const interior = segSlots.slice(firstDyn, lastDyn + 1);
    for (const slotIdx of interior) {
      result[slotIdx] = slots[slotIdx].dynamic
        ? { rowIdx: slotIdx, childIdxs: [], via: "dynamic" }
        : // A bare static sandwiched between pinned dynamics with no anchor:
          // we can't tell its DOM node from the dynamics' output. It stays in
          // the model (never moves) but gets no drag affordance.
          { rowIdx: slotIdx, childIdxs: [], via: "inert" };
    }
    // All middle children belong to the first dynamic: since everything in the
    // region is pinned and rendered full-width in DOM order, the visual result
    // is identical no matter how the children are split among the dynamics.
    result[interior[0]] = { rowIdx: interior[0], childIdxs: middle, via: "dynamic" };
  }

  // Dynamics outside any segment (adjacent to pins) got "none" — normalize.
  for (const r of result) {
    if (r.via === "none") {
      r.via = slots[r.rowIdx].dynamic ? "dynamic" : "inert";
    }
  }
  return result;
}
