import { build } from 'esbuild'

await build({
  entryPoints: ['src/main/mcp-server/index.mjs'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'out/mcp-server/index.mjs',
  banner: { js: '#!/usr/bin/env node' }
})
