import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'

const spawnMock = vi.hoisted(() => vi.fn())
const resolveClaudePathMock = vi.hoisted(() => vi.fn(() => Promise.resolve('claude')))
vi.mock('child_process', () => ({ spawn: spawnMock }))
vi.mock('../../lib/shell-path', () => ({ resolveClaudePath: resolveClaudePathMock }))

import { parseClaudeModels, listClaudeModels, cancelClaudeDiscovery, CLAUDE_FALLBACK_MODELS } from '../claude-catalog'

interface FakeProc extends EventEmitter {
  stdout: PassThrough
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn> }
  kill: ReturnType<typeof vi.fn>
}

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc
  proc.stdout = new PassThrough()
  proc.stdin = Object.assign(new EventEmitter(), { write: vi.fn() })
  proc.kill = vi.fn(() => proc.emit('close', null))
  return proc
}

function initializeResponse(models: unknown[]): string {
  return `${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'models', response: { models } } })}\n`
}

describe('Claude model catalog parsing', () => {
  it('keeps aliases and pinned ids as --model values, dropping the CLI default entry', () => {
    expect(parseClaudeModels([
      { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)' },
      { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5' },
      { value: 'claude-fable-5-1[1m]', displayName: 'Fable 5.1' },
      { value: 'claude-sonnet-4-6' },
      { displayName: 'no value' },
      null,
    ])).toEqual([
      { provider: 'anthropic', model: 'opus', displayName: 'Opus 5.5' },
      { provider: 'anthropic', model: 'claude-fable-5-1[1m]', displayName: 'Fable 5.1' },
      { provider: 'anthropic', model: 'claude-sonnet-4-6', displayName: 'claude-sonnet-4-6' },
    ])
  })

  it('treats a missing or malformed models field as empty', () => {
    expect(parseClaudeModels(undefined)).toEqual([])
    expect(parseClaudeModels({ opus: {} })).toEqual([])
  })
})

// One lifecycle suite, run in order: a successful discovery is cached for the
// process lifetime, so the failure cases must come first.
describe('Claude model discovery lifecycle', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    resolveClaudePathMock.mockClear()
  })

  it('a cancel during claude-path resolution prevents the spawn and serves the fallback', async () => {
    let releasePath: (value: string) => void = () => {}
    resolveClaudePathMock.mockReturnValueOnce(new Promise<string>((resolve) => { releasePath = resolve }))

    const models = listClaudeModels()
    await vi.waitFor(() => expect(resolveClaudePathMock).toHaveBeenCalled())
    cancelClaudeDiscovery()
    releasePath('claude')

    await expect(models).resolves.toEqual(CLAUDE_FALLBACK_MODELS)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('cancelClaudeDiscovery kills an in-flight child and serves the fallback', async () => {
    const proc = makeFakeProc()
    spawnMock.mockReturnValueOnce(proc)

    const models = listClaudeModels()
    await vi.waitFor(() => expect(proc.stdin.write).toHaveBeenCalled())
    cancelClaudeDiscovery()

    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
    await expect(models).resolves.toEqual(CLAUDE_FALLBACK_MODELS)
  })

  it('a failed initialize is not cached', async () => {
    const proc = makeFakeProc()
    spawnMock.mockReturnValueOnce(proc)

    const models = listClaudeModels()
    await vi.waitFor(() => expect(proc.stdin.write).toHaveBeenCalled())
    proc.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: 'models', error: 'nope' } })}\n`)

    await expect(models).resolves.toEqual(CLAUDE_FALLBACK_MODELS)
  })

  it('concurrent callers share one discovery child', async () => {
    const proc = makeFakeProc()
    spawnMock.mockReturnValueOnce(proc)

    const first = listClaudeModels()
    const second = listClaudeModels()
    await vi.waitFor(() => expect(proc.stdin.write).toHaveBeenCalled())
    proc.emit('close', 1)

    await expect(Promise.all([first, second])).resolves.toEqual([CLAUDE_FALLBACK_MODELS, CLAUDE_FALLBACK_MODELS])
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('a child that never answers is killed at the timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const proc = makeFakeProc()
      spawnMock.mockReturnValueOnce(proc)

      const models = listClaudeModels()
      await vi.waitFor(() => expect(proc.stdin.write).toHaveBeenCalled())
      vi.advanceTimersByTime(10_000)

      await expect(models).resolves.toEqual(CLAUDE_FALLBACK_MODELS)
      expect(proc.kill).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a spawn error serves the fallback', async () => {
    const proc = makeFakeProc()
    spawnMock.mockReturnValueOnce(proc)

    const models = listClaudeModels()
    await vi.waitFor(() => expect(proc.stdin.write).toHaveBeenCalled())
    proc.emit('error', new Error('spawn claude ENOENT'))

    await expect(models).resolves.toEqual(CLAUDE_FALLBACK_MODELS)
  })

  it('asks for initialize without persisting a session or running hooks, then caches the result', async () => {
    const proc = makeFakeProc()
    spawnMock.mockReturnValueOnce(proc)

    const models = listClaudeModels()
    await vi.waitFor(() => expect(proc.stdin.write).toHaveBeenCalled())
    expect(JSON.parse(proc.stdin.write.mock.calls[0][0] as string)).toMatchObject({ type: 'control_request', request: { subtype: 'initialize' } })
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toEqual(expect.arrayContaining(['--no-session-persistence', '--input-format', 'stream-json']))
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ disableAllHooks: true })
    expect(args).not.toContain('--bare')

    // Non-JSON noise and unrelated events before the response are ignored.
    proc.stdout.write('not json\n')
    proc.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init' })}\n`)
    proc.stdout.write(initializeResponse([{ value: 'sonnet', displayName: 'Sonnet 5.5' }]))

    const expected = [{ provider: 'anthropic', model: 'sonnet', displayName: 'Sonnet 5.5' }]
    await expect(models).resolves.toEqual(expected)
    expect(proc.kill).toHaveBeenCalled()

    await expect(listClaudeModels()).resolves.toEqual(expected)
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })
})
