---
"simpleedit": minor
---

Diff file list now uses filename-first labels so the filename stays visible
without resizing the panel. Context-less names (`index.ts`, `mod.rs`,
`__init__.py`, Next.js `page`/`route`/`layout`, …) are shown with their parent
directory (e.g. `DiffReview/index.tsx`), and files that would otherwise share a
label are disambiguated with the minimal distinguishing path segments. A
styled, no-delay hover tooltip replaces the native `title` and reveals the full
path.
