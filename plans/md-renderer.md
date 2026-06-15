# Plan: Markdown raw / hybrid / rendered view modes

Status: draft · Branch: `feat/md-renderer` · Worktree: `../md-renderer`

## Goal

When a Markdown file (`.md` / `.markdown`) is the active tab, let the user switch
between three view modes from a per-tab action area on the right side of the tab
bar (the WebStorm placement shown in the reference screenshot):

- **Raw** — the existing Monaco editor only (editable, saves as today).
- **Hybrid** — Monaco on the left, rendered preview on the right, with
  scroll-anchored synchronization between the two.
- **Rendered** — rendered preview only.

The control is a `ToggleButtonGroup` of three icon buttons, shown only when the
active tab is a Markdown file. Non-Markdown tabs show no view-mode control.

## Current architecture (what we're building on)

- **Tab bar**: `src/renderer/components/layout/PaneTabBar.svelte` — a horizontally
  scrolling flex row of tabs. It already receives `tabs`, `activeId`, `peekId`,
  `unread` and callbacks. It has **no right-side action area today** — tabs fill
  the whole strip.
- **Tab content host**: `src/renderer/components/layout/TabContainer.svelte` —
  switches on `tab.kind`; `kind === 'file'` renders `<CodeEditor>`.
- **Editor**: `src/renderer/components/editor/CodeEditor.svelte` — Monaco wrapper.
  Loads file content via `editor:open` IPC, saves via `editor:save`, emits
  `onModified(path, modified)`. Reuses Monaco models keyed by `monaco.Uri.file(path)`.
  Already maps `.md` → `markdown` language.
- **Tab model + store**: `src/renderer/stores/tabsStore.svelte.ts` — per-worktree
  tab list. `FileTab` = `{ kind, id, path, modified }`. Tab state is in-memory,
  shared across panes that show the same worktree.
- **Existing markdown rendering**: `src/renderer/components/composed/ProseBlock.svelte`
  does `{@html props.content}` with `prose` classes, but **no parser is wired**
  (it has a TODO to add `marked` + DOMPurify) and **`@tailwindcss/typography` is
  not installed**, so `prose` classes are currently no-ops. We will fix both as a
  side benefit.
- **Dependencies**: `marked@16.4.2` is present only **transitively** (via
  `mermaid`). `dompurify` and `@tailwindcss/typography` are **not** installed.

## Dependencies to add

Use `pnpm` (never npm). Per CLAUDE.md, `prose` styling is the idiomatic path.

```bash
pnpm add marked dompurify
pnpm add -D @types/dompurify @tailwindcss/typography
```

- `marked` — promote from transitive to a direct dependency (relying on a
  transitive is fragile across mermaid bumps).
- `dompurify` — sanitize parsed HTML before `{@html}`. Even though files are
  local/trusted, Markdown may embed raw `<script>`/`<iframe>`; in a renderer this
  is an XSS vector. Runs against the renderer DOM.
- `@tailwindcss/typography` — register in `src/renderer/app.css` with
  `@plugin "@tailwindcss/typography";` (Tailwind v4 syntax) so `prose` works.
  This also un-breaks `ProseBlock`'s existing classes.

Mermaid diagrams and fenced-code syntax highlighting (§5) need **no new deps** —
`mermaid` is already a dependency (used by `composed/Diagram.svelte`) and
`monaco-editor` is always loaded.

A changeset (`minor`) is required — see CLAUDE.md "Adding changesets" (create the
file directly, never run `pnpm changeset`).

## Design

### 1. View-mode state lives in a separate store, keyed by path

`FileTab` is the generic file-tab shape; it must **not** carry a Markdown-specific
`viewMode` field (that would leak a per-format concern into the shared tab model).
Instead, keep the view mode in a small dedicated store and read it where needed.

New `src/renderer/stores/markdownView.svelte.ts`:

```ts
export type MarkdownViewMode = 'raw' | 'hybrid' | 'rendered'

let _modes = $state<Map<string, MarkdownViewMode>>(new Map())
let _lastChosen: MarkdownViewMode = 'rendered' // remembered default for the session

export const markdownViewStore = {
  /** Mode for a file, falling back to the most-recently-chosen mode. */
  get(path: string): MarkdownViewMode { /* _modes.get(path) ?? _lastChosen */ },
  set(path: string, mode: MarkdownViewMode): void { /* update map + _lastChosen */ },
  forget(path: string): void { /* optional cleanup on tab close */ },
}
```

- **Keyed by absolute file path.** File `tabId`s are `file:<absolute-path>`, so a
  path is unique across worktrees, and two panes showing the same worktree share
  the same path → they share the view mode (matches the shared tab list).
- **Default mode** = the most-recently-chosen mode for the session (`_lastChosen`,
  initial **`'rendered'`** to match the screenshot). No per-tab plumbing in
  `WorktreePane.openFile` needed — first read just returns the remembered default.
- In-memory only (consistent with the rest of the tab model — no cross-session
  persistence in scope).

This justifies a store per CLAUDE.md ("stores only for truly global state"): the
toggle (in `PaneTabBar`/`TabActions`) and the content (`MarkdownView` under
`TabContainer`) live in sibling subtrees and must agree on the mode. Both read and
write `markdownViewStore` directly given the file path — no prop threading.

`tabsStore.svelte.ts` is **unchanged** by this feature.

### 2. Markdown detection helper

New `src/renderer/lib/markdown.ts`:

```ts
export function isMarkdownPath(path: string): boolean // .md, .markdown (case-insensitive)
export function renderMarkdown(src: string): string   // marked -> DOMPurify -> html, with line anchors
```

`renderMarkdown` configures a `marked` instance and annotates **block-level**
elements with `data-source-line="<1-based start line>"` for scroll sync (see §6),
then sanitizes with DOMPurify (allowing the `data-source-line` attribute).

### 3. Tab-bar action area (WebStorm placement)

Restructure `PaneTabBar.svelte`:

- Wrap the existing tab `{#each}` in a `flex-1 overflow-x-auto` container.
- Add a `flex-none` action region pinned to the right, rendering a new `TabActions`
  component for the **active** tab — but **only when that tab actually has actions**.
  When there are no actions the region (and any separator) is not rendered at all,
  so the tab strip looks exactly as it does today. A separator border is optional;
  if used at all it appears only when actions are present. Default to **no border**
  (just padding) and revisit during visual review.

New prop on `PaneTabBar`:
- `activeTab: Tab | null` (derive from `tabs` + `activeId`, or pass it down — prefer
  passing to avoid a second lookup).

No `onsetviewmode` prop is needed: `TabActions` reads and writes `markdownViewStore`
directly (§1).

New component `src/renderer/components/layout/TabActions.svelte`:
- Receives `tab`.
- Renders the markdown `ViewModeToggle` **only** when
  `tab?.kind === 'file' && isMarkdownPath(tab.path)`, reading/writing the current
  mode via `markdownViewStore`. Renders nothing otherwise.
- Structured so other tab kinds can contribute actions later (this is the generic
  "current-tab actions" slot, like WebStorm). The kebab/overflow menu in the
  screenshot is **out of scope**.
- Expose a tiny `tabHasActions(tab): boolean` helper (currently `tab.kind === 'file'
  && isMarkdownPath(tab.path)`) so `PaneTabBar` can gate the action region/border
  without duplicating the condition.

New component `src/renderer/components/layout/ViewModeToggle.svelte`:
- Three icon buttons (raw = horizontal-lines glyph, hybrid = split-pane glyph,
  rendered = eye/preview glyph), inline SVGs.
- `role="group"`, each button `aria-pressed={mode === current}`, `title` tooltips,
  `data-testid="md-view-toggle"` / `data-mode="raw|hybrid|rendered"` for E2E.
- Active button highlighted (match the existing `bg-zinc-950 text-zinc-200`
  active styling used for tabs).
- Presentational: props `current: MarkdownViewMode` + `onsetmode(mode)`. `TabActions`
  binds these to `markdownViewStore.get(path)` / `markdownViewStore.set(path, mode)`.

`WorktreePane.svelte` only needs to pass `activeTab` down to `PaneTabBar`. No
view-mode handler is threaded through — the store is the source of truth.

### 4. Content rendering: new `MarkdownView` wrapper

`TabContainer.svelte`: when `tab.kind === 'file' && isMarkdownPath(tab.path)`,
render `<MarkdownView>` instead of `<CodeEditor>` directly. Non-markdown files keep
rendering `<CodeEditor>` exactly as today.

New `src/renderer/components/editor/MarkdownView.svelte`:
- Props: `filePath`, `worktreeRoot`, `onModified`, `ondiscusswithagent`, `onOpenFile`.
- Reads the active mode reactively: `let viewMode = $derived(markdownViewStore.get(filePath))`.
- Owns `content = $state('')` — the single source of truth for the preview text.
- Layout by `viewMode`:
  - `raw` → `<CodeEditor … oncontentchange={(v) => content = v} />` full width.
  - `hybrid` → `<CodeEditor … />` left + `<MarkdownPreview source={content} />`
    right, with a draggable splitter (reuse the resize-handle pattern already in
    `WorktreePane`) and scroll sync (§6).
  - `rendered` → `<MarkdownPreview source={content} />` full width; **no CodeEditor
    mounted**.

**Live-content correctness** (the subtle part):
- In `raw`/`hybrid`, `CodeEditor` is mounted and drives `content` via a new
  `oncontentchange` callback (see §7), so the preview reflects unsaved edits live.
- Switching `hybrid → rendered` keeps the last in-memory `content` (preview stays
  correct even with unsaved edits) because `MarkdownView` retains `content` across
  mode changes.
- In `rendered` mode with no prior editor session (e.g. file opened straight into
  rendered), `MarkdownView` loads `content` via `window.api.invoke('editor:open', path)`.
  A `loadedFromEditor` flag prevents a disk re-load from clobbering unsaved edits when
  switching back into rendered. No per-file content-change event exists in the IPC
  surface today, so live refresh of an externally-edited file while sitting in
  rendered-only mode is out of scope (toggle modes to reload) — a watcher channel
  would be a separate main-process follow-up.

New `src/renderer/components/editor/MarkdownPreview.svelte`:
- Props: `source: string`, `filePath` (to resolve relative links/images),
  `worktreeRoot`, `onOpenFile`.
- `let html = $derived(renderMarkdown(source))` → `<div class="prose prose-invert
  prose-sm max-w-none …">{@html html}</div>` in a scrollable, padded container on
  the editor's dark background (`bg-zinc-950`).
- After the HTML mounts, runs the code-block enhancement pass (§5) over the
  container to render mermaid diagrams and syntax-highlight fenced code.
- In hybrid mode the preview tracks live edits, so **debounce** the
  `source → html` recompute (~150 ms) to avoid re-parsing on every keystroke; the
  enhancement pass is keyed off a render token so stale async work is discarded.
- Link handling: intercept anchor clicks. `http(s)` → open externally if a
  bridge API exists (else `preventDefault`); in-repo relative links → `onOpenFile`
  when resolvable; everything else `preventDefault` (preview is read-only). Confirm
  whether an `app:open-external` IPC exists; if not, v1 just `preventDefault`s and
  this becomes a follow-up.
- **Image handling** (§5b): rewrite relative `<img src>` (and the GFM `<img>`s
  marked emits) to an absolute resource URL resolved against `dirname(filePath)`,
  served through the worktree-asset protocol. Leave `http(s)://` and `data:` srcs
  untouched.

### 5. Code-block enhancement: mermaid + syntax highlighting

Both reuse dependencies that are **already present** (no new deps) and run entirely
in the renderer, so they ship in v1. Implemented as a single post-mount pass in a
new helper `src/renderer/lib/markdown-enhance.ts`:

```ts
export async function enhanceCodeBlocks(root: HTMLElement, token: number, isCurrent: (t: number) => boolean): Promise<void>
```

`renderMarkdown` leaves fenced code as `<pre><code class="language-<info>">`. The
pass walks those blocks:

- **Mermaid** (`language-mermaid`): reuse the exact pattern from
  `composed/Diagram.svelte` — lazy `import('mermaid')`, `mermaid.initialize({
  startOnLoad: false, theme: 'dark', securityLevel: 'strict' })`, then
  `mermaid.render(id, code)` and replace the `<pre>` with the returned `{svg}`.
  Unlike the gen-ui path, the source is the raw fenced text (real mermaid DSL), so
  we skip `compileSequenceDiagram` and pass the code straight through. On parse
  error, leave the original code block and show an inline error (same red-box
  styling as `Diagram.svelte`).
- **Other languages**: `await monaco.editor.colorize(code, langId, {})` and swap in
  the themed HTML. Monaco is always loaded (the editor uses it), so its token CSS
  (`.mtk*`, `vs-dark`) is already on the page and the output is correctly themed.
  Map the fence info string to a Monaco language id via a small alias table
  (`ts→typescript`, `js→javascript`, `py→python`, `sh→shell`, …); unknown/blank →
  leave as-is (prose already styles `<pre>` legibly). Best-effort: any failure
  leaves the plain block.

The pass is async and idempotent-per-render: callers pass a `token`; each block
swap checks `isCurrent(token)` before touching the DOM so a newer render (live
edit) cancels stale work.

**Sanitization note:** mermaid SVG and colorized spans are injected *after*
DOMPurify has run on the markdown. This is safe because mermaid `securityLevel:
'strict'` sanitizes its own SVG and `monaco.editor.colorize` only wraps our own
already-escaped code in styled `<span>`s — neither reintroduces author HTML.

### 5b. Relative images via a worktree-asset protocol

Markdown commonly references images by relative path (`![](./diagram.png)`). The
rewrite (`./diagram.png` → absolute resolved path) is the right mechanism, but a
bare `file://` `<img>` only works in the packaged build (`loadFile` → `file://`
page); in `pnpm dev` the renderer is served from `http://localhost`, and the
default `webSecurity` blocks an `http` page from loading `file://` subresources. A
tiny custom protocol works in **both** environments and sidesteps Windows
`file:///C:/…` path quirks.

Main process — new `src/main/asset-protocol.ts`, wired from `index.ts`:
- Before `app.whenReady()`: `protocol.registerSchemesAsPrivileged([{ scheme:
  'wt-asset', privileges: { standard: true, secure: true, supportFetchAPI: true } }])`.
- After ready: `protocol.handle('wt-asset', (req) => …)` — decode the requested
  path, **resolve it and verify it stays within the requesting window's worktree
  root** (reject `..` escapes — otherwise crafted markdown could read any file),
  then `net.fetch(pathToFileURL(abs))`. The window→repo mapping already exists
  (`windowRepoMap`); worktree roots are known per request.

Renderer:
- `MarkdownPreview` rewrites relative `<img src>` to
  `wt-asset://<encoded-absolute-path>` using `dirname(filePath)` as the base.
- DOMPurify must allow the `wt-asset:` scheme on `img@src` (extend `ALLOWED_URI_REGEXP`
  or add to the allowed schemes); `javascript:`/`vbscript:` stay blocked.

Constraining served paths to the worktree keeps this from becoming an arbitrary
local-file read. SVG images still load as `<img>` (no inline SVG injection), so the
sanitizer story is unchanged.

### 6. Hybrid scroll synchronization (anchored)

Primary approach — **line-anchored**:
1. `renderMarkdown` tags top-level block elements with `data-source-line` (start
   line). Compute line numbers in a `walkTokens` pass by accumulating the `raw`
   text length / newline counts of preceding tokens (marked tokens don't carry
   line numbers natively).
2. Editor → preview: on Monaco scroll (`onDidScrollChange`), read the top visible
   line; find the preview element with the greatest `data-source-line <= topLine`;
   scroll the preview so that element's top aligns, interpolating toward the next
   anchor for smoothness.
3. Preview → editor: on preview `scroll`, find the anchor nearest the top, map to
   its source line, and `editor.setScrollTop(editor.getTopForLineNumber(line))`.
4. Feedback-loop guard: a `syncing` flag (cleared on next `requestAnimationFrame`)
   and "last scrolled pane wins" so the two listeners don't ping-pong.

**Fallback** if line-anchoring proves flaky in practice: proportional
scroll-percentage sync (`scrollTop / scrollHeight`). Ship line-anchored; keep the
percentage path as a documented fallback.

### 7. `CodeEditor` change (minimal, additive)

Add one optional prop:

```ts
oncontentchange?: (value: string) => void
```

- Fire it once after `loadFile` completes and again inside the existing
  `editor.onDidChangeModelContent` handler (it already runs there for LSP).
- Purely additive — non-markdown callers don't pass it; no behavior change.
- For hybrid scroll sync, `MarkdownView` also needs the Monaco instance. Either
  expose it via a `bindEditor` callback prop, or have `MarkdownView` look it up by
  URI (`monaco.editor.getModel(monaco.Uri.file(path))`) and attach scroll
  listeners through a small ref. Prefer an explicit `oneditorready?(editor)` prop
  to avoid model-lifecycle coupling.

## Files

**New**
- `src/renderer/stores/markdownView.svelte.ts` — `MarkdownViewMode` + per-path mode store.
- `src/renderer/lib/markdown.ts` — `isMarkdownPath`, `renderMarkdown` (+ line anchoring).
- `src/renderer/lib/markdown-enhance.ts` — `enhanceCodeBlocks` (mermaid + monaco colorize) + fence→Monaco lang alias map.
- `src/renderer/components/layout/TabActions.svelte` — right-side action slot (+ `tabHasActions`).
- `src/renderer/components/layout/ViewModeToggle.svelte` — 3-icon toggle group.
- `src/renderer/components/editor/MarkdownView.svelte` — mode switch + layout + scroll sync.
- `src/renderer/components/editor/MarkdownPreview.svelte` — parsed/sanitized preview + code-block enhancement.

- `src/main/asset-protocol.ts` — `wt-asset:` scheme registration + worktree-scoped handler.

**Modified**
- `src/main/index.ts` — register the privileged scheme (pre-ready) + `protocol.handle` (post-ready).
- `src/renderer/components/layout/PaneTabBar.svelte` — conditional right-side action
  region (gated by `tabHasActions`), new `activeTab` prop. **`tabsStore` is unchanged.**
- `src/renderer/components/layout/WorktreePane.svelte` — pass `activeTab` to `PaneTabBar`.
- `src/renderer/components/layout/TabContainer.svelte` — route markdown files to `MarkdownView`.
- `src/renderer/components/editor/CodeEditor.svelte` — `oncontentchange` (+ optional `oneditorready`).
- `src/renderer/app.css` — `@plugin "@tailwindcss/typography";`.
- `src/renderer/components/composed/ProseBlock.svelte` — replace raw `{@html}` with
  `renderMarkdown` now that a parser exists (removes its TODO).
- `package.json` — new deps.
- `.changeset/md-view-modes.md` — `minor` changeset.

## Build sequence

1. **Deps + typography**: add packages, register the typography plugin, verify
   `prose` styling renders (quick check via ProseBlock or a scratch route).
2. **Store**: `markdownView.svelte.ts` (`get`/`set`/`forget`, remembered default)
   + unit tests in `src/renderer/stores/__tests__/markdownView.test.ts`.
3. **markdown.ts**: `isMarkdownPath` + `renderMarkdown` (parse → sanitize) with unit
   tests, including a `<script>`-stripping test. Add line anchoring after the basic
   render works.
4. **MarkdownPreview**: render `source`, prose styling, link handling.
5. **markdown-enhance.ts**: `enhanceCodeBlocks` (mermaid via the `Diagram.svelte`
   pattern + `monaco.editor.colorize` + lang alias map); wire into MarkdownPreview's
   post-mount pass with the render-token guard and debounce.
6. **Asset protocol**: register `wt-asset:` (scheme + worktree-scoped handler) in
   main; rewrite relative `<img src>` in MarkdownPreview; allow the scheme in DOMPurify.
7. **CodeEditor**: add `oncontentchange` (+ `oneditorready`).
8. **MarkdownView**: three layouts; wire live `content`; rendered-only disk load +
   `fs:` refresh.
9. **TabContainer**: route markdown file tabs to `MarkdownView`.
10. **ViewModeToggle + TabActions**: build the control.
11. **PaneTabBar + WorktreePane**: add the conditional right-side action region,
    pass `activeTab` down.
12. **Hybrid scroll sync**: line-anchored, with the feedback guard.
13. **ProseBlock**: switch to `renderMarkdown`.
14. **Tests + changeset + typecheck** (`pnpm typecheck`).

## Testing

- **Unit (vitest)**: `markdownViewStore` get/set + remembered-default behavior;
  `isMarkdownPath`; `renderMarkdown` output (headings/links/code render;
  `<script>` stripped; `data-source-line` present on blocks).
- **Component (vitest browser)**: `MarkdownPreview` renders sample markdown; a
  ` ```mermaid ` block becomes an `<svg>` and a ` ```ts ` block gains colorized
  `.mtk*` spans; relative `<img src>` is rewritten to `wt-asset:` while `http(s)`/`data:`
  are left intact; `ViewModeToggle` reflects/sets active mode and exposes `aria-pressed`.
  Also unit-test the fence→Monaco lang alias map.
- **Unit (vitest, main)**: the `wt-asset:` path resolver — in-worktree paths resolve,
  `..`-escape attempts are rejected.
- **E2E (playwright)** per CLAUDE.md — start in `e2e/repro.test.ts`, promote to
  `e2e/ide.test.ts`:
  1. Open a `.md` file → `[data-testid="md-view-toggle"]` appears in the tab bar;
     opening a non-`.md` file → it does not.
  2. Default mode is `rendered` (prose container present, no Monaco).
  3. Switch to `raw` → Monaco present, no preview; `hybrid` → both present;
     `rendered` → preview only.
  4. (If feasible) type in hybrid raw pane → preview updates live.

## Security notes

- All preview HTML goes through DOMPurify before `{@html}`. Allow `data-source-line`;
  block `javascript:` URLs and event-handler attributes (DOMPurify default).
- Mermaid SVG and `monaco.editor.colorize` output are injected *after* DOMPurify
  (§5). Safe because mermaid runs with `securityLevel: 'strict'` and colorize only
  re-wraps our own escaped code — neither reintroduces author HTML.
- Rendered links must not navigate the renderer window — intercept clicks (§4).
- The `wt-asset:` protocol handler must resolve and confirm each requested path
  stays inside the requesting window's worktree root, rejecting `..` escapes — else
  crafted markdown could read arbitrary local files (§5b).

## Non-goals / follow-ups

- WYSIWYG editing in rendered mode (preview is read-only).
- Outline/TOC, find-in-preview, export/print.
- Cross-session persistence of the chosen view mode.

## Open decisions (recommendations baked in above)

- **Default mode** = `rendered` — **confirmed**. (`_lastChosen` init in the store.)
- **Scroll sync** = line-anchored primary, percentage fallback.
- **External link opening** depends on whether an open-external IPC exists; verify
  during step 4.
</content>
</invoke>
