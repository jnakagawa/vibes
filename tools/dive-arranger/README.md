# dive-arranger

A Chrome (Manifest V3) extension that lets you **visually rearrange the blocks
of any MotherDuck dive** — reorder, place side-by-side, resize, delete — and
write the new layout back to the dive's source. It works on arbitrary dives by **parsing
the dive's JSX source**, not by knowing its widgets in advance (that was the
limitation of its predecessor, [`dive-builder`](../dive-builder), which only
handled one hardcoded dive via a widget manifest).

## Install (load unpacked)

```bash
cd /Users/jonahnakagawa/github/dive-arranger
npm install
npm run build          # bundles extension code into dist/
```

Then in Chrome:

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this project root (the folder containing
   `manifest.json`).

## Use

1. Open a dive in `https://app.motherduck.com` (the dive id must be in the URL).
2. Click the floating **⠿ Arrange** button (bottom-right), or the extension's
   toolbar icon.
3. **In-place mode (the normal path).** The dive renders inside a sandboxed
   iframe (`motherduckusercontent.com`); the extension injects a script there,
   matches each rendered tile to its source block, and puts drag handles on
   the **real rendered tiles** — the dive looks exactly as MotherDuck renders
   it, plus subtle outlines and a `⠿` grip per tile. A slim toolbar appears at
   the bottom of the page.
   - **Drag** a tile by its `⠿` grip — into another tile's row (side-by-side)
     or into the gaps between rows (new full-width row). Only drops the engine
     would accept highlight as targets.
   - **Resize width** by dragging a tile's right edge (snaps to a 12-column
     grid). **Resize height** by dragging the bottom edge (double-click the
     bottom edge to reset to auto height).
   - **Delete** a tile with the `✕` next to its grip (prime use case: an
     empty spacer `<div/>` left over from a moved neighbor — but any draggable
     tile works). Safety rails: deletion is **preview-only** until Submit
     (the tile is hidden and its row re-flows; nothing is written); **Close
     restores it** like every other preview change; only **static** tiles are
     deletable — pinned dynamic blocks never get a `✕` (removing conditional
     or `.map()` output would change dive logic), and the engine refuses a
     layout missing a dynamic block; deleting the last remaining tile is
     refused (a dive can't be emptied). A **committed** delete is still
     recoverable from MotherDuck's server-side dive version history.
   - Tiles badged **pinned** (amber dashed outline) come from dynamic JSX — a
     conditional or a `.map()` at the top level. They are shown in place but
     cannot be moved or resized (v1 scope, see below).
   - The preview is live: tiles re-lay out in place as you drop/resize
     (style-only CSS-grid placement — the dive's React DOM order is never
     reordered). **Close** restores the original layout untouched.
4. **Card fallback.** Only if the iframe bridge can't be established or the
   tiles can't be mapped (e.g. the dive is still loading, or renders no
   recognizable container), the old full-screen card overlay opens instead,
   with code-excerpt cards. Same drag model, degraded preview.
5. **View code** shows the exact source Submit would write.
6. **Submit to MotherDuck** regenerates the dive source, writes it back with
   `MD_UPDATE_DIVE_CONTENT`, reads it back, and verifies the round-trip.
   Nothing is ever written without clicking Submit.

## How it works

- **Fetch**: the dive source comes from `MD_GET_DIVE(id := …)` — a real
  MotherDuck SQL call from the page, not DOM scraping. The id is taken from
  the URL.
- **The generic block model**: a dive is a single default-export React
  component. The extension parses the source (recast + `@babel/parser`), finds
  the component's returned root JSX element, and treats its **top-level child
  nodes** as the rearrangeable blocks. Static child elements are draggable;
  children produced by expressions (`cond ? … : …`, `list.map(…)`, `x && …`)
  are pinned. A top-level child that is itself a **multi-column row container**
  in the dive's own source (`grid grid-cols-N`, an inline
  `gridTemplateColumns`, or a flex row) is decomposed one level: its element
  children become separate side-by-side blocks (`grid-cols-2` → 6/6 spans),
  each independently movable — empty spacer columns (`<div />`) are kept as
  blocks so the row's alignment survives the round-trip.
- **Rearranging** reorders those child nodes. Side-by-side placement wraps a
  group in a `<div data-dive-arranger="row" style={{display:'grid', …}}>` with
  span/height cells; the `data-dive-arranger` markers let the extension
  **unwrap its own wrappers on the next edit**, so repeated arranging never
  nests or accumulates.
- **Everything else is untouched**: recast round-trips the file, so imports,
  hooks, SQL queries, helpers, and comments keep their exact original text —
  only the moved nodes are reprinted.
- **The in-place preview** runs inside the dive's sandbox iframe
  (`dist/frame.js`, injected via `all_frames` + a `motherduckusercontent.com`
  host permission). It finds the tile container (arranger wrapper markers →
  anchor-text LCA → positional backstop), aligns the container's children to
  the source blocks (Nth tile ↔ Nth block, anchored by distinctive strings and
  tolerant of pinned dynamics rendering 0..n nodes), then switches the
  container to an explicit 12-column CSS grid and places every tile from the
  layout model. Reorders/resizes are pure style changes (`grid-row` /
  `grid-column`), so the dive's React tree is never re-ordered; previous
  arranger row wrappers are unwrapped once (undo-logged) on entry. The iframe
  reports each committed mutation to the top frame over origin-checked
  `postMessage`; the top frame validates it with the engine's `validateLayout`
  and replies with the authoritative model. The top frame owns the source and
  Submit; the iframe is only the input device.
- **Card fallback** (top frame, only when in-place mode fails): static cards
  per block with code excerpts — the cross-origin iframe means rendered
  snapshots are unavailable there.
- **Write-back**: content is routed as base64 through a SQL variable
  (`SET VARIABLE … = decode(from_base64('…'))` →
  `MD_UPDATE_DIVE_CONTENT(id := …, content := getvariable(…))`), so dive JSX
  never needs SQL-literal escaping. After writing, the dive is read back and
  byte-compared, and the result is re-parsed to confirm it is still a single
  default-export component.

## Auth

The SQL runs through `@motherduck/wasm-client` injected into the
app.motherduck.com page itself (main world), under the same CSP the MotherDuck
app uses for its own duckdb-wasm workers. Tokens are picked by an
**expiry-aware resolver** (`extension/token.mjs`, pure and unit-tested):

- **Candidates**: every MotherDuck-shaped JWT (payload containing
  `mdRegion`/`tokenType`/`tokenId`) in the tab's
  `localStorage`/`sessionStorage` (source `page`), plus the token pasted in
  the extension's Options page (`chrome.storage.local` only, source
  `fallback`; a short-lived read/write token from the MotherDuck MCP
  `get_short_lived_token` works and is the safest choice).
- **Selection**: candidates that are expired — or within a 45 s safety skew
  of expiring — are dropped *before* selection (a near-dead token is never
  picked); survivors rank `page` before `fallback`, then by most time left.
  A JWT with no `exp` claim counts as non-expiring.
- **Preflight**: before the arranger opens, a `SELECT 1` validates the chosen
  token, so a dead token surfaces as an actionable message ("refresh the
  MotherDuck tab…") instead of a cryptic wasm/DuckDB dump mid-flow.
- **Re-resolve on rotation**: if a query later fails with an auth-classified
  error (the MD app rotates its session token, so a token that was valid at
  launch can die mid-session), the resolver re-scans storage and retries
  **once** with the fresh token — only if it actually differs from the one
  that just failed. Non-auth errors pass through unchanged.
- **Transparency**: the arranger toolbar shows an auth line —
  `auth: page session · exp 3:47pm` — which turns amber when under 5 minutes
  remain. It shows only the token's source and expiry, never the token.

Auth errors are classified (`expired` / `scope` / `network` / `unknown`,
defaulting to `unknown`) and rendered as short actionable instructions rather
than raw error dumps. No token is ever hardcoded, committed, logged, or sent
anywhere other than api.motherduck.com by the wasm client; error strings from
the wasm bridge are token-scrubbed before they can reach any UI surface.

## Verifying the engine (Node harness, no browser needed)

The parse → rearrange → print → write-back → read-back pipeline is verified
end-to-end against a **throwaway dive the harness creates and deletes itself**
(it never touches pre-existing dives, and carries a denylist of known real
dive ids as a second guard):

```bash
npm test                                    # 104 pure tests (engine + frame logic + fake-DOM frame session + token resolver), no network
MOTHERDUCK_TOKEN=<short-lived token> npm run roundtrip
```

The round-trip run creates a dive via `MD_CREATE_DIVE`, discovers its 5 blocks,
applies a reorder + two-up row + height resize, writes back, re-reads, asserts
order/wrappers/comment-preservation/single-default-export, applies a second
layout restoring the original order (proving wrapper idempotence), and deletes
the dive — 24 assertions.

## v1 scope and explicit limits

- **Only static top-level children of the root element are draggable — or
  deletable.** Dynamic top-level children (conditionals, `.map()`s) are
  pinned: visible, never moved, never resized, never deleted, and static
  blocks cannot be dragged **across** them (they act as fixed separators).
  Anything *inside* a block — including nested conditionals and maps — moves
  (or is deleted) with its block, untouched. `validateLayout` enforces all of
  this: a layout may omit static blocks (that's a delete) but must contain
  every dynamic block.
- **Source row containers decompose exactly one level.** The children of a
  top-level `grid grid-cols-N`/flex-row container become individual blocks
  (spans derived from the template); there is no deeper recursion. A row
  container with a dynamic (`? :`/`.map()`) or text child, non-host
  (`<Card/>`) children, or more children than its columns stays ONE opaque
  block, exactly as before. After the first Submit the source container is
  replaced by the arranger's own marked row wrapper (uniform 16px gap — the
  container's own `gap-*`/`mb-*` classes are not carried over).
- **One top-level layout container.** If the root only has a single child
  (e.g. a provider wrapper), the arranger descends up to 4 levels to find the
  real container; beyond that, the dive is reported as unsupported.
- **Style-only preview, not a re-render.** The in-place preview repositions
  the tiles the dive already rendered; it does not re-execute dive JSX. Row
  spacing in the preview is a uniform 16px grid gap, which can differ slightly
  from the container's own spacing after Submit + reload. If the dive's React
  re-renders mid-session (e.g. interactive state changes), the preview styles
  on re-created nodes may be lost — Close/reopen the arranger to recover.
- Component must `return <jsx>` at the top level of its body (early loading
  guards are fine; a component whose *final* return is a conditional
  expression is not supported).
- The in-browser UX (iframe script injection, tile mapping quality on real
  dives, the drag pointer UX, the postMessage bridge, the wasm bridge, token
  resolution against the real MD app's storage) has **not** been exercised
  end-to-end in a real Chrome session —
  the engine, the SQL, the alignment logic, and the frame session protocol are
  verified by the Node harness/tests; the live browser parts are not (see
  DESIGN.md "Verification status").

## v2 ideas

- **Live re-render preview**: execute the dive component in a sandboxed iframe
  with a `useSQLQuery` shim (the dive-builder predecessor proves the shim
  works) for true WYSIWYG during dragging.
- **Nested layouts**: recurse the block model into a selected block, so
  arbitrarily deep sub-grids can be rearranged too (top-level source grid/flex
  rows already decompose one level).
- Reorder *within* `.map()`s and swap conditional branches.
- Layout history / one-click restore from MotherDuck's server-side dive
  versions.

## Repo layout

```
manifest.json        MV3 manifest (project root = the unpacked extension)
engine/              the AST engine (shared by extension + harness)
  discover.mjs         parse + generic block discovery (+ wrapper unwrap)
  apply.mjs            AST rewrite + recast print
  validate.mjs         layout validation (recast-free; bundled into frame.js)
  rowcontainer.mjs     source row-container classifier (shared JSX + DOM sides)
  mdsql.mjs            MD_GET_DIVE / MD_UPDATE_DIVE_CONTENT SQL builders
extension/
  content.js           top-frame content script: auth resolution, wasm bridge, launch
  token.mjs            pure token resolver: expiry-aware JWT selection,
                       auth-error classification, user-facing auth strings (Node-tested)
  insitu.js            top-frame controller for in-place mode (toolbar, Submit)
  frame.js             IN-IFRAME script: tile mapping + drag/resize on real tiles
  frame-map.mjs        pure tile↔block alignment (Node-tested)
  layout-model.mjs     pure move/copy model ops shared by both UIs (Node-tested)
  overlay.js           card-overlay fallback UI
  snapshot.js          DOM snapshot helpers (fallback overlay only)
  md-main.js           MAIN-world wasm client bridge
harness/             engine + frame-logic + fake-DOM tests, live MD round-trip
build.mjs            esbuild bundling → dist/ (content, frame, md-main, background)
```
