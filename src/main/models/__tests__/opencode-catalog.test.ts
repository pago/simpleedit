/**
 * Parsed from `opencode models --verbose` output captured verbatim from
 * opencode 1.18.15, not from output written to match the parser.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'

const spawnMock = vi.hoisted(() => vi.fn())
const resolveOpenCodePathMock = vi.hoisted(() => vi.fn(() => Promise.resolve('opencode')))
vi.mock('child_process', () => ({ spawn: spawnMock }))
vi.mock('../../lib/shell-path', () => ({ resolveOpenCodePath: resolveOpenCodePathMock }))

import { parseOpenCodeModels, getOpenCodeModels, cancelOpenCodeDiscovery } from '../opencode-catalog'

const REAL = readFileSync(join(__dirname, 'fixtures-opencode-models.txt'), 'utf-8')

describe('parseOpenCodeModels', () => {
  it('reads every model out of the real catalog', () => {
    const models = parseOpenCodeModels(REAL)
    expect(models.length).toBeGreaterThan(0)
    expect(models.every((m) => m.provider === 'opencode')).toBe(true)
  })

  it('qualifies every id, because --model accepts nothing else', () => {
    for (const model of parseOpenCodeModels(REAL)) {
      expect(model.model).toMatch(/^[^/]+\/[^/]+$/)
    }
  })

  it('prefers the human name over the slug', () => {
    const models = parseOpenCodeModels(REAL)
    const deepseek = models.find((m) => m.model === 'opencode/deepseek-v4-flash-free')
    expect(deepseek?.displayName).toBe('DeepSeek V4 Flash Free')
  })

  it('reads each model\'s OWN reasoning variants', () => {
    // Unlike Codex, where the effort set is global, OpenCode varies it per
    // model — deepseek offers low/high/max with no 'medium'. Assuming one
    // shared set would offer efforts the model rejects.
    const models = parseOpenCodeModels(REAL)
    const deepseek = models.find((m) => m.model === 'opencode/deepseek-v4-flash-free')
    expect(deepseek?.supportedReasoningEfforts).toEqual(expect.arrayContaining(['low', 'high', 'max']))
    expect(deepseek?.supportedReasoningEfforts).not.toContain('medium')

    // A model with no variants at all must report none rather than inherit.
    const bigPickle = models.find((m) => m.model === 'opencode/big-pickle')
    expect(bigPickle?.supportedReasoningEfforts).toEqual([])
  })

  it('survives a brace inside a string without desynchronising', () => {
    const output = 'p/a\n{"id":"a","providerID":"p","name":"Weird { name","variants":{}}\np/b\n{"id":"b","providerID":"p","name":"B","variants":{}}'
    expect(parseOpenCodeModels(output).map((m) => m.model)).toEqual(['p/a', 'p/b'])
  })

  it('drops a model that is not servable', () => {
    const output = '{"id":"gone","providerID":"p","name":"Gone","status":"deprecated","variants":{}}'
    expect(parseOpenCodeModels(output)).toEqual([])
  })

  it('ignores an effort it does not model rather than casting it blindly', () => {
    const output = '{"id":"a","providerID":"p","name":"A","status":"active","variants":{"low":{},"turbo":{}}}'
    expect(parseOpenCodeModels(output)[0]?.supportedReasoningEfforts).toEqual(['low'])
  })

  it('returns nothing rather than throwing on junk', () => {
    expect(parseOpenCodeModels('not json at all')).toEqual([])
    expect(parseOpenCodeModels('')).toEqual([])
  })
})

interface FakeProc extends EventEmitter {
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
}

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.kill = vi.fn(() => proc.emit('close', null))
  return proc
}

/**
 * The same shutdown hazard `cancelCodexDiscovery` exists for: a discovery child
 * still holding its stdio pipes when the app quits can hang Electron's
 * teardown. `opencode models` is one-shot rather than a persistent app-server,
 * so it normally exits on its own — these cover the case where it has not yet.
 */
describe('OpenCode model discovery lifecycle', () => {
  beforeEach(() => {
    spawnMock.mockClear()
    resolveOpenCodePathMock.mockClear()
    resolveOpenCodePathMock.mockReturnValue(Promise.resolve('opencode'))
  })

  it('cancelOpenCodeDiscovery kills an in-flight catalog child', async () => {
    const proc = makeFakeProc()
    spawnMock.mockReturnValueOnce(proc)

    const models = getOpenCodeModels()
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    expect(proc.kill).not.toHaveBeenCalled()

    cancelOpenCodeDiscovery()
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
    // The kill's 'close' rejects the run, so discovery resolves empty rather
    // than leaving the promise dangling.
    await expect(models).resolves.toEqual([])
  })

  it('a cancel during path resolution prevents the spawn entirely', async () => {
    let releasePath: (value: string) => void = () => {}
    resolveOpenCodePathMock.mockReturnValueOnce(new Promise<string>((resolve) => { releasePath = resolve }))

    const models = getOpenCodeModels()
    await vi.waitFor(() => expect(resolveOpenCodePathMock).toHaveBeenCalled())

    // Quit lands while the login-shell path probe is still running: the spawn
    // must not happen afterwards — it would outlive the quit hooks.
    cancelOpenCodeDiscovery()
    releasePath('opencode')

    await expect(models).resolves.toEqual([])
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('a later discovery spawns normally after an earlier one was cancelled', async () => {
    cancelOpenCodeDiscovery()

    const proc = makeFakeProc()
    spawnMock.mockReturnValueOnce(proc)
    const models = getOpenCodeModels()
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())

    proc.stdout.end('{"id":"a","providerID":"p","name":"A","status":"active","variants":{"low":{}}}')
    proc.stderr.end()
    proc.emit('close', 0)

    await expect(models).resolves.toEqual([
      { provider: 'opencode', displayName: 'A', model: 'p/a', supportedReasoningEfforts: ['low'] },
    ])
  })
})
