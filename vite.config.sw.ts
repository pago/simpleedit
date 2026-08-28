import { defineConfig } from 'vite'
import { fileURLToPath } from 'url'

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

/**
 * The service worker, built on its own.
 *
 * Separate from `vite.config.web.ts` for two reasons that both matter:
 *
 *  - **A fixed name.** The page registers `sw.js` relative to `/<token>/`, and
 *    a hashed filename would need the page to look it up first — one more
 *    thing to be stale after a rebuild.
 *  - **A classic script, not a module.** `type: 'module'` service workers are
 *    the newest part of this API surface and the least evenly supported, and
 *    the one platform this feature exists for is the one that lagged. An IIFE
 *    with no imports left in it works everywhere and costs nothing: the worker
 *    is a hundred lines with one local dependency.
 *
 * `emptyOutDir` is off because the web bundle is written to the same directory
 * and whichever build runs second must not delete the other's output.
 */
export default defineConfig({
  build: {
    outDir: here('out/web'),
    emptyOutDir: false,
    // The worker must be readable by every browser that can install a PWA, and
    // is small enough that a conservative target costs nothing.
    target: 'es2020',
    lib: {
      entry: here('src/web/sw.ts'),
      formats: ['iife'],
      name: 'SimpleEditServiceWorker',
      fileName: () => 'sw.js',
    },
  },
})
