import { render, screen, waitFor } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import MemoryHealthList from '../MemoryHealthList.svelte'
import MemoryHealthBadge from '../MemoryHealthBadge.svelte'
import MemoryEmptyState from '../MemoryEmptyState.svelte'
import { memoryViewStore, _resetMemoryViewForTests } from '../../../stores/memoryView.svelte'
import type { MemoryHealthReport } from '../../../../shared/memory-health'

const DIR = '/home/u/.claude/projects/-proj/memory'

let report: MemoryHealthReport

beforeEach(() => {
  report = {
    memoryDir: DIR,
    indexPresent: true,
    fileCount: 3,
    issues: [
      { kind: 'broken-link', rel: 'a.md', file: `${DIR}/a.md`, line: 4, column: 1, endColumn: 8, message: 'No memory named "ghost"' },
      { kind: 'unindexed-file', rel: 'b.md', file: `${DIR}/b.md`, line: 1, column: 1, endColumn: 1, message: 'Not linked from MEMORY.md' },
    ],
  }
  vi.stubGlobal('api', {
    invoke: vi.fn((channel: string) => {
      if (channel === 'memory:health') return Promise.resolve(report)
      return Promise.resolve(undefined)
    }),
    on: vi.fn(() => () => {}),
  })
})

afterEach(() => {
  _resetMemoryViewForTests()
  vi.unstubAllGlobals()
})

describe('MemoryHealthList', () => {
  it('lists every issue with its location', async () => {
    const release = memoryViewStore.acquire(DIR, '/proj')
    render(MemoryHealthList, { sessionId: 's', memoryDir: DIR })
    await waitFor(() => expect(screen.getByText('3 files · 2 issues')).toBeInTheDocument())
    expect(screen.getByText('No memory named "ghost"')).toBeInTheDocument()
    expect(screen.getByText('a.md:4')).toBeInTheDocument()
    expect(screen.getByText('b.md:1')).toBeInTheDocument()
    release()
  })

  it('says so when there is nothing to fix', async () => {
    report = { ...report, issues: [] }
    const release = memoryViewStore.acquire(DIR, '/proj')
    render(MemoryHealthList, { sessionId: 's', memoryDir: DIR })
    await waitFor(() => expect(screen.getByText('3 files · no issues')).toBeInTheDocument())
    release()
  })

  it('notes a missing index', async () => {
    report = { ...report, indexPresent: false, issues: [] }
    const release = memoryViewStore.acquire(DIR, '/proj')
    render(MemoryHealthList, { sessionId: 's', memoryDir: DIR })
    await waitFor(() => expect(screen.getByText(/No MEMORY\.md index/)).toBeInTheDocument())
    release()
  })
})

describe('MemoryHealthBadge', () => {
  it('shows the issue count', async () => {
    const release = memoryViewStore.acquire(DIR, '/proj')
    render(MemoryHealthBadge, { sessionId: 's', memoryDir: DIR })
    await waitFor(() => expect(screen.getByTestId('memory-health-count')).toHaveTextContent('2'))
    release()
  })
})

describe('MemoryEmptyState', () => {
  it('shows where memories will live', () => {
    render(MemoryEmptyState, { memoryDir: DIR })
    expect(screen.getByText('No memories yet')).toBeInTheDocument()
    expect(screen.getByText(DIR)).toBeInTheDocument()
  })
})
