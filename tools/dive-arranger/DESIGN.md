# dive-arranger — design

## Problem

The predecessor (`../dive-builder`) rearranges exactly one dive, because its
codegen consumes a hand-written manifest of that dive's six widget modules.
To work on **any** dive, the tool must *discover* the rearrangeable structure
from arbitrary dive source and edit that source without damaging the parts it
doesn't understand.

## Architecture

```
app.motherduck.com tab (TOP frame)
├─ dist/content.js  (isolated world)
│   ├─ engine/ (bundled): discover → validate → apply → print
│   ├─ insitu.js: in-place mode controller — toolbar, proposal validation,
│   │   Submit; postMessage bridge to the dive iframe (origin-checked, nonced)
│   ├─ overlay.js + snapshot.js: card-overlay FALLBACK (only when the iframe
│   │   bridge / tile mapping fails)
│   └─ token discovery (page storage scan → chrome.storage fallback)
├─ dist/md-main.js  (MAIN world, injected on demand)
│   └─ @motherduck/wasm-client: runs MD_GET_DIVE / MD_UPDATE_DIVE_CONTENT
│       (postMessage bridge to the content script)
├─ <iframe sandbox src=https://motherduckusercontent.com/sandbox/…>
│   └─ dist/frame.js (isolated world, injected via all_frames): the dive's
│       rendered tiles live HERE (cross-origin). Maps tiles ↔ source blocks
│       (frame-map.mjs), grids the container, draws drag/resize chrome on the
│       REAL tiles, validates drops with engine/validate.mjs (recast-free
│       bundle, ~41 KB), reports mutations to the top frame.
└─ dist/background.js (service worker): toolbar action → "open arranger"

harness/ (Node): pure engine tests, frame model/alignment tests, a fake-DOM
frame-session smoke (the postMessage protocol end-to-end), and the live
round-trip (@duckdb/node-api) against a throwaway dive it creates and deletes.
```

Data flow on Submit: overlay layout model → `applyLayout(source, layout)` →
new source → `SET VARIABLE … from_base64` + `MD_UPDATE_DIVE_CONTENT` via the
main-world bridge → `MD_GET_DIVE` read-back → byte-compare + re-parse →
status. No write ever happens except from the Submit click.

## Decision record

**1. Blocks = top-level children of the returned root JSX element.**
A dive is one default-export component; its root element's direct children
are almost always the dashboard's visual sections (KPI strip, chart cards,
tables). This decomposition needs zero knowledge of the dive's internals and
has an obvious, explainable boundary. If the root has exactly one child,
discovery descends (≤4 levels) through single-child wrappers (providers/page
shells) to reach the real container.

*Amendment (source row containers):* a top-level child that is itself a
multi-column ROW CONTAINER in the dive's own source — `display:grid` with a
multi-column template (inline style `gridTemplateColumns`, incl. `repeat(N,…)`,
or Tailwind `grid grid-cols-N`) or `display:flex` in row direction — is
descended into exactly ONE level: its element children become separate blocks
forming a multi-cell row (`grid-cols-2` → 6/6 spans, `grid-cols-4` →
3/3/3/3, flex → equal split, `col-span-M` scales), the same representation as
an arranger-authored row, so all move ops (intra-row reorder, extract,
join) work on them with no extra logic. One classifier
(engine/rowcontainer.mjs) is shared with the frame's DOM-side tile mapping so
the two sides cannot disagree. Conservative vetoes keep the container as one
opaque block, as before: non-host (`<Card/>`) container or children, any
dynamic/text child (a dynamic cell can't satisfy the pinned-alone rule), or
grid children that would wrap to a second CSS row. **Empty spacer columns**
(`<div />` used to right-align a tile) are KEPT as real span-carrying blocks
rather than dropped — that reproduces the visual exactly and round-trips
cleanly; a moved-away neighbor just lets the spacer reflow (a full-width empty
div renders as nothing). On the first apply the source container is replaced
by the equivalent marked arranger row (its own classes, e.g. `gap-8 mb-8`,
give way to the uniform 12-col/16px wrapper), after which everything is in
the canonical wrapper form — discover→apply→discover is stable.

**2. Static children move; expression children are pinned.**
`JSXElement`/`JSXFragment` children are deterministic, order-independent
nodes — safe to permute. `JSXExpressionContainer` children (`cond ? A : B`,
`xs.map(…)`, `flag && <X/>`) render a variable number of nodes; reordering
around or inside them is semantic guesswork. v1 pins them: they keep their
exact slots, and static blocks may not cross them (pinned blocks partition the
child list into independently-sortable segments). The engine enforces this in
`validateLayout`, and the UI uses that same function as its drop-validity
oracle — the UI literally cannot produce a layout the engine rejects.

**3. recast + @babel/parser for a formatting-preserving round-trip.**
A plain parse→transform→generate pipeline reformats the whole file, which
would (a) produce huge diffs against MotherDuck's stored source, and (b) risk
subtle changes in code we don't understand. recast reprints **only mutated
nodes**; imports, hooks, SQL strings, helpers, and comments keep their original
bytes. Verified by harness assertions on comment/helper byte-equality.
*Gotcha discovered:* recast tracks source parentheses — parsing wrapper
templates as `const t = (<div…/>);` re-emits the parens when the node is
grafted into JSX children, where they re-parse as literal `(`/`)` text nodes.
Templates are parsed without parens.

**4. Layout is expressed as wrapper `<div>`s with self-identifying markers.**
Reorder = child order. Side-by-side/resize = wrap the group in
`<div data-dive-arranger="row" style={{display:'grid', gridTemplateColumns:
'repeat(12, minmax(0,1fr))'}}>` with `data-dive-arranger="cell"` +
`data-arranger-span`/`data-arranger-h` wrappers (inline styles only — dive
runtimes disallow arbitrary-value Tailwind). Because the wrappers carry
markers, discovery **unwraps them on the next edit** and recovers the prior
spans/heights: arranging is idempotent, wrappers never nest or accumulate, and
deleting them restores the original structure. This mirrors (and generalizes)
the predecessor's `// dive-builder:layout` marker trick, but the layout lives
in the JSX itself instead of a comment.

**5. WYSIWYG = drag the real tiles, in place, inside the sandbox iframe.**
(Supersedes the original "static DOM snapshot cards" design: MotherDuck
renders dives inside a cross-origin sandboxed iframe —
`https://motherduckusercontent.com/sandbox/…`, `sandbox="allow-scripts
allow-same-origin"` — so the top-frame content script can never see the
rendered tiles, and every snapshot card degraded to a code card.) The fix is
architectural: a second content script (`dist/frame.js`, `all_frames: true`
with a `motherduckusercontent.com` host permission; `allow-same-origin` gives
the frame its real origin, so Chrome injects normally) runs INSIDE the iframe,
where the tiles actually are.

Mechanics, chosen to avoid fighting the dive's React:
- **Tile ↔ block mapping** (frame-map.mjs, pure): find the tile container
  (prior arranger `data-dive-arranger="row"` markers → anchor-text LCA →
  positional BFS backstop, gated by anchors), then align the container's
  element children to the model rows — wrappers strictly in order, anchored
  statics as fixed points, positional fill in between, pinned dynamics
  absorbing 0..n children. Unresolvable dives return null → card fallback.
- **Preview = explicit CSS-grid placement, not DOM reordering.** On entry the
  container gets `display:grid; grid-template-columns:repeat(12, minmax(0,
  1fr)); gap:16px` (the same 12-col/16px model apply.mjs writes) and every
  tile gets `grid-row` + `grid-column` from the layout model. Reorders,
  side-by-side joins, spans and heights are all pure style mutations — React's
  child order is never touched, so re-render breakage risk is confined to
  inline styles. The one structural exception: previous arranger row wrappers
  are unwrapped once on entry (cells lifted to container level), undo-logged.
- **Chrome, not surgery, for affordances**: grips/resize handles/outlines are
  fixed-position shadow-DOM elements tracking tile rects on rAF — nothing is
  inserted into React-owned subtrees.
- **Cancel restores everything** from the undo log (original inline style
  attributes + reverse reparenting).
- The engine's `validateLayout` (split into recast-free engine/validate.mjs)
  is bundled into the frame as the live drop-validity oracle; the top frame
  re-validates every proposal authoritatively and bounces invalid models back.
The top frame stays the source of truth (discover/apply/Submit); the iframe is
just the input device, reporting `{rows}` models over origin- and
sender-window-checked, nonced postMessage. The card overlay remains only as the fallback when the bridge or
mapping fails.

**6. SQL access = wasm-client injected into the page's MAIN world.**
MV3 makes wasm + blob workers painful in extension contexts (service workers
can't spawn Web Workers; extension-page CSP restricts blob: workers, which
duckdb-wasm needs). But the MotherDuck app itself runs duckdb-wasm, so its
page CSP already permits everything the client needs. The content script
injects `dist/md-main.js` (a `web_accessible_resource`) into the page and
talks to it over `window.postMessage` with origin + `source` tagging; the
statements for one logical operation run sequentially on one connection
(required for the `SET VARIABLE` → `MD_UPDATE_DIVE_CONTENT` pair). This is
also why the SQL builders live in `engine/mdsql.mjs`: the harness executes the
byte-identical statements over `@duckdb/node-api`, so the extension's SQL is
proven even though the wasm path itself wasn't driven headlessly.

**7. Content routing: base64 through a SQL variable.**
The predecessor avoided SQL-escaping JSX by writing it to a temp file and
using `read_text()`; a browser has no filesystem, so this project encodes the
content as UTF-8 base64 (charset inert inside a SQL string literal) and
decodes server-side: `SET VARIABLE dive_arranger_content =
decode(from_base64('…'))`. Dive ids are regex-validated as UUIDs before ever
being interpolated.

**8. No react-grid-layout; hand-rolled pointer-event drag.**
The predecessor documented that every react-grid-layout 1.5.x tarball ships a
stray compiled `ip_fetcher` Mach-O binary (curls ifconfig.me); 1.4.4 is the
last clean publish. Rather than pin it (and pull React into a content script
for a list-of-rows drag), the overlay implements drag/resize directly on
pointer events (~150 lines) over the same `{rows:[{cells:[{block,span,
heightPx}]}]}` model the engine consumes — no y-boundary inference needed, no
extra dependency, no supply-chain exposure. `node_modules` was scanned for
stray executables after install (only esbuild/duckdb platform binaries and
recast's example text scripts).

**9. Auth: reuse the tab's session where possible, options-page fallback.**
Content scripts share the page origin's `localStorage`/`sessionStorage`, so
discovery scans both for MotherDuck-shaped JWTs (payload has
`mdRegion`/`tokenType`/`tokenId`), including JWTs embedded in JSON blobs. This
is best-effort — if the app holds its token only in memory, the scan finds
nothing and the user pastes a token (short-lived preferred) into the Options
page (`chrome.storage.local`, machine-local, never committed). Prohibited by
design: hardcoding tokens, logging them, or writing them to files.

**10. Safety rails for write-back.**
Submit is the only write path; it backs its verification on byte-equal
read-back plus a re-parse (single default-export check). The harness only
writes to the dive it just created, with a hard denylist of the known real
dive ids on top, and deletes it in a `finally` block.

## Verification status (honest)

**Verified (live, against a throwaway MotherDuck dive — created and deleted
by the run):** the full engine round-trip. `MD_CREATE_DIVE` → `MD_GET_DIVE` →
discovery (5 blocks, kinds static/static/dynamic/static/static) →
`applyLayout` (reorder + 2-up row + heightPx) → `MD_UPDATE_DIVE_CONTENT` →
read-back byte-equal → comments/helpers byte-preserved → still one default
export → re-discovery unwraps to the same 5 blocks with spans/heights
recovered → second apply restores the original order with zero leftover
wrappers → `MD_DELETE_DIVE` confirmed. 24 assertions, plus 13 offline engine
tests, plus the engine executing correctly from the browser-target esbuild
bundle in a bare (Node-builtin-free) VM.

**Verified (Node, offline — `npm test`, 67 tests):** the engine suite
(including source-row decomposition: grid-cols-2/4, inline repeat(N,…), flex
rows, col-span scaling, spacer columns, dynamic-child and wrapping vetoes,
pin-crossing still rejected, and discover→apply→discover stability on a
chat-dive-shaped fixture); the shared move-model ops (layout-model.mjs); the
row-container classifier (rowcontainer.mjs); the tile↔block alignment matrix
(frame-map.mjs: positional, anchored, wrapper rows, dynamics rendering 0..n
nodes, inert interior statics, every failure mode returning null); and a
fake-DOM smoke of the REAL frame.js session — ARRANGE_INIT → INIT_ACK/MAPPED,
grid placement values, wrapper AND source-grid lift, drags (join / reorder /
extract, incl. extracting a tile out of a decomposed source grid), MODEL
re-place with untouched DOM order, ARRANGE_CANCEL restoring inline styles and
reparenting cells back into their wrappers/source grids, the MAPPED
ok:false retry path, and the bridge hardening (messages from non-parent
windows ignored; teardown mid-drag leaves the surviving pointer listeners
inert; a superseded INIT's mapping-retry loop goes dead instead of clobbering
the newer session).

**Not verified (needs a live Chrome session):** frame.js actually being
injected into the sandbox iframe by Chrome (manifest match patterns vs. the
real sandbox URL); tile-mapping quality against real rendered dives; the
in-place drag/resize pointer UX and chrome positioning; the top↔iframe
postMessage handshake timing on a real page; how gracefully the preview
survives a mid-session React re-render; token discovery against the real MD
app's storage; and the main-world wasm bridge under the app's CSP.
