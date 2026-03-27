import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ include: ['node-pty'] })]
  },
  preload: {
    plugins: [externalizeDepsPlugin({ include: ['node-pty'] })]
  },
  renderer: {
    plugins: [svelte(), tailwindcss()]
  }
})
