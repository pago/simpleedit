import { render, screen, waitFor } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import FileTree from '../FileTree.svelte'
import type { FileEntry } from '../../../../shared/ipc-types'

const ROOT = '/mem'
const entries: FileEntry[] = [
  { name: 'archive', path: `${ROOT}/archive`, isDirectory: true },
  { name: 'city.md', path: `${ROOT}/city.md`, isDirectory: false },
  { name: 'MEMORY.md', path: `${ROOT}/MEMORY.md`, isDirectory: false },
]

beforeEach(() => {
  vi.stubGlobal('api', {
    invoke: vi.fn((channel: string) => Promise.resolve(channel === 'fs:list' ? entries : undefined)),
    on: vi.fn(() => () => {}),
  })
})

afterEach(() => vi.unstubAllGlobals())

function names(): string[] {
  return screen.getAllByRole('treeitem').map((el) => el.textContent?.trim() ?? '')
}

describe('FileTree pinnedName', () => {
  it('lists the pinned file above directories and other files', async () => {
    render(FileTree, { rootPath: ROOT, pinnedName: 'memory.md' })
    await waitFor(() => expect(names()).toHaveLength(3))
    expect(names()[0]).toContain('MEMORY.md')
    expect(names()[1]).toContain('archive')
  })

  it('keeps the listing order without a pin', async () => {
    render(FileTree, { rootPath: ROOT })
    await waitFor(() => expect(names()).toHaveLength(3))
    expect(names()[0]).toContain('archive')
    expect(names()[2]).toContain('MEMORY.md')
  })
})
