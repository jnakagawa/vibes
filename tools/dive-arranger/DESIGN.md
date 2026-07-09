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
├─ dist/token-sniffer.js  (MAIN world, document_start, via manifest)
│   └─ patches fetch/XHR/WebSocket BEFORE the app's scripts run; lifts the
│       app's OWN live MD token out of its auth traffic and relays it to
│       content.js via same-origin postMessage (source `live`)
├─ dist/content.js  (isolated world)
│   ├─ engine/ (bundled): discover → validate → apply → print
│   ├─ insitu.js: in-place mode controller — toolbar, proposal validation,
│   │   Submit; postMessage bridge to the dive iframe (origin-checked, nonced)
│   ├─ overlay.js + snapshot.js: card-overlay FALLBACK (only when the iframe
│   │   bridge / tile mapping fails)
│   └─ token resolver (token.mjs, pure): expiry-aware selection over ALL
│       candidates — the live captured token, page-storage JWTs, the Options
│       fallback (ranked live>page>fallback); SELECT 1 preflight; one
│       re-resolve retry on auth failure (token rotation)
├─ dist/md-main.js  (MAIN world, injected on demand)
│   └─ @motherduck/wasm-client: runs MD_GET_DIVE / MD_UPDATE_DIVE_CONTENT
│       (postMessage bridge to the content script)
├─ <iframe sandbox src=https://motherduckusercontent.com/sandbox/…>
│   └─ dist/frame.js (isolated world, injected via all_frames): the dive's
│       rendered tiles live HERE (cross-origin). Maps tiles ↔ source blocks
│       (frame-map.mjs), grids the container, draws drag/resize/delete chrome
│       on the REAL tiles, validates drops with engine/validate.mjs (recast-free
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
- **Chrome, not surgery, for affordances**: grips/delete ✕/resize handles/
  outlines are fixed-position shadow-DOM elements tracking tile rects on rAF —
  nothing is inserted into React-owned subtrees.
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
*Superseded in part by #12: the one-shot "first JWT wins" grab became an
expiry-aware resolver over all candidates.*

**10. Safety rails for write-back.**
Submit is the only write path; it backs its verification on byte-equal
read-back plus a re-parse (single default-export check). The harness only
writes to the dive it just created, with a hard denylist of the known real
dive ids on top, and deletes it in a `finally` block.

**11. Delete = a layout that omits the block (statics only).**
Deleting a tile (prime use case: an empty spacer `<div/>` orphaned by a moved
neighbor) needed almost no engine surface: `applyLayout` already rebuilds the
root's children *only* from `layout.rows`, so a block absent from the layout
has its node dropped from the output automatically, and the post-apply
self-check compares against `validateLayout`'s returned `flat` — which only
contains blocks the layout references. The one real change is in
`validateLayout`: a **static** block may now be absent (that is a delete); a
**dynamic** block that is absent still throws (deleting conditional/loop
output would change dive logic — dynamics stay pinned, full stop). The
segment rule is unaffected by deleted statics: segments are numbered by the
dynamics, which must all remain, in order, so cross-pin moves are still
rejected in a layout that also deletes.
Safety rails, layered:
- **UI**: the `✕` control is rendered only on draggable (static) tiles —
  pinned and inert tiles never get one; `removeBlock` (layout-model.mjs,
  pure) refuses to produce an empty layout, so the last remaining tile
  cannot be deleted; the frame re-checks every delete against the
  engine-validate oracle before applying it.
- **Preview-only**: a delete just hides the element (`display:none` on top of
  its undo-captured inline style) and drops it from the session model —
  `layoutFrame` keeps deleted elements hidden across every re-layout, and the
  existing Cancel/teardown path restores the element, its style, and any
  source grids untouched. Nothing is written until Submit.
- **Authoritative re-validation**: the top frame re-validates the proposed
  (now smaller) model with the same `validateLayout` before accepting it.
- **Recoverable after commit**: MotherDuck keeps server-side dive version
  history, so even a submitted delete can be restored.
Post-Submit, re-discovery compacts block ids, so a kept block's new id can
collide with the deleted block's old id; the frame's idMap remap drops the
deleted block's stale tile handle (it has no idMap entry) instead of letting
it shadow a kept block, and clears the session's deleted-set — the element
simply stays hidden, matching the new source until reload.

**12. Token resolver: expiry-aware selection, preflight, one re-resolve retry.**
The original grab (decision 9) took the FIRST MotherDuck-shaped JWT it saw and
never looked at the `exp` claim or re-read storage — so an expired token could
be picked over a live one, and a short-lived token that died mid-session made
Submit fail with a raw wasm dump even though the MD app had already rotated a
fresh token into the very storage we scanned at launch. The fix is a pure
resolver core (`extension/token.mjs`, fully unit-tested, takes `nowMs` as a
parameter — `Date.now()` stays in content.js so the module is deterministic):
- `tokenInfo` decodes the JWT payload and derives `{exp, expired, msLeft}` —
  JWT `exp` is in seconds (×1000); no `exp` claim means non-expiring; anything
  with under `SKEW_MS` (45 s) left counts as expired, because by the time the
  wasm client connects it would be dead anyway.
- `resolveToken` ranks ALL candidates (every page-storage JWT, tagged `page`,
  plus the Options token, tagged `fallback`): expired/near-expiry dropped
  first, then `page` before `fallback` (the page token is the one the app
  itself keeps fresh), then max `msLeft`. Null when nothing usable remains —
  which produces a "no unexpired token" alert with instructions, not a crash.
- **Preflight**: `launch()` runs `SELECT 1` through the resolved token before
  opening any UI; failures are classified and alerted with an actionable
  message, so bad auth can never masquerade as a broken dive.
- **Re-resolve on failure**: the `runQueries` wrapper classifies each bridge
  error (`classifyAuthError`: expired/scope/network/unknown, string
  heuristics, DEFAULT unknown so the arranger's own pipeline errors are never
  misdrawn as auth); on expired/scope it re-scans storage and retries exactly
  once, and only if the freshly-resolved token differs from the one that just
  failed — no different token means the original classified error surfaces;
  there is no loop. A successful retry adopts the fresh token for the rest of
  the session and updates the UI's auth descriptor in place.
- **Transparency without exposure**: the UIs receive `{source, exp}` only —
  the token never leaves content.js's closure — and render an auth line
  (`auth: page session · exp 3:47pm`, amber under 5 min, re-rendered on an
  interval so rotation and aging show up). Auth failures in Submit set the
  status to the actionable `authMessage` string; non-auth errors pass through
  verbatim. The md-main bridge already scrubs the token out of error text
  before it can reach any of these surfaces.

**13. Live token capture via a MAIN-world transport interceptor.**
Live recon of the current MotherDuck app found that decision 9/12's storage
scan has a fatal blind spot: the app authenticates via Auth0 **httpOnly
cookies** (invisible to JS) and keeps its DuckDB/MD access token **in memory** —
there is **no JWT in localStorage/sessionStorage/IndexedDB to scan**. The app
fetches its token once at page load and hands it straight to
`@motherduck/wasm-client`. So the storage-scan primary path silently finds
nothing on the real app and falls back to the (often expired) Options token —
the exact expiry treadmill decision 12 tried to escape. The only place the
token is observable is the transport layer, as the app fetches (and
auto-refreshes) it.
- **`extension/token-sniffer.js`** — a **MAIN-world, `document_start` content
  script injected via the manifest** (not the on-demand `<script>` tag from
  decision 9, which runs post-load and would miss the load-time token fetch).
  Running in the app's own realm before its scripts, it patches `window.fetch`,
  `XMLHttpRequest` (`open`/`setRequestHeader`/`send` + `responseText` on load),
  and `WebSocket` (connect URL). It inspects request `Authorization` /
  `x-motherduck-*` headers, token-endpoint response bodies (via a fire-and-
  forget `clone()`), and flight/query socket URLs for a MotherDuck-shaped JWT.
- **`extractMdJwt(str)`** (token.mjs, pure + unit-tested) does the lifting:
  scan every JWT-looking substring, return the first whose payload passes
  `isMdJwt` (`mdRegion || tokenType || tokenId`) — so Auth0/other-IdP JWTs in
  the same traffic are ignored. The sniffer keeps the longest-lived token seen
  (the app's refresh issues a later-`exp` token) and relays it to content.js
  over **same-origin `postMessage`** (`{source:"dive-arranger-token", token}`,
  `location.origin`). content.js validates `event.source === window` and
  `event.origin === location.origin`, holds it in memory tagged `live`, and
  `gatherCandidates()` offers it first.
- **`resolveToken` ranks `live` > `page` > `fallback`.** The live token is the
  app's own auto-rotating credential, so it's the freshest and removes the
  expiry treadmill — but it goes through the SAME expiry gate, so an expired
  `live` token is dropped in favor of a valid `page`/`fallback` one. The
  toolbar shows `auth: live session · exp …` when it wins.
- **Non-breaking is a hard requirement** — the sniffer runs on EVERY
  app.motherduck.com page for all public-beta users. It installs once (guard
  flag), wraps every patch in `try/catch`, ALWAYS delegates to the original
  fetch/XHR/WebSocket, never awaits response clones inline (zero added latency
  on the hot path), and never throws. If any patch fails to install it leaves
  that API untouched.
- **Security posture:** the captured token is NEVER logged (`console.*`),
  persisted, thrown, or placed in any user-visible string. It lives only in
  the sniffer's `bestToken` closure and content.js's `liveToken` variable, and
  moves only via the same-origin `postMessage`. The UI auth descriptor stays
  `{source, exp}` — token-free — exactly as decision 12 established.

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

**Verified (Node, offline — `npm test`, 114 tests):** the engine suite
(including source-row decomposition: grid-cols-2/4, inline repeat(N,…), flex
rows, col-span scaling, spacer columns, dynamic-child and wrapping vetoes,
pin-crossing still rejected, and discover→apply→discover stability on a
chat-dive-shaped fixture); block deletion (a layout omitting a static block —
incl. the spacer `<div/>` — round-trips with one fewer block, the deleted
node and its text gone, the sibling re-flowed; omitting a dynamic throws;
delete adjacent to a pin validates while a cross-pin move still fails); the
shared move-model ops (layout-model.mjs, incl. `removeBlock` re-flow /
empty-row drop / last-tile no-op); the row-container classifier
(rowcontainer.mjs); the tile↔block alignment matrix
(frame-map.mjs: positional, anchored, wrapper rows, dynamics rendering 0..n
nodes, inert interior statics, every failure mode returning null); and a
fake-DOM smoke of the REAL frame.js session — ARRANGE_INIT → INIT_ACK/MAPPED,
grid placement values, wrapper AND source-grid lift, drags (join / reorder /
extract, incl. extracting a tile out of a decomposed source grid), tile
delete via ✕ (PROPOSE shrinks, element hidden, no ✕ on pinned/inert tiles,
last-tile refusal, post-Submit idMap remap with a committed delete, Cancel
restoring the element + inline style), MODEL
re-place with untouched DOM order, ARRANGE_CANCEL restoring inline styles and
reparenting cells back into their wrappers/source grids, the MAPPED
ok:false retry path, and the bridge hardening (messages from non-parent
windows ignored; teardown mid-drag leaves the surviving pointer listeners
inert; a superseded INIT's mapping-retry loop goes dead instead of clobbering
the newer session); and the token resolver core (token.mjs: JWT decode on
valid/garbage input, sec→ms exp parsing, near-expiry-within-skew treated as
expired, no-exp ⇒ non-expiring, expired candidates dropped, `live`-over-`page`-
over-`fallback` then max-msLeft ranking incl. live beating an equally-fresh
page token and an expired live token dropped for a valid page/fallback,
`extractMdJwt` lifting an MD JWT from a Bearer header / JSON body / ws URL and
ignoring non-MD JWTs, `sourceLabel` mapping, null on nothing usable, every
classifyAuthError bucket incl. the unknown default on the arranger's own error
strings, and the local-time expiry formatting).

**Not verified (needs a live Chrome session):** frame.js actually being
injected into the sandbox iframe by Chrome (manifest match patterns vs. the
real sandbox URL); tile-mapping quality against real rendered dives; the
in-place drag/resize pointer UX and chrome positioning; the top↔iframe
postMessage handshake timing on a real page; how gracefully the preview
survives a mid-session React re-render; token resolution against the real MD
app (incl. whether the rotated session token actually lands in
local/sessionStorage for the re-resolve path to find); the **live token-sniffer
capture** — whether the MAIN-world `document_start` script actually intercepts
the app's token fetch and relays a working `live` token end-to-end (the
extraction logic is unit-tested, but the DOM/network patching and the app's
real token-endpoint shape need a live-browser reload to validate); the
main-world wasm bridge under the app's CSP; and `classifyAuthError`'s string
heuristics
against real MotherDuck/wasm error text (the buckets are regex guesses —
expired ≈ /expired|jwt|unauthor|invalid token|401/, scope ≈
/read-?only|permission|forbidden|not allowed|403|write/, network ≈
/network|fetch|connect|timed out|offline/ — defaulting to 'unknown', which
passes the raw scrubbed message through).
