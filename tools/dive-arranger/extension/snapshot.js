// Best-effort static DOM snapshots of the dive's rendered blocks.
//
// We never re-execute dive JSX. Instead we try to find, in the live page, the
// DOM subtree each source block rendered to, and clone it (styles inlined,
// canvases rasterized) into a non-interactive preview card. Mapping is by
// anchor text: distinctive string literals extracted from each block's AST are
// searched in the page; the lowest common container whose direct children
// separate the anchors gives the block ↔ DOM mapping (positional/source-order
// fidelity is then checked). Anything unmapped falls back to a code card —
// the drag UX is identical either way.

const MAX_STYLED_NODES = 600;

function* documentsToSearch() {
  yield document;
  for (const iframe of document.querySelectorAll("iframe")) {
    try {
      if (iframe.contentDocument) yield iframe.contentDocument; // same-origin only
    } catch {
      /* cross-origin iframe — can't look inside */
    }
  }
}

function findTextElement(doc, needle) {
  const walker = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (n.nodeValue && n.nodeValue.includes(needle)) return n.parentElement;
  }
  return null;
}

function ancestorChain(el) {
  const chain = [];
  for (let cur = el; cur; cur = cur.parentElement) chain.push(cur);
  return chain; // el … root
}

/**
 * blocks: [{ id, kind, texts: [...] }] in source order.
 * Returns Map<blockId, Element> for the blocks we could confidently map.
 */
export function mapBlocksToDom(blocks) {
  const result = new Map();
  for (const doc of documentsToSearch()) {
    const anchors = new Map(); // blockId -> element containing its anchor text
    for (const b of blocks) {
      if (b.kind !== "static") continue;
      for (const t of [...(b.texts || [])].sort((a, z) => z.length - a.length)) {
        const el = findTextElement(doc, t);
        if (el) {
          anchors.set(b.id, el);
          break;
        }
      }
    }
    if (anchors.size < 2) continue; // need at least two to triangulate a container

    // Lowest common ancestor of all anchor elements.
    let common = null;
    for (const el of anchors.values()) {
      const chain = ancestorChain(el);
      if (!common) {
        common = chain;
      } else {
        const set = new Set(chain);
        common = common.filter((a) => set.has(a));
      }
    }
    const container = common && common[0];
    if (!container) continue;

    // Map each anchored block to the direct child of `container` on the path
    // to its anchor. Distinct blocks must land on distinct children.
    const used = new Set();
    const mapping = new Map();
    let okMapping = true;
    for (const [blockId, el] of anchors) {
      const chain = ancestorChain(el);
      const idx = chain.indexOf(container);
      const child = idx > 0 ? chain[idx - 1] : null;
      if (!child || used.has(child)) {
        okMapping = false;
        break;
      }
      used.add(child);
      mapping.set(blockId, child);
    }
    if (!okMapping) continue;

    // Source-order sanity: DOM order of the mapped children must follow block order.
    const ordered = [...mapping.entries()].sort((a, z) => a[0] - z[0]).map(([, el]) => el);
    let inOrder = true;
    for (let i = 1; i < ordered.length; i++) {
      if (!(ordered[i - 1].compareDocumentPosition(ordered[i]) & Node.DOCUMENT_POSITION_FOLLOWING)) {
        inOrder = false;
        break;
      }
    }
    if (!inOrder) continue;

    for (const [id, el] of mapping) result.set(id, el);
    if (result.size) return result; // first document with a good mapping wins
  }
  return result;
}

function inlineStyles(srcRoot, cloneRoot) {
  const srcWalker = srcRoot.ownerDocument.createTreeWalker(srcRoot, NodeFilter.SHOW_ELEMENT);
  const cloneWalker = cloneRoot.ownerDocument.createTreeWalker(cloneRoot, NodeFilter.SHOW_ELEMENT);
  let count = 0;
  let s = srcRoot;
  let c = cloneRoot;
  while (s && c) {
    if (count++ > MAX_STYLED_NODES) return false;
    const cs = s.ownerDocument.defaultView.getComputedStyle(s);
    // Property-by-property: `cssText` on a computed declaration is "" per
    // CSSOM spec, so it can't be relied on.
    for (const prop of cs) c.style.setProperty(prop, cs.getPropertyValue(prop));
    s = srcWalker.nextNode();
    c = cloneWalker.nextNode();
  }
  return true;
}

function rasterizeCanvases(srcRoot, cloneRoot) {
  const srcCanvases = srcRoot.querySelectorAll("canvas");
  const cloneCanvases = cloneRoot.querySelectorAll("canvas");
  for (let i = 0; i < srcCanvases.length && i < cloneCanvases.length; i++) {
    try {
      const img = cloneRoot.ownerDocument.createElement("img");
      img.src = srcCanvases[i].toDataURL();
      img.width = srcCanvases[i].width;
      img.height = srcCanvases[i].height;
      cloneCanvases[i].replaceWith(img);
    } catch {
      /* tainted canvas — leave the (blank) clone */
    }
  }
}

/**
 * Snapshot a rendered element into a self-contained, non-interactive preview.
 * Returns { node, width, height } or null if the subtree is too big.
 */
export function snapshotElement(el) {
  if (el.querySelectorAll("*").length > MAX_STYLED_NODES) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return null;
  const clone = el.cloneNode(true);
  if (!inlineStyles(el, clone)) return null;
  rasterizeCanvases(el, clone);
  clone.style.margin = "0";
  clone.style.pointerEvents = "none";
  for (const a of clone.querySelectorAll("a")) a.removeAttribute("href");
  for (const s of clone.querySelectorAll("script")) s.remove();
  return { node: clone, width: rect.width, height: rect.height };
}
