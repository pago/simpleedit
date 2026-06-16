---
"simpleedit": patch
---

Fix Markdown view mode locking after the first switch. The per-file view-mode store used a plain `$state(new Map())`, whose `.set()`/`.get()` mutations are not tracked by Svelte 5; once a file had a stored mode the reader's dependency dropped and the toggle stopped responding. The store now uses `SvelteMap` so subsequent switches stay reactive.
