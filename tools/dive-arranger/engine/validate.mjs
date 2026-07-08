// Layout validation — split out of apply.mjs so the in-iframe content script
// (dist/frame.js) can bundle the REAL validator without dragging recast/babel
// along. apply.mjs imports and re-exports everything here, so engine/index.mjs
// consumers are unaffected.
//
// Layout model (what the UIs produce):
//   { rows: [ { cells: [ { block: <id>, span?: 1..12, heightPx?: number } ] } ] }

export class LayoutError extends Error {}

export const GRID_COLS = 12;
export const GRID_GAP = 16;

export function validateLayout(blocks, layout) {
  if (!layout || !Array.isArray(layout.rows) || layout.rows.length === 0) {
    throw new LayoutError("layout must be { rows: [ { cells: [...] } ] } with at least one row");
  }
  const byId = new Map(blocks.map((blk) => [blk.id, blk]));
  const seen = new Set();
  const flat = [];

  for (const row of layout.rows) {
    if (!row || !Array.isArray(row.cells) || row.cells.length === 0) {
      throw new LayoutError("every layout row needs a non-empty cells array");
    }
    let spanSum = 0;
    for (const cell of row.cells) {
      const blk = byId.get(cell.block);
      if (!blk) throw new LayoutError(`layout references unknown block id ${JSON.stringify(cell.block)}`);
      if (seen.has(blk.id)) throw new LayoutError(`block ${blk.id} appears twice in the layout`);
      seen.add(blk.id);
      flat.push({ cell, blk });

      const span = cell.span == null ? Math.floor(GRID_COLS / row.cells.length) : cell.span;
      if (!Number.isInteger(span) || span < 1 || span > GRID_COLS) {
        throw new LayoutError(`block ${blk.id}: span must be an integer 1..${GRID_COLS}`);
      }
      cell.span = span;
      spanSum += span;

      if (cell.heightPx != null) {
        if (!Number.isFinite(cell.heightPx) || cell.heightPx < 40 || cell.heightPx > 4000) {
          throw new LayoutError(`block ${blk.id}: heightPx out of range`);
        }
        cell.heightPx = Math.round(cell.heightPx);
      }

      if (blk.kind === "dynamic") {
        if (row.cells.length !== 1) {
          throw new LayoutError(`block ${blk.id} is dynamic (pinned) and must stay alone in its own row`);
        }
        if (cell.heightPx != null || span !== GRID_COLS) {
          throw new LayoutError(`block ${blk.id} is dynamic (pinned) and cannot be resized`);
        }
      }
    }
    if (spanSum > GRID_COLS) {
      throw new LayoutError(`a row's spans sum to ${spanSum} > ${GRID_COLS}`);
    }
  }

  // A STATIC block may be absent from the layout — that is a delete (apply
  // drops its node from the output). A DYNAMIC block must always be present:
  // deleting conditional/loop output would change the dive's logic, so
  // dynamics stay pinned. (The segment rule below is unaffected by deleted
  // statics: segments are numbered by the dynamics, which all remain, in
  // order, so `newSeg` still advances in lockstep with `segmentOf`.)
  for (const blk of blocks) {
    if (!seen.has(blk.id) && blk.kind === "dynamic") {
      throw new LayoutError(
        `block ${blk.id} (${blk.label}) is dynamic (pinned) and missing from the layout — dynamic blocks cannot be deleted`,
      );
    }
  }

  // Segment rule: dynamic (pinned) blocks are immovable separators. Their
  // relative order must be unchanged, and no static block may cross one.
  const segmentOf = new Map();
  let seg = 0;
  for (const blk of blocks) {
    if (blk.kind === "dynamic") {
      segmentOf.set(blk.id, seg);
      seg += 1;
    } else {
      segmentOf.set(blk.id, seg);
    }
  }
  let newSeg = 0;
  for (const { blk } of flat) {
    if (blk.kind === "dynamic") {
      if (segmentOf.get(blk.id) !== newSeg) {
        throw new LayoutError(`dynamic block ${blk.id} moved — pinned blocks cannot be reordered`);
      }
      newSeg += 1;
    } else if (segmentOf.get(blk.id) !== newSeg) {
      throw new LayoutError(
        `block ${blk.id} (${blk.label}) crossed a pinned dynamic block — reordering across conditionals/loops is out of scope`,
      );
    }
  }

  return flat;
}
