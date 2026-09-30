/**
 * `output: 'text'` on every runner: the run yields the final assistant message
 * as one string, and never scans it for `{…}` objects. Each process-backed
 * runner is driven through a fake child process replaying its wire format.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { net } from 'electron'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('child_process', () => ({ spawn: spawnMock }))
vi.mock('../../lib/shell-path', () => ({
  resolveClaudePath: () => Promise.resolve('claude'),
  resolveCodexPath: () => Promise.resolve('codex'),
  resolveOpenCodePath: () => Promise.resolve('opencode'),
}))
vi.mock('../../lib/opencode-env', () => ({ openCodeBaseEnv: () => ({}) }))
vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

import { ClaudeCodeRunner, CodexRunner, DirectRunner, OpenCodeRunner, type RunRequest, type Runner } from '../runner'
import { runTask, type Task } from '../orchestrator'

const fetchMock = vi.mocked(net.fetch)

interface FakeProc extends EventEmitter {
  stdout: PassThrough
  stderr: PassThrough
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
  kill: ReturnType<typeof vi.fn>
}

/** A process that prints `lines` to stdout, then exits with `code`. */
function replay(lines: unknown[], code = 0): void {
  spawnMock.mockImplementation(() => {
    const proc = new EventEmitter() as FakeProc
    proc.stdout = new PassThrough()
    proc.stderr = new PassThrough()
    proc.stdin = { write: vi.fn(), end: vi.fn() }
    proc.kill = vi.fn()
    proc.stdout.on('end', () => setImmediate(() => proc.emit('close', code)))
    setImmediate(() => {
      proc.stdout.end(lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    })
    return proc
  })
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of it) out.push(item)
  return out
}

const asString = (obj: unknown): string | null => (typeof obj === 'string' ? obj : null)

function textReq(overrides?: Partial<RunRequest<string>>): RunRequest<string> {
  return { system: '', user: 'overview', parse: asString, output: 'text', ...overrides }
}

/** Markdown with braces that the JSON scanner would pick up as an object. */
const ANSWER = '## What changed\nAdds `{"a":1}` handling.\n\n## Why\nBecause.'

beforeEach(() => {
  spawnMock.mockReset()
  fetchMock.mockReset()
})

describe('ClaudeCodeRunner text mode', () => {
  const runner = (): Runner => new ClaudeCodeRunner({ cwd: '/repo' })
  const delta = (text: string): unknown => ({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  })

  it('yields the result event text once, ignoring deltas from earlier turns', async () => {
    replay([delta('Let me look at the diff first.'), delta(ANSWER), { type: 'result', result: ANSWER }])
    expect(await collect(runner().run(textReq()))).toEqual([ANSWER])
  })

  it('yields nothing when the run ends without a result', async () => {
    replay([delta(ANSWER)])
    expect(await collect(runner().run(textReq()))).toEqual([])
  })

  it('fails on an error result even when claude exits 0, never parsing its text as the answer', async () => {
    const parse = vi.fn(asString)
    replay([{ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: overloaded' }])
    await expect(collect(runner().run(textReq({ parse })))).rejects.toThrow(/claude run failed: API Error: overloaded/)
    expect(parse).not.toHaveBeenCalled()

    replay([{ type: 'result', subtype: 'error_max_turns', is_error: true }])
    await expect(collect(runner().run(textReq()))).rejects.toThrow(/error_max_turns/)
  })

  it('fails on a non-zero exit instead of yielding a partial answer', async () => {
    replay([{ type: 'result', result: ANSWER }], 1)
    await expect(collect(runner().run(textReq()))).rejects.toThrow(/exited with code 1/)
  })

  it('still scans for objects in the default json mode', async () => {
    replay([{ type: 'result', result: ANSWER }])
    const items = await collect(runner().run(textReq({ output: undefined, parse: (o) => (o && typeof o === 'object' ? 'obj' : null) })))
    expect(items).toEqual(['obj'])
  })
})

describe('CodexRunner text mode', () => {
  const runner = (): Runner => new CodexRunner({ cwd: '/repo' })
  const message = (text: string): unknown => ({ type: 'item.completed', item: { type: 'agent_message', text } })

  it('yields only the last completed agent message', async () => {
    replay([
      { type: 'turn.started' },
      message('I will read the changed files.'),
      { type: 'item.completed', item: { type: 'command_execution', text: 'ls' } },
      { type: 'item.updated', item: { type: 'agent_message', text: '## What' } },
      message(ANSWER),
      { type: 'turn.completed' },
    ])
    expect(await collect(runner().run(textReq()))).toEqual([ANSWER])
  })

  it('reports a failed turn rather than yielding text', async () => {
    replay([message(ANSWER), { type: 'turn.failed', error: { message: 'rate limit reached' } }])
    await expect(collect(runner().run(textReq()))).rejects.toThrow(/rate limit reached/)
  })
})

describe('OpenCodeRunner text mode', () => {
  const runner = (): Runner => new OpenCodeRunner({ cwd: '/repo' })
  const text = (t: string): unknown => ({ type: 'text', part: { text: t } })

  it('yields only the last text frame', async () => {
    replay([
      { type: 'step_start' },
      text('Reading the diff.'),
      { type: 'tool_use' },
      { type: 'step_finish', part: { reason: 'tool-calls' } },
      text(ANSWER),
      { type: 'step_finish', part: { reason: 'stop' } },
    ])
    expect(await collect(runner().run(textReq()))).toEqual([ANSWER])
  })

  it('reports a fatal finish reason rather than yielding text', async () => {
    replay([text(ANSWER), { type: 'step_finish', part: { reason: 'error' } }])
    await expect(collect(runner().run(textReq()))).rejects.toThrow(/turn failed/)
  })
})

describe('DirectRunner text mode', () => {
  const OLLAMA = { provider: 'ollama' as const, model: 'gpt-oss:20b' }

  function streamResponse(contents: string[]): Response {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of contents) controller.enqueue(encoder.encode(`{"message":{"content":${JSON.stringify(c)}}}\n`))
        controller.enqueue(encoder.encode('{"message":{"content":""},"done":true}\n'))
        controller.close()
      },
    })
    return new Response(body, { status: 200 })
  }

  it('joins every content delta into one answer', async () => {
    fetchMock.mockResolvedValue(streamResponse([ANSWER.slice(0, 20), ANSWER.slice(20)]))
    expect(await collect(new DirectRunner().run(textReq({ model: OLLAMA })))).toEqual([ANSWER])
  })

  it('yields nothing for an empty response', async () => {
    fetchMock.mockResolvedValue(streamResponse([]))
    expect(await collect(new DirectRunner().run(textReq({ model: OLLAMA })))).toEqual([])
  })
})

describe('runTask', () => {
  it("forwards the task's output mode to the runner", async () => {
    const seen: (string | undefined)[] = []
    const runner: Runner = {
      run<Item>(req: RunRequest<Item>): AsyncIterable<Item> {
        seen.push(req.output)
        return (async function* () {})()
      },
    }
    const task = (output?: 'text'): Task<null, null, string> => ({
      name: 't',
      buildContext: async () => null,
      buildPrompt: () => ({ system: '', user: '' }),
      parse: asString,
      output,
    })
    await collect(runTask(task('text'), null, { runner }))
    await collect(runTask(task(), null, { runner }))
    expect(seen).toEqual(['text', undefined])
  })
})
