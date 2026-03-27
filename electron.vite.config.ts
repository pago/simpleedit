import { defineConfig } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external: ['node-pty']
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        external: ['node-pty']
      }
    }
  },
  renderer: {
    plugins: [svelte(), tailwindcss()]
  }
})
