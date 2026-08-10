import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test' } }))

const spawnMock = vi.hoisted(() => vi.fn())
const resolveCodexPathMock = vi.hoisted(() => vi.fn(() => Promise.resolve('codex')))
vi.mock('child_process', () => ({ spawn: spawnMock }))
vi.mock('../../lib/shell-path', () => ({ resolveCodexPath: resolveCodexPathMock }))

import { parseCodexModelPage, listCodexModels, cancelCodexDiscovery } from '../codex-catalog'

interface FakeProc extends EventEmitter {
  stdout: PassThrough
  stdin: { write: ReturnType<typeof vi.fn> }
  kill: ReturnType<typeof vi.fn>
}

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc
  proc.stdout = new PassThrough()
  proc.stdin = { write: vi.fn() }
  proc.kill = vi.fn(() => proc.emit('close', null))
  return proc
}

describe('Codex model discovery lifecycle', () => {
  beforeEach(() => {
    spawnMock.mockClear()
    resolveCodexPathMock.mockClear()
  })

  it('cancelCodexDiscovery kills an in-flight app-server child', async () => {
    const proc = makeFakeProc()
    spawnMock.mockReturnValueOnce(proc)

    const models = listCodexModels()
    // The initialize RPC has been written and discovery now sits awaiting the
    // response — the child is alive and in the inflight set.
    await vi.waitFor(() => expect(proc.stdin.write).toHaveBeenCalled())
    expect(proc.kill).not.toHaveBeenCalled()

    cancelCodexDiscovery()
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
    // The kill's 'close' fails the pending RPC, so discovery resolves empty
    // instead of leaving the promise dangling.
    await expect(models).resolves.toEqual([])
  })

  it('a cancel during codex-path resolution prevents the spawn entirely', async () => {
    let releasePath: (value: string) => void = () => {}
    resolveCodexPathMock.mockReturnValueOnce(new Promise<string>((resolve) => { releasePath = resolve }))

    const models = listCodexModels()
    await vi.waitFor(() => expect(resolveCodexPathMock).toHaveBeenCalled())

    // Quit lands while the login-shell path probe is still running: the spawn
    // must not happen afterwards — it would outlive the quit hooks.
    cancelCodexDiscovery()
    releasePath('codex')

    await expect(models).resolves.toEqual([])
    expect(spawnMock).not.toHaveBeenCalled()
  })
})

describe('Codex model catalog parsing', () => {
  it('filters hidden models and preserves reasoning/default metadata and pagination', () => {
    expect(parseCodexModelPage({
      data: [
        { id: 'hidden', displayName: 'Hidden', hidden: true },
        {
          id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', hidden: false,
          defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'xhigh' }, { reasoningEffort: 'ultra' }], isDefault: true,
        },
      ],
      nextCursor: 'page-2',
    })).toEqual({
      models: [{ provider: 'openai', model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', defaultReasoningEffort: 'low', supportedReasoningEfforts: ['low', 'xhigh', 'ultra'], isDefault: true }],
      nextCursor: 'page-2',
    })
  })

  /**
   * Codex's app-server schema types `reasoningEffort` as any non-empty string,
   * so a value we don't model can show up whenever Codex ships one. Dropping it
   * beats casting it into our union, where it would reach the launch flags and
   * the settings pickers as something nothing can handle.
   */
  it('drops reasoning efforts outside the known set instead of trusting them', () => {
    const { models } = parseCodexModelPage({
      data: [{
        id: 'gpt-6', model: 'gpt-6', displayName: 'GPT-6', hidden: false,
        defaultReasoningEffort: 'transcendent',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low' },
          { reasoningEffort: 'transcendent' },
          { reasoningEffort: 42 },
          {},
        ],
        isDefault: false,
      }],
    })
    expect(models[0].supportedReasoningEfforts).toEqual(['low'])
    expect(models[0].defaultReasoningEffort).toBeUndefined()
  })

  it('falls back to the id when no model field is present, and to the id for the name', () => {
    const { models, nextCursor } = parseCodexModelPage({
      data: [{ id: 'gpt-5.4', hidden: false, isDefault: false }],
    })
    expect(models).toEqual([{
      provider: 'openai', model: 'gpt-5.4', displayName: 'gpt-5.4',
      supportedReasoningEfforts: [], isDefault: false,
    }])
    expect(nextCursor).toBeNull()
  })

  it('tolerates a malformed page rather than throwing', () => {
    expect(parseCodexModelPage(undefined)).toEqual({ models: [], nextCursor: null })
    expect(parseCodexModelPage({ data: 'nope' })).toEqual({ models: [], nextCursor: null })
    expect(parseCodexModelPage({ data: [null, 7, 'x', { noId: true }] })).toEqual({ models: [], nextCursor: null })
  })
})
