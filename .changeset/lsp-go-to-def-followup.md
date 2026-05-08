---
"simpleedit": patch
---

Two follow-up fixes to Go to Definition that the previous wiring missed:

- **Multiple definitions:** Monaco's default for `gotoLocation.multipleDefinitions` is `'peek'`, which short-circuits before our editor opener can run. Imports very commonly resolve to 2+ locations, so the peek widget kept appearing instead of navigation. The editor now opts into `'goto'` for definitions, declarations, type definitions, and implementations (references stay on peek).
- **Same-file definitions:** the opener was intercepting in-file navigation and routing it through the host's `openFile`, which dedupes to the already-active tab without re-running the file load — so the cursor never moved. The opener now defers to Monaco's default standalone handler when the source editor's model URI matches the requested resource.

Covered by new browser-mode tests in `src/renderer/lsp/__tests__/editor-opener.test.ts`.
