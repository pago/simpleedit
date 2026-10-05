import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'url'

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

/**
 * The web bundle served by the remote-access server — a separate build from
 * the renderer's, sharing its Svelte and Tailwind pipeline.
 *
 * Two things differ from `electron.vite.config.ts`:
 *
 *  - `base: './'`. Every asset URL is relative to where the server mounts
 *    the shell (`/app/`), so that path is decided in one place.
 *  - Monaco is excluded. It is the single largest thing the desktop renderer
 *    pulls in and a phone has no use for it; the `external` entry makes an
 *    accidental import fail the build instead of quietly shipping megabytes.
 */
export default defineConfig({
  root: here('src/web'),
  base: './',
  // `root` is src/web, so the plugin would otherwise miss the repo-root
  // svelte.config.js and silently fall back to a preprocessor-less default.
  plugins: [svelte({ configFile: here('svelte.config.js') }), tailwindcss()],
  build: {
    outDir: here('out/web'),
    emptyOutDir: true,
    rollupOptions: {
      external: [/^monaco-editor(\/|$)/],
    },
  },
})
