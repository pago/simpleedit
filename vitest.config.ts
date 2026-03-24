import { defineConfig } from 'vitest/config'

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
      }
      // Browser mode project will be added here for renderer component tests
    ]
  }
})
