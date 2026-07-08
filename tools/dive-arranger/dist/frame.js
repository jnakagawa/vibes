(() => {
  // engine/validate.mjs
  var LayoutError = class extends Error {
  };
  var GRID_COLS = 12;
  var GRID_GAP = 16;
  function validateLayout(blocks, layout) {
    if (!layout || !Array.isArray(layout.rows) || layout.rows.length === 0) {
      throw new LayoutError("layout must be { rows: [ { cells: [...] } ] } with at least one row");
    }
    const byId = new Map(blocks.map((blk) => [blk.id, blk]));
    const seen = /* @__PURE__ */ new Set();
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
          if (!Number.isFinite(cell.heightPx) || cell.heightPx < 40 || cell.heightPx > 4e3) {
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
    for (const blk of blocks) {
      if (!seen.has(blk.id) && blk.kind === "dynamic") {
        throw new LayoutError(
          `block ${blk.id} (${blk.label}) is dynamic (pinned) and missing from the layout \u2014 dynamic blocks cannot be deleted`
        );
      }
    }
    const segmentOf = /* @__PURE__ */ new Map();
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
          throw new LayoutError(`dynamic block ${blk.id} moved \u2014 pinned blocks cannot be reordered`);
        }
        newSeg += 1;
      } else if (segmentOf.get(blk.id) !== newSeg) {
        throw new LayoutError(
          `block ${blk.id} (${blk.label}) crossed a pinned dynamic block \u2014 reordering across conditionals/loops is out of scope`
        );
      }
    }
    return flat;
  }

  // engine/rowcontainer.mjs
  var tokens = (classAttr) => String(classAttr || "").trim().split(/\s+/).filter(Boolean);
  var baseToken = (t) => t.slice(t.lastIndexOf(":") + 1);
  function countGridTracks(template) {
    if (typeof template !== "string") return 0;
    const t = template.trim();
    if (!t || t === "none") return 0;
    const parts = [];
    let depth = 0;
    let cur = "";
    for (const ch of t) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
      if (/\s/.test(ch) && depth === 0) {
        if (cur) parts.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    if (cur) parts.push(cur);
    let n = 0;
    for (const p of parts) {
      const rep = p.match(/^repeat\((\d+)\s*,([\s\S]*)\)$/);
      if (rep) {
        const inner = countGridTracks(rep[2]);
        if (!inner) return 0;
        n += Number(rep[1]) * inner;
      } else if (/^repeat\(/.test(p)) {
        return 0;
      } else if (/^\[[\s\S]*\]$/.test(p)) {
      } else {
        n += 1;
      }
    }
    return n;
  }
  function classifyRowContainer({
    classAttr = "",
    display = null,
    gridTemplateColumns = null,
    flexDirection = null
  } = {}) {
    const toks = tokens(classAttr).map(baseToken);
    const has = (t) => toks.includes(t);
    const isGrid = display === "grid" || display === "inline-grid" || !display && (has("grid") || has("inline-grid"));
    if (isGrid) {
      let cols = countGridTracks(gridTemplateColumns);
      if (!cols) {
        for (const t of toks) {
          const m = t.match(/^grid-cols-(\d+)$/);
          if (m) cols = Math.max(cols, Number(m[1]));
        }
      }
      return cols >= 2 ? { kind: "grid", cols } : null;
    }
    const isFlex = display === "flex" || display === "inline-flex" || !display && (has("flex") || has("inline-flex"));
    if (isFlex) {
      const columnClass = toks.some((t) => t === "flex-col" || t === "flex-col-reverse");
      const dir = flexDirection || (columnClass ? "column" : "row");
      return /^column/.test(dir) ? null : { kind: "flex" };
    }
    return null;
  }

  // extension/layout-model.mjs
  var COLS = 12;
  var deepCopyModel = (m) => ({
    rows: m.rows.map((r) => ({ cells: r.cells.map((c) => ({ ...c })) }))
  });
  function fillRowSpans(cells) {
    if (cells.length === 0) return cells;
    const spans = cells.map((c) => c.span ?? COLS);
    const total = spans.reduce((a, x) => a + x, 0);
    if (total <= 0) {
      cells.forEach((c) => c.span = Math.floor(COLS / cells.length) || 1);
      return cells;
    }
    const out = spans.map((s) => Math.max(1, Math.round(s * COLS / total)));
    let diff = COLS - out.reduce((a, x) => a + x, 0);
    for (let i = 0; diff !== 0 && i < out.length * COLS; i++) {
      const j = i % out.length;
      if (diff > 0) {
        out[j] += 1;
        diff -= 1;
      } else if (out[j] > 1) {
        out[j] -= 1;
        diff += 1;
      }
    }
    cells.forEach((c, i) => c.span = out[i]);
    return cells;
  }
  function moveBlock(model, fromRow, fromCell, target) {
    const m = deepCopyModel(model);
    const src = m.rows[fromRow];
    const moved = src.cells.splice(fromCell, 1)[0];
    const leftSourceRow = target.kind === "gap" || target.rowIdx !== fromRow;
    if (target.kind === "cell") {
      let { rowIdx, cellIdx } = target;
      if (rowIdx === fromRow && cellIdx > fromCell) cellIdx -= 1;
      m.rows[rowIdx].cells.splice(cellIdx, 0, moved);
      const cells = m.rows[rowIdx].cells;
      const sum = cells.reduce((a, c) => a + (c.span ?? COLS), 0);
      if (sum > COLS) {
        const each = Math.floor(COLS / cells.length);
        cells.forEach((c, i) => c.span = i === 0 ? COLS - each * (cells.length - 1) : each);
      }
    } else {
      moved.span = COLS;
      m.rows.splice(target.idx, 0, { cells: [moved] });
    }
    if (leftSourceRow && src.cells.length > 0) fillRowSpans(src.cells);
    m.rows = m.rows.filter((r) => r.cells.length > 0);
    return m;
  }
  function removeBlock(model, rowIdx, cellIdx) {
    const row = model.rows[rowIdx];
    if (!row || !row.cells[cellIdx]) return model;
    if (model.rows.length === 1 && row.cells.length === 1) return model;
    const m = deepCopyModel(model);
    const src = m.rows[rowIdx];
    src.cells.splice(cellIdx, 1);
    if (src.cells.length > 0) fillRowSpans(src.cells);
    m.rows = m.rows.filter((r) => r.cells.length > 0);
    return m;
  }
  function pickDropTarget(point, geoms, isValid2, opts = {}) {
    const edgeFrac = opts.edgeFrac ?? 0.28;
    const edgeMin = opts.edgeMin ?? 8;
    const edgeMax = opts.edgeMax ?? 80;
    const snapPx = opts.snapPx ?? 140;
    const gapYs = [];
    for (let i = 0; i <= geoms.length; i++) {
      let prevBottom = null;
      for (let k = i - 1; k >= 0; k--) {
        if (geoms[k].rect) {
          prevBottom = geoms[k].rect.bottom;
          break;
        }
      }
      let nextTop = null;
      for (let k = i; k < geoms.length; k++) {
        if (geoms[k].rect) {
          nextTop = geoms[k].rect.top;
          break;
        }
      }
      if (prevBottom == null && nextTop == null) continue;
      const y = prevBottom == null ? nextTop - 10 : nextTop == null ? prevBottom + 10 : (prevBottom + nextTop) / 2;
      gapYs.push({ idx: i, y });
    }
    const tryGap = (idx) => {
      const g = gapYs.find((x) => x.idx === idx);
      if (!g) return null;
      const target = { kind: "gap", idx };
      return isValid2(target) ? { target, indicator: { kind: "gap", y: g.y } } : null;
    };
    const tryCell = (rowIdx) => {
      const g = geoms[rowIdx];
      if (!g.rect) return null;
      const rects = g.cellRects.map((c) => c.rect);
      let cellIdx = rects.length;
      for (let i = 0; i < rects.length; i++) {
        if (rects[i] && point.x < (rects[i].left + rects[i].right) / 2) {
          cellIdx = i;
          break;
        }
      }
      const target = { kind: "cell", rowIdx, cellIdx };
      if (!isValid2(target)) return null;
      const before = rects[cellIdx - 1] ?? null;
      const after = rects[cellIdx] ?? null;
      const x = before && after ? (before.right + after.left) / 2 : after ? after.left : before ? before.right : (g.rect.left + g.rect.right) / 2;
      return { target, indicator: { kind: "cell", rowIdx, x, row: { ...g.rect } } };
    };
    for (let rowIdx = 0; rowIdx < geoms.length; rowIdx++) {
      const r = geoms[rowIdx].rect;
      if (!r || point.y < r.top || point.y > r.bottom) continue;
      const edge = Math.min(Math.max((r.bottom - r.top) * edgeFrac, edgeMin), edgeMax);
      const nearGap = point.y < (r.top + r.bottom) / 2 ? rowIdx : rowIdx + 1;
      const order = point.y < r.top + edge ? [() => tryGap(rowIdx), () => tryCell(rowIdx), () => tryGap(rowIdx + 1)] : point.y > r.bottom - edge ? [() => tryGap(rowIdx + 1), () => tryCell(rowIdx), () => tryGap(rowIdx)] : [
        () => tryCell(rowIdx),
        () => tryGap(nearGap),
        () => tryGap(nearGap === rowIdx ? rowIdx + 1 : rowIdx)
      ];
      for (const fn of order) {
        const res = fn();
        if (res) return res;
      }
      return null;
    }
    let best = null;
    for (const g of gapYs) {
      const dist = Math.abs(point.y - g.y);
      if (!best || dist < best.dist) best = { ...g, dist };
    }
    if (best && best.dist <= snapPx) return tryGap(best.idx);
    return null;
  }

  // extension/frame-map.mjs
  function alignRowsToChildren(rows, kinds, children) {
    const kindOf = (id) => kinds instanceof Map ? kinds.get(id) : kinds[id];
    const slots = rows.map((row, i) => {
      const solo = row.cells.length === 1;
      const c0 = row.cells[0];
      const dynamic = solo && kindOf(c0.block) === "dynamic";
      const bare = solo && (c0.span == null || c0.span >= 12) && c0.heightPx == null;
      return {
        rowIdx: i,
        dynamic,
        wrapped: !dynamic && !bare,
        cellCount: row.cells.length,
        blockIds: row.cells.map((c) => c.block)
      };
    });
    const wrappedSlots = slots.filter((s) => s.wrapped);
    const wrapperChildren = children.flatMap((c, i) => c.wrapper ? [i] : []);
    if (wrappedSlots.length !== wrapperChildren.length) return null;
    let fixed = wrappedSlots.map((s, k) => ({ slot: s.rowIdx, child: wrapperChildren[k], via: "wrapper" }));
    for (const f of fixed) {
      if ((children[f.child].cellCount ?? 0) !== slots[f.slot].cellCount) return null;
    }
    const anchorFixed = [];
    const claimedChildren = new Set(fixed.map((f) => f.child));
    for (const s of slots) {
      if (s.wrapped || s.dynamic) continue;
      const bid = s.blockIds[0];
      const matches = children.flatMap(
        (c, i) => !c.wrapper && !claimedChildren.has(i) && c.anchors?.has(bid) ? [i] : []
      );
      if (matches.length === 1) anchorFixed.push({ slot: s.rowIdx, child: matches[0], via: "anchor" });
    }
    const childUses = /* @__PURE__ */ new Map();
    for (const f of anchorFixed) childUses.set(f.child, (childUses.get(f.child) || 0) + 1);
    fixed = fixed.concat(anchorFixed.filter((f) => childUses.get(f.child) === 1));
    const consistent = (list) => {
      const sorted = [...list].sort((a, z) => a.slot - z.slot);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].child <= sorted[i - 1].child) return null;
      }
      return sorted;
    };
    let pins = consistent(fixed);
    if (!pins) {
      pins = consistent(fixed.filter((f) => f.via === "wrapper"));
      if (!pins) return null;
    }
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
        if (segChildren.length > 0) return null;
        continue;
      }
      const dynPositions = segSlots.filter((i) => slots[i].dynamic);
      if (dynPositions.length === 0) {
        if (segSlots.length !== segChildren.length) return null;
        segSlots.forEach((slotIdx, k2) => {
          result[slotIdx] = { rowIdx: slotIdx, childIdxs: [segChildren[k2]], via: "position" };
        });
        continue;
      }
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
        result[slotIdx] = slots[slotIdx].dynamic ? { rowIdx: slotIdx, childIdxs: [], via: "dynamic" } : (
          // A bare static sandwiched between pinned dynamics with no anchor:
          // we can't tell its DOM node from the dynamics' output. It stays in
          // the model (never moves) but gets no drag affordance.
          { rowIdx: slotIdx, childIdxs: [], via: "inert" }
        );
      }
      result[interior[0]] = { rowIdx: interior[0], childIdxs: middle, via: "dynamic" };
    }
    for (const r of result) {
      if (r.via === "none") {
        r.via = slots[r.rowIdx].dynamic ? "dynamic" : "inert";
      }
    }
    return result;
  }

  // extension/frame.js
  var BRIDGE = "dive-arranger-bridge";
  var TOP_ORIGIN = "https://app.motherduck.com";
  var UI_ATTR = "data-dive-arranger-ui";
  var IN_FRAME = window !== window.top;
  var session = null;
  var post = (msg) => window.parent.postMessage({ source: BRIDGE, role: "frame", ...msg }, TOP_ORIGIN);
  if (IN_FRAME) {
    window.addEventListener("message", (ev) => {
      if (ev.origin !== TOP_ORIGIN || ev.source !== window.parent) return;
      const d = ev.data;
      if (!d || d.source !== BRIDGE || d.role !== "top") return;
      if (d.type === "ARRANGE_INIT") return onInit(d);
      if (!session || d.nonce !== session.nonce) return;
      if (d.type === "MODEL") return onModel(d);
      if (d.type === "ARRANGE_CANCEL") return onCancel();
    });
  }
  var initsSeen = /* @__PURE__ */ new Set();
  var activeInitNonce = null;
  function onInit(d) {
    if (!d.nonce || !Array.isArray(d.blocks) || !d.model) return;
    if (session && session.nonce === d.nonce) {
      post({ type: "INIT_ACK", nonce: d.nonce });
      return;
    }
    if (initsSeen.has(d.nonce)) return;
    initsSeen.add(d.nonce);
    activeInitNonce = d.nonce;
    post({ type: "INIT_ACK", nonce: d.nonce });
    if (session) teardown(true);
    const deadline = Date.now() + 6e3;
    const attempt = () => {
      if (activeInitNonce !== d.nonce) return;
      let result = null;
      let err = null;
      try {
        result = startSession(d);
      } catch (e) {
        err = e;
        if (session && session.nonce === d.nonce) teardown(true);
      }
      if (result) {
        post({
          type: "MAPPED",
          nonce: d.nonce,
          ok: true,
          tiles: result.tiles,
          pinned: result.pinned,
          inert: result.inert
        });
        return;
      }
      if (Date.now() < deadline) {
        setTimeout(attempt, 500);
      } else {
        post({
          type: "MAPPED",
          nonce: d.nonce,
          ok: false,
          reason: err?.message || "could not match the rendered tiles to the source blocks",
          expected: { blocks: d.blocks.length, rows: d.model.rows.map((r) => r.cells.length) },
          diag: lastMapDiag
        });
      }
    };
    attempt();
  }
  function onModel(d) {
    if (!session || !d.model) return;
    if (Array.isArray(d.idMap)) {
      const remap = new Map(d.idMap);
      const remapMap = (m) => {
        const out = /* @__PURE__ */ new Map();
        for (const [k, v] of m) {
          if (session.deleted.has(k) && !remap.has(k)) continue;
          out.set(remap.has(k) ? remap.get(k) : k, v);
        }
        return out;
      };
      session.tiles = remapMap(session.tiles);
      session.dynEls = remapMap(session.dynEls);
      session.deleted = new Set(
        [...session.deleted].filter((k) => remap.has(k)).map((k) => remap.get(k))
      );
    }
    if (Array.isArray(d.blocks)) session.blocks = d.blocks;
    session.model = deepCopyModel(d.model);
    layoutFrame();
    rebuildChrome();
  }
  function onCancel() {
    teardown(true);
    post({ type: "EXITED" });
  }
  function findTextElement(needle) {
    const root = document.body || document.documentElement;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while (n = walker.nextNode()) {
      if (n.nodeValue && n.nodeValue.includes(needle)) return n.parentElement;
    }
    return null;
  }
  function ancestorChain(el) {
    const chain = [];
    for (let cur = el; cur; cur = cur.parentElement) chain.push(cur);
    return chain;
  }
  function anchorElementsFor(blocks) {
    const els = [];
    for (const b of blocks) {
      if (b.kind !== "static") continue;
      for (const t of [...b.texts || []].sort((a, z) => z.length - a.length)) {
        const el = findTextElement(t);
        if (el) {
          els.push(el);
          break;
        }
      }
    }
    return els;
  }
  function* containerCandidates(blocks) {
    const marker = document.querySelector('[data-dive-arranger="row"]');
    if (marker?.parentElement) yield { el: marker.parentElement, trusted: true };
    const anchors = anchorElementsFor(blocks);
    if (anchors.length >= 2) {
      let common = null;
      for (const el of anchors) {
        const chain = ancestorChain(el);
        if (!common) {
          common = chain;
        } else {
          const set = new Set(chain);
          common = common.filter((a) => set.has(a));
        }
      }
      for (let i = 0; i < 3 && common?.[i]; i++) yield { el: common[i], trusted: true };
    }
    let cur = document.body;
    for (let i = 0; i < 8 && cur && cur.childElementCount === 1; i++) cur = cur.firstElementChild;
    if (cur) {
      const queue = [{ el: cur, depth: 0 }];
      let n = 0;
      while (queue.length && n < 40) {
        const { el, depth } = queue.shift();
        n += 1;
        if (el.childElementCount >= 2) yield { el, trusted: false };
        if (depth < 3) for (const c of el.children) queue.push({ el: c, depth: depth + 1 });
      }
    }
  }
  var SKIP_TAGS = ["SCRIPT", "STYLE", "LINK", "TEMPLATE", "NOSCRIPT"];
  function rowContainerInfo(el) {
    let cs = null;
    try {
      if (typeof getComputedStyle === "function") cs = getComputedStyle(el);
    } catch {
    }
    return classifyRowContainer({
      classAttr: el.getAttribute("class") || "",
      display: cs?.display || el.style?.display || null,
      gridTemplateColumns: cs?.gridTemplateColumns || el.style?.gridTemplateColumns || null,
      flexDirection: cs?.flexDirection || el.style?.flexDirection || null
    });
  }
  function describeChildren(container, blocks) {
    const els = [...container.children].filter(
      (el) => !SKIP_TAGS.includes(el.tagName) && !el.hasAttribute(UI_ATTR)
    );
    const desc = els.map((el) => {
      const wrapper = el.getAttribute("data-dive-arranger") === "row";
      const cellCount = wrapper ? [...el.children].filter((c) => c.getAttribute?.("data-dive-arranger") === "cell").length : 0;
      let rowLike = false;
      let rowChildCount = 0;
      if (!wrapper && el.getAttribute("data-dive-arranger") == null) {
        const info = rowContainerInfo(el);
        if (info) {
          const n = [...el.children].filter((c) => !SKIP_TAGS.includes(c.tagName)).length;
          if (n >= 2) {
            rowLike = true;
            rowChildCount = n;
          }
        }
      }
      return { wrapper, cellCount, srcCells: 0, rowLike, rowChildCount, anchors: /* @__PURE__ */ new Set(), el };
    });
    for (const b of blocks) {
      if (b.kind !== "static") continue;
      for (const t of [...b.texts || []].sort((a, z) => z.length - a.length)) {
        const hits = desc.filter((c) => !c.wrapper && c.el.textContent.includes(t));
        if (hits.length === 1) {
          hits[0].anchors.add(b.id);
          break;
        }
      }
    }
    return desc;
  }
  function assignSrcRows(desc, model, blocks) {
    const byId = new Map(blocks.map((b) => [b.id, b]));
    const longestText = (id) => {
      const b = byId.get(id);
      if (!b || b.kind !== "static") return null;
      const ts = (b.texts || []).filter(Boolean);
      return ts.length ? ts.slice().sort((a, z) => z.length - a.length)[0] : null;
    };
    const wrapped = model.rows.map((row) => ({
      cellCount: row.cells.length,
      texts: row.cells.map((c) => longestText(c.block)).filter(Boolean)
    })).filter((r) => r.cellCount >= 2);
    let from = 0;
    for (const row of wrapped) {
      for (let j = from; j < desc.length; j++) {
        const c = desc[j];
        if (c.wrapper || !c.rowLike || c.srcCells || c.rowChildCount !== row.cellCount) continue;
        const txt = c.el.textContent || "";
        if (row.texts.length && !row.texts.every((t) => txt.includes(t))) continue;
        c.srcCells = row.cellCount;
        from = j + 1;
        break;
      }
    }
  }
  function briefCand(cand, desc, why) {
    return {
      trusted: !!cand.trusted,
      why,
      children: desc.slice(0, 16).map((c) => ({
        tag: c.el.tagName,
        cls: (c.el.getAttribute("class") || "").slice(0, 44),
        kids: c.el.childElementCount,
        wrapper: c.wrapper,
        rowLike: c.rowLike,
        srcCells: c.srcCells,
        anchors: [...c.anchors]
      }))
    };
  }
  var lastMapDiag = null;
  function locateTiles(blocks, model) {
    const kinds = new Map(blocks.map((b) => [b.id, b.kind]));
    const anyAnchorText = blocks.some((b) => b.kind === "static" && (b.texts || []).length > 0);
    const seen = /* @__PURE__ */ new Set();
    const diag = [];
    for (const cand of containerCandidates(blocks)) {
      if (!cand.el || seen.has(cand.el)) continue;
      seen.add(cand.el);
      const desc = describeChildren(cand.el, blocks);
      if (desc.length === 0) continue;
      assignSrcRows(desc, model, blocks);
      const anchorsFound = desc.some((c) => c.anchors.size > 0);
      if (!cand.trusted && anyAnchorText && !anchorsFound) {
        diag.push(briefCand(cand, desc, "untrusted candidate, no anchor text matched"));
        continue;
      }
      const passes = desc.some((c) => c.srcCells) ? [true, false] : [false];
      for (const useSrc of passes) {
        const view = useSrc ? desc.map((c) => c.srcCells ? { ...c, wrapper: true, cellCount: c.srcCells } : c) : desc;
        const alignment = alignRowsToChildren(model.rows, kinds, view);
        if (alignment) return { container: cand.el, desc: view, alignment };
      }
      diag.push(briefCand(cand, desc, "no row\u2194child alignment"));
    }
    lastMapDiag = diag.slice(0, 4);
    return null;
  }
  function startSession(d) {
    const model = deepCopyModel(d.model);
    const blocks = d.blocks;
    const found = locateTiles(blocks, model);
    if (!found) return null;
    const { container, desc, alignment } = found;
    const tiles = /* @__PURE__ */ new Map();
    const dynEls = /* @__PURE__ */ new Map();
    const inert = [];
    const wrappers = [];
    for (const a of alignment) {
      const row = model.rows[a.rowIdx];
      if (a.via === "wrapper") {
        const wrapperEl = desc[a.childIdxs[0]].el;
        wrappers.push(wrapperEl);
        if (wrapperEl.getAttribute("data-dive-arranger") === "row") {
          const cellEls = [...wrapperEl.children].filter(
            (c) => c.getAttribute?.("data-dive-arranger") === "cell"
          );
          if (cellEls.length !== row.cells.length) return null;
          row.cells.forEach((cell, k) => {
            const cellEl = cellEls[k];
            const el = cellEl.childElementCount === 1 ? cellEl.firstElementChild : cellEl;
            tiles.set(cell.block, { el, lift: { cellEl, wrapperEl } });
          });
        } else {
          const cellEls = [...wrapperEl.children].filter((c) => !SKIP_TAGS.includes(c.tagName));
          if (cellEls.length !== row.cells.length) return null;
          row.cells.forEach((cell, k) => {
            tiles.set(cell.block, { el: cellEls[k], lift: { wrapperEl } });
          });
        }
      } else if (a.via === "dynamic") {
        dynEls.set(row.cells[0].block, a.childIdxs.map((j) => desc[j].el));
      } else if (a.via === "inert") {
        inert.push(row.cells[0].block);
      } else {
        tiles.set(row.cells[0].block, { el: desc[a.childIdxs[0]].el });
      }
    }
    const undo = [];
    const baseStyle = /* @__PURE__ */ new Map();
    session = {
      nonce: d.nonce,
      blocks,
      model,
      container,
      tiles,
      dynEls,
      inert,
      deleted: /* @__PURE__ */ new Set(),
      // blockIds deleted this session (preview-only; Cancel restores)
      baseStyle,
      undo,
      chrome: [],
      host: null,
      shadow: null,
      raf: 0,
      drag: null
    };
    const capture = (el) => {
      if (baseStyle.has(el)) return;
      const value = el.getAttribute("style");
      baseStyle.set(el, value ?? "");
      undo.push({ kind: "style", el, value });
    };
    capture(container);
    for (const w of wrappers) capture(w);
    for (const { el } of tiles.values()) capture(el);
    for (const els of dynEls.values()) for (const el of els) capture(el);
    for (const row of model.rows) {
      for (const cell of row.cells) {
        const t = tiles.get(cell.block);
        if (!t?.lift) continue;
        undo.push({ kind: "move", el: t.el, parent: t.el.parentElement, next: t.el.nextSibling });
        container.insertBefore(t.el, t.lift.wrapperEl);
      }
    }
    for (const w of wrappers) w.style.display = "none";
    container.style.display = "grid";
    container.style.gridTemplateColumns = `repeat(${GRID_COLS}, minmax(0, 1fr))`;
    container.style.gap = `${GRID_GAP}px`;
    container.style.alignItems = "start";
    layoutFrame();
    buildHost();
    rebuildChrome();
    tick();
    return {
      tiles: tiles.size,
      pinned: dynEls.size,
      inert: inert.map((id) => blocks.find((b) => b.id === id)?.label ?? String(id))
    };
  }
  function teardown(restore) {
    if (!session) return;
    cancelAnimationFrame(session.raf);
    session.host?.remove();
    if (restore) {
      for (let i = session.undo.length - 1; i >= 0; i--) {
        const u = session.undo[i];
        try {
          if (u.kind === "style") {
            u.value == null ? u.el.removeAttribute("style") : u.el.setAttribute("style", u.value);
          } else {
            u.parent.insertBefore(u.el, u.next && u.next.parentNode === u.parent ? u.next : null);
          }
        } catch {
        }
      }
    }
    session = null;
  }
  function layoutFrame() {
    const s = session;
    let r = 1;
    for (const row of s.model.rows) {
      const solo = row.cells.length === 1;
      if (solo && s.dynEls.has(row.cells[0].block)) {
        for (const el of s.dynEls.get(row.cells[0].block)) {
          el.setAttribute("style", s.baseStyle.get(el) || "");
          el.style.gridRow = String(r++);
          el.style.gridColumn = "1 / -1";
          el.style.minWidth = "0";
        }
        continue;
      }
      let col = 1;
      let any = false;
      for (const cell of row.cells) {
        const span = cell.span ?? Math.max(1, Math.floor(COLS / row.cells.length));
        const t = s.tiles.get(cell.block);
        if (t) {
          const el = t.el;
          el.setAttribute("style", s.baseStyle.get(el) || "");
          el.style.gridRow = String(r);
          el.style.gridColumn = `${col} / span ${span}`;
          el.style.minWidth = "0";
          if (cell.heightPx != null) {
            el.style.height = `${cell.heightPx}px`;
            el.style.overflow = "auto";
          }
          any = true;
        }
        col += span;
      }
      if (any) r += 1;
    }
    for (const id of [...s.deleted]) {
      if (findCell(s.model, id)) {
        s.deleted.delete(id);
        continue;
      }
      const t = s.tiles.get(id);
      if (t) t.el.style.display = "none";
    }
  }
  var CHROME_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .box {
    position: fixed; border: 1.5px dashed rgba(7,119,179,.6); border-radius: 6px;
    pointer-events: none;
  }
  .box.pinned { border-color: rgba(200,170,70,.55); }
  .box.dragging { opacity: .35; }
  .grip {
    position: fixed; pointer-events: auto; cursor: grab; touch-action: none;
    background: #0777b3; color: #fff; border-radius: 6px; padding: 2px 8px;
    font: 600 12px/1.4 system-ui, sans-serif; user-select: none;
    box-shadow: 0 1px 6px rgba(0,0,0,.35);
  }
  .del {
    position: fixed; pointer-events: auto; cursor: pointer; touch-action: none;
    background: #26262c; color: #ff8f82; border: 1px solid #4a3437;
    border-radius: 6px; padding: 1px 7px;
    font: 600 12px/1.4 system-ui, sans-serif; user-select: none;
    box-shadow: 0 1px 6px rgba(0,0,0,.35);
  }
  .del:hover { background: #7a2430; color: #fff; border-color: #7a2430; }
  .meta {
    position: fixed; pointer-events: none;
    background: rgba(23,23,27,.85); color: #cfe3cf; border-radius: 6px;
    padding: 1px 7px; font: 600 10px/1.5 system-ui, sans-serif; white-space: nowrap;
  }
  .pinbadge {
    position: fixed; pointer-events: none;
    background: #5a4a1f; color: #e8c76a; border-radius: 6px;
    padding: 1px 7px; font: 600 10px/1.5 system-ui, sans-serif;
  }
  .rz-e { position: fixed; width: 10px; cursor: ew-resize; pointer-events: auto; touch-action: none; border-radius: 3px; }
  .rz-s { position: fixed; height: 10px; cursor: ns-resize; pointer-events: auto; touch-action: none; border-radius: 3px; }
  .rz-e:hover, .rz-s:hover { background: rgba(7,119,179,.5); }
  .gapline { position: fixed; height: 4px; border-radius: 2px; background: #0777b3; display: none; pointer-events: none; }
  .colline { position: fixed; width: 4px; border-radius: 2px; background: #0777b3; display: none; pointer-events: none; }
  .rowring { position: fixed; border: 2px dashed #0777b3; border-radius: 8px; display: none; pointer-events: none; }
  .ghost {
    position: fixed; pointer-events: none; display: none;
    background: rgba(31,31,36,.92); color: #fff; border: 1px solid #0777b3;
    border-radius: 6px; padding: 4px 10px; font: 600 12px system-ui, sans-serif;
    box-shadow: 0 8px 30px rgba(0,0,0,.5); max-width: 40ch; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
`;
  function buildHost() {
    const host = document.createElement("div");
    host.setAttribute(UI_ATTR, "1");
    Object.assign(host.style, {
      position: "fixed",
      inset: "0",
      zIndex: 2147483646,
      pointerEvents: "none"
    });
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CHROME_CSS;
    shadow.appendChild(style);
    const layer = document.createElement("div");
    shadow.appendChild(layer);
    const gapline = document.createElement("div");
    gapline.className = "gapline";
    const colline = document.createElement("div");
    colline.className = "colline";
    const rowring = document.createElement("div");
    rowring.className = "rowring";
    const ghost = document.createElement("div");
    ghost.className = "ghost";
    shadow.append(gapline, colline, rowring, ghost);
    document.documentElement.appendChild(host);
    session.host = host;
    session.shadow = shadow;
    session.layer = layer;
    session.gapline = gapline;
    session.colline = colline;
    session.rowring = rowring;
    session.ghost = ghost;
  }
  function labelOf(blockId) {
    return session.blocks.find((b) => b.id === blockId)?.label ?? `block ${blockId}`;
  }
  function rebuildChrome() {
    const s = session;
    s.layer.textContent = "";
    s.chrome = [];
    for (const [blockId, t] of s.tiles) {
      if (s.deleted.has(blockId)) continue;
      const box = document.createElement("div");
      box.className = "box";
      const grip = document.createElement("div");
      grip.className = "grip";
      grip.textContent = "\u283F";
      grip.title = `${labelOf(blockId)} \u2014 drag to move`;
      const del = document.createElement("div");
      del.className = "del";
      del.textContent = "\u2715";
      del.title = `${labelOf(blockId)} \u2014 delete tile (preview only; Submit saves, Close restores)`;
      const meta = document.createElement("div");
      meta.className = "meta";
      const east = document.createElement("div");
      east.className = "rz-e";
      east.title = "drag to change width";
      const south = document.createElement("div");
      south.className = "rz-s";
      south.title = "drag to set height \xB7 double-click to reset";
      s.layer.append(box, grip, del, meta, east, south);
      grip.addEventListener("pointerdown", (ev) => startDrag(ev, blockId));
      del.addEventListener("click", (ev) => {
        ev.preventDefault?.();
        deleteTile(blockId);
      });
      east.addEventListener("pointerdown", (ev) => startResizeW(ev, blockId));
      south.addEventListener("pointerdown", (ev) => startResizeH(ev, blockId));
      south.addEventListener("dblclick", () => {
        const loc = findCell(s.model, blockId);
        if (!loc) return;
        s.model.rows[loc.rowIdx].cells[loc.cellIdx].heightPx = null;
        layoutFrame();
        propose();
      });
      s.chrome.push({ kind: "tile", blockId, el: t.el, box, grip, del, meta, east, south });
    }
    for (const [blockId, els] of s.dynEls) {
      if (!els.length) continue;
      const box = document.createElement("div");
      box.className = "box pinned";
      const badge = document.createElement("div");
      badge.className = "pinbadge";
      badge.textContent = "pinned";
      badge.title = `${labelOf(blockId)} \u2014 conditional/loop output; the arranger never moves it`;
      s.layer.append(box, badge);
      s.chrome.push({ kind: "pinned", blockId, els, box, badge });
    }
  }
  function unionRect(els) {
    let rect = null;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 && r.height < 1) continue;
      rect = rect ? {
        left: Math.min(rect.left, r.left),
        top: Math.min(rect.top, r.top),
        right: Math.max(rect.right, r.right),
        bottom: Math.max(rect.bottom, r.bottom)
      } : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
    return rect;
  }
  function place(el, rect) {
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
    if (rect.width != null) el.style.width = `${rect.width}px`;
    if (rect.height != null) el.style.height = `${rect.height}px`;
  }
  function updateChrome() {
    const s = session;
    for (const c of s.chrome) {
      const rect = c.kind === "tile" ? unionRect([c.el]) : unionRect(c.els);
      const parts = c.kind === "tile" ? [c.box, c.grip, c.del, c.meta, c.east, c.south] : [c.box, c.badge];
      if (!rect) {
        for (const p of parts) p.style.display = "none";
        continue;
      }
      for (const p of parts) p.style.display = "";
      const w = rect.right - rect.left;
      const h = rect.bottom - rect.top;
      place(c.box, { left: rect.left - 2, top: rect.top - 2, width: w + 4, height: h + 4 });
      if (c.kind === "pinned") {
        place(c.badge, { left: rect.left + 6, top: rect.top + 6 });
        continue;
      }
      place(c.grip, { left: rect.left + 6, top: rect.top + 6 });
      place(c.del, { left: rect.left + 34, top: rect.top + 6 });
      const loc = findCell(s.model, c.blockId);
      if (loc) {
        const cell = s.model.rows[loc.rowIdx].cells[loc.cellIdx];
        const span = cell.span ?? COLS;
        c.meta.textContent = `${span}/${COLS}${cell.heightPx ? ` \xB7 ${cell.heightPx}px` : ""}`;
      }
      place(c.meta, { left: Math.max(rect.left + 40, rect.right - 90), top: rect.top + 6 });
      place(c.east, { left: rect.right - 5, top: rect.top, height: h });
      place(c.south, { left: rect.left, top: rect.bottom - 5, width: w });
    }
  }
  function tick() {
    if (!session) return;
    updateChrome();
    session.raf = requestAnimationFrame(tick);
  }
  function findCell(model, blockId) {
    for (let r = 0; r < model.rows.length; r++) {
      const i = model.rows[r].cells.findIndex((c) => c.block === blockId);
      if (i !== -1) return { rowIdx: r, cellIdx: i };
    }
    return null;
  }
  function isValid(proposed) {
    try {
      validateLayout(session.blocks, deepCopyModel(proposed));
      return true;
    } catch {
      return false;
    }
  }
  function propose() {
    post({ type: "PROPOSE", nonce: session.nonce, model: session.model });
  }
  function rowGeometry() {
    const s = session;
    return s.model.rows.map((row) => {
      const els = [];
      const cellRects = [];
      for (const cell of row.cells) {
        const t = s.tiles.get(cell.block);
        if (t) {
          els.push(t.el);
          cellRects.push({ block: cell.block, rect: unionRect([t.el]) });
        } else if (s.dynEls.has(cell.block)) {
          for (const el of s.dynEls.get(cell.block)) els.push(el);
          cellRects.push({ block: cell.block, rect: unionRect(s.dynEls.get(cell.block)) });
        } else {
          cellRects.push({ block: cell.block, rect: null });
        }
      }
      return { rect: unionRect(els), cellRects };
    });
  }
  function startDrag(ev, blockId) {
    ev.preventDefault();
    const s = session;
    const from = findCell(s.model, blockId);
    if (!from || s.drag) return;
    const chrome = s.chrome.find((c) => c.kind === "tile" && c.blockId === blockId);
    chrome?.box.classList.add("dragging");
    if (chrome) chrome.el.style.opacity = "0.45";
    s.ghost.textContent = labelOf(blockId);
    s.ghost.style.display = "block";
    s.drag = { blockId, from, target: null };
    const clearIndicators = () => {
      s.gapline.style.display = "none";
      s.colline.style.display = "none";
      s.rowring.style.display = "none";
    };
    const onMove = (e) => {
      if (session !== s) return;
      s.ghost.style.left = `${e.clientX + 12}px`;
      s.ghost.style.top = `${e.clientY + 12}px`;
      clearIndicators();
      s.drag.target = null;
      const picked = pickDropTarget(
        { x: e.clientX, y: e.clientY },
        rowGeometry(),
        (t) => isValid(moveBlock(s.model, from.rowIdx, from.cellIdx, t))
      );
      if (!picked) return;
      s.drag.target = picked.target;
      if (picked.indicator.kind === "gap") {
        const cr = s.container.getBoundingClientRect();
        place(s.gapline, { left: cr.left, top: picked.indicator.y - 2, width: cr.width });
        s.gapline.style.display = "block";
      } else {
        const row = picked.indicator.row;
        place(s.rowring, {
          left: row.left - 5,
          top: row.top - 5,
          width: row.right - row.left + 10,
          height: row.bottom - row.top + 10
        });
        s.rowring.style.display = "block";
        place(s.colline, {
          left: picked.indicator.x - 2,
          top: row.top - 5,
          height: row.bottom - row.top + 10
        });
        s.colline.style.display = "block";
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      s.ghost.style.display = "none";
      clearIndicators();
      chrome?.box.classList.remove("dragging");
      if (chrome) chrome.el.style.opacity = "";
      const target = s.drag?.target;
      s.drag = null;
      if (target && session === s) {
        s.model = moveBlock(s.model, from.rowIdx, from.cellIdx, target);
        layoutFrame();
        propose();
      }
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
  }
  function deleteTile(blockId) {
    const s = session;
    if (!s || s.drag) return;
    const loc = findCell(s.model, blockId);
    if (!loc) return;
    const next = removeBlock(s.model, loc.rowIdx, loc.cellIdx);
    if (next === s.model) return;
    if (!isValid(next)) return;
    s.model = next;
    s.deleted.add(blockId);
    const t = s.tiles.get(blockId);
    if (t) t.el.style.display = "none";
    layoutFrame();
    rebuildChrome();
    propose();
  }
  function startResizeW(ev, blockId) {
    ev.preventDefault();
    const s = session;
    const loc = findCell(s.model, blockId);
    if (!loc) return;
    const row = s.model.rows[loc.rowIdx];
    const cell = row.cells[loc.cellIdx];
    const startSpan = cell.span ?? Math.max(1, Math.floor(COLS / row.cells.length));
    const cr = s.container.getBoundingClientRect();
    const colStep = (cr.width - GRID_GAP * (COLS - 1)) / COLS + GRID_GAP;
    const startX = ev.clientX;
    const others = row.cells.reduce(
      (a, c, i) => i === loc.cellIdx ? a : a + (c.span ?? Math.floor(COLS / row.cells.length)),
      0
    );
    const onMove = (e) => {
      if (session !== s) return;
      let span = Math.round(startSpan + (e.clientX - startX) / colStep);
      span = Math.max(1, Math.min(COLS - others, span));
      if (span !== cell.span) {
        cell.span = span;
        layoutFrame();
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      if (session === s) propose();
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
  }
  function startResizeH(ev, blockId) {
    ev.preventDefault();
    const s = session;
    const loc = findCell(s.model, blockId);
    if (!loc) return;
    const cell = s.model.rows[loc.rowIdx].cells[loc.cellIdx];
    const tile = s.tiles.get(blockId);
    const startH = cell.heightPx ?? (tile ? tile.el.getBoundingClientRect().height : 240);
    const startY = ev.clientY;
    const onMove = (e) => {
      if (session !== s) return;
      const h = Math.max(60, Math.min(2e3, Math.round(startH + (e.clientY - startY))));
      if (h !== cell.heightPx) {
        cell.heightPx = h;
        layoutFrame();
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      if (session === s) propose();
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
  }
})();
