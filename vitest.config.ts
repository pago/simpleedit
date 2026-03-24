import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { playwright } from '@vitest/browser-playwright'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/{main,shared}/**/*.test.ts'],
          environment: 'node',
          typecheck: { tsconfig: './tsconfig.test.json' }
        }
      },
      {
        plugins: [svelte(), tailwindcss()],
        test: {
          name: 'browser',
          include: ['src/renderer/**/*.test.ts'],
          setupFiles: ['src/renderer/test-setup.ts'],
          browser: {
            enabled: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }]
          },
          typecheck: { tsconfig: './tsconfig.browser-test.json' }
        }
      }
    ]
  }
})
