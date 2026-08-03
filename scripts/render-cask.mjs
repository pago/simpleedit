// Renders scripts/homebrew/simpleedit.rb.template into a concrete Homebrew cask
// for one release. Driven by .github/workflows/homebrew.yml, which then pushes
// the result to the pago/homebrew-simpleedit tap.
//
//   node scripts/render-cask.mjs --version 0.18.1 \
//     --arm64 <sha256> --x64 <sha256> --out Casks/simpleedit.rb
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = dirname(fileURLToPath(import.meta.url))

function fail(message) {
  console.error(`render-cask: ${message}`)
  process.exit(1)
}

function arg(name) {
  const at = process.argv.indexOf(`--${name}`)
  const value = at === -1 ? undefined : process.argv[at + 1]
  if (!value || value.startsWith('--')) fail(`missing required --${name}`)
  return value
}

const version = arg('version')
const out = arg('out')
const digests = { arm64: arg('arm64'), x64: arg('x64') }

if (!/^\d+\.\d+\.\d+/.test(version)) fail(`--version is not a version: ${version}`)

// A digest that arrived truncated — or as a whole `sha256sum` line, spaces and
// filename included — still renders a syntactically valid cask. It would only
// blow up in a user's terminal as a checksum mismatch, long after this job went
// green, so reject anything that isn't exactly 64 hex characters.
for (const [arch, digest] of Object.entries(digests)) {
  if (!/^[0-9a-f]{64}$/.test(digest)) fail(`--${arch} is not a sha256 digest: ${digest}`)
}

const rendered = readFileSync(join(scriptsDir, 'homebrew/simpleedit.rb.template'), 'utf8')
  .replaceAll('__VERSION__', version)
  .replaceAll('__SHA256_ARM64__', digests.arm64)
  .replaceAll('__SHA256_X64__', digests.x64)

const leftover = rendered.match(/__[A-Z0-9_]+__/g)
if (leftover) fail(`unfilled placeholder(s) in the template: ${[...new Set(leftover)].join(', ')}`)

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, rendered)
console.log(`render-cask: wrote ${out} for ${version}`)
