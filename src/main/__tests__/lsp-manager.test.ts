import { describe, it, expect } from 'vitest'
import {
  findBinaryInProject,
  findBinaryInPath,
  resolveBinary,
  resolveTsServerPath,
  buildServerArgv,
  buildInitializationOptions,
} from '../lsp-manager'

// ── findBinaryInProject ────────────────────────────────────

describe('findBinaryInProject', () => {
  it('returns full path when binary exists in node_modules/.bin', () => {
    const result = findBinaryInProject('typescript-language-server', '/project', {
      existsSync: (p) => p === '/project/node_modules/.bin/typescript-language-server',
    })
    expect(result).toBe('/project/node_modules/.bin/typescript-language-server')
  })

  it('returns null when binary is absent', () => {
    const result = findBinaryInProject('typescript-language-server', '/project', {
      existsSync: () => false,
    })
    expect(result).toBeNull()
  })

  it('checks the correct path for nested rootDir', () => {
    let checked = ''
    findBinaryInProject('pylsp', '/home/user/projects/myapp', {
      existsSync: (p) => { checked = p; return false },
    })
    expect(checked).toBe('/home/user/projects/myapp/node_modules/.bin/pylsp')
  })
})

// ── findBinaryInPath ───────────────────────────────────────

describe('findBinaryInPath', () => {
  it('returns the trimmed path when which succeeds', () => {
    const result = findBinaryInPath('rust-analyzer', {
      execSync: () => '/usr/local/bin/rust-analyzer\n',
    })
    expect(result).toBe('/usr/local/bin/rust-analyzer')
  })

  it('returns null when which exits with error', () => {
    const result = findBinaryInPath('nonexistent-lsp', {
      execSync: () => { throw new Error('not found') },
    })
    expect(result).toBeNull()
  })

  it('returns null when which output is empty', () => {
    const result = findBinaryInPath('gopls', {
      execSync: () => '   ',
    })
    expect(result).toBeNull()
  })
})

// ── resolveBinary ─────────────────────────────────────────

describe('resolveBinary', () => {
  it('prefers project-local binary over PATH', () => {
    const localPath = '/project/node_modules/.bin/typescript-language-server'
    const result = resolveBinary('typescript-language-server', '/project', {
      existsSync: (p) => p === localPath,
      execSync: () => '/usr/bin/typescript-language-server\n',
    })
    expect(result).toBe(localPath)
  })

  it('falls back to PATH when not in node_modules', () => {
    const result = resolveBinary('rust-analyzer', '/project', {
      existsSync: () => false,
      execSync: () => '/usr/local/bin/rust-analyzer\n',
    })
    expect(result).toBe('/usr/local/bin/rust-analyzer')
  })

  it('returns null when binary is unavailable everywhere', () => {
    const result = resolveBinary('missing-lsp', '/project', {
      existsSync: () => false,
      execSync: () => { throw new Error('not found') },
    })
    expect(result).toBeNull()
  })
})

// ── resolveTsServerPath ───────────────────────────────────

describe('resolveTsServerPath', () => {
  it('returns tsserver.js path when project has TypeScript', () => {
    const expected = '/project/node_modules/typescript/lib/tsserver.js'
    const result = resolveTsServerPath('/project', {
      existsSync: (p) => p === expected,
    })
    expect(result).toBe(expected)
  })

  it('returns null when project has no TypeScript', () => {
    const result = resolveTsServerPath('/project', { existsSync: () => false })
    expect(result).toBeNull()
  })
})

// ── buildServerArgv ───────────────────────────────────────

describe('buildServerArgv', () => {
  it('always returns [binary, --stdio]', () => {
    expect(buildServerArgv('typescript', 'typescript-language-server')).toEqual(
      ['typescript-language-server', '--stdio']
    )
    expect(buildServerArgv('rust', 'rust-analyzer')).toEqual(['rust-analyzer', '--stdio'])
    expect(buildServerArgv('go', 'gopls')).toEqual(['gopls', '--stdio'])
    expect(buildServerArgv('python', 'pylsp')).toEqual(['pylsp', '--stdio'])
  })
})

// ── buildInitializationOptions ────────────────────────────

describe('buildInitializationOptions', () => {
  it('passes tsserver path via initializationOptions when project TypeScript is found', () => {
    const tsPath = '/project/node_modules/typescript/lib/tsserver.js'
    const opts = buildInitializationOptions('typescript', '/project', {
      existsSync: (p) => p === tsPath,
    })
    expect(opts).toEqual({ tsserver: { path: tsPath } })
  })

  it('returns undefined for typescript when tsserver is absent', () => {
    const opts = buildInitializationOptions('typescript', '/project', {
      existsSync: () => false,
    })
    expect(opts).toBeUndefined()
  })

  it('returns same tsserver options for javascript', () => {
    const tsPath = '/project/node_modules/typescript/lib/tsserver.js'
    const opts = buildInitializationOptions('javascript', '/project', {
      existsSync: (p) => p === tsPath,
    })
    expect(opts).toEqual({ tsserver: { path: tsPath } })
  })

  it('returns undefined for non-TypeScript languages', () => {
    expect(buildInitializationOptions('rust', '/project', {})).toBeUndefined()
    expect(buildInitializationOptions('go', '/project', {})).toBeUndefined()
    expect(buildInitializationOptions('python', '/project', {})).toBeUndefined()
  })
})
