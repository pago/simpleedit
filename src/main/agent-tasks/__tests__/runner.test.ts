import { describe, it, expect, beforeEach, vi } from 'vitest'
import { net } from 'electron'
import { DirectRunner, type RunRequest } from '../runner'
import { reviewTask, type RawReviewFinding } from '../../tasks/review-task'

vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
}))

const fetchMock = vi.mocked(net.fetch)

/** Build a streaming Response whose body is emitted as the given raw chunks. */
function streamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    },
  })
  return new Response(stream, { status })
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of it) out.push(item)
  return out
}

const OLLAMA_MODEL = { provider: 'ollama' as const, model: 'gpt-oss:20b' }

function reviewReq(overrides?: Partial<RunRequest<RawReviewFinding>>): RunRequest<RawReviewFinding> {
  return {
    system: '',
    user: 'review this',
    parse: (obj) => reviewTask.parse(obj),
    model: OLLAMA_MODEL,
    ...overrides,
  }
}

const finding = (title: string): string =>
  JSON.stringify({
    label: 'issue',
    file: 'src/foo.ts',
    lineRange: [1, 2],
    title,
    body: 'details',
  })

beforeEach(() => {
  fetchMock.mockReset()
})

describe('DirectRunner (Ollama native /api/chat)', () => {
  it('parses NDJSON findings from streamed assistant content', async () => {
    // Ollama /api/chat streams one JSON envelope per line, each carrying a
    // `message.content` delta. Split a finding across two deltas to exercise
    // the incremental scanner.
    fetchMock.mockResolvedValue(
      streamResponse([
        `{"message":{"role":"assistant","content":${JSON.stringify(finding('first') + '\n')}}}\n`,
        `{"message":{"role":"assistant","content":${JSON.stringify('{"label":"nitpick","file":"a.ts","lineRange":[3,3],"title":"seco')}}}\n`,
        `{"message":{"role":"assistant","content":${JSON.stringify('nd","body":"x"}\n')}}}\n`,
        `{"message":{"role":"assistant","content":""},"done":true}\n`,
      ])
    )

    const items = await collect(new DirectRunner().run(reviewReq()))
    expect(items.map((f) => f.title)).toEqual(['first', 'second'])
    expect(items[0].label).toBe('issue')
    expect(items[1].label).toBe('nitpick')
  })

  it('ignores a reasoning model\'s `thinking` field and uses only `content`', async () => {
    // gpt-oss-style chunk: reasoning in `message.thinking`, answer in `content`.
    fetchMock.mockResolvedValue(
      streamResponse([
        `{"message":{"role":"assistant","thinking":"Let me look for {bugs}...","content":""}}\n`,
        `{"message":{"role":"assistant","content":${JSON.stringify(finding('real') + '\n')}}}\n`,
        `{"message":{"role":"assistant","content":""},"done":true}\n`,
      ])
    )

    const items = await collect(new DirectRunner().run(reviewReq()))
    // The brace in the `thinking` field must NOT be scanned as a finding.
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('real')
  })

  it('sends stream:true and a generous num_ctx to /api/chat', async () => {
    fetchMock.mockResolvedValue(streamResponse([`{"message":{"content":""},"done":true}\n`]))
    await collect(new DirectRunner().run(reviewReq()))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:11434/api/chat')
    const body = JSON.parse((init as RequestInit).body as string) as {
      stream: boolean
      options: { num_ctx: number }
      messages: { role: string }[]
    }
    expect(body.stream).toBe(true)
    expect(body.options.num_ctx).toBeGreaterThanOrEqual(32768)
    // Empty system ⇒ a single user message.
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].role).toBe('user')
  })

  it('refuses a non-Ollama model (never touches the Anthropic endpoint)', async () => {
    const run = new DirectRunner().run(
      reviewReq({ model: { provider: 'anthropic', model: 'claude-sonnet' } })
    )
    await expect(collect(run)).rejects.toThrow(/requires an Ollama model/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
