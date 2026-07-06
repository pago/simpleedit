import { describe, it, expect, beforeEach, vi } from 'vitest'
import { net } from 'electron'
import {
  isAvailable,
  listInstalled,
  getCapabilities,
  isToolCapable,
  pull,
  type PullProgress,
} from '../ollama'

vi.mock('electron', () => ({
  net: { fetch: vi.fn() },
}))

const fetchMock = vi.mocked(net.fetch)

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

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

beforeEach(() => {
  fetchMock.mockReset()
})

describe('isAvailable', () => {
  it('true when /api/version responds ok', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ version: '0.1.0' }))
    expect(await isAvailable()).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:11434/api/version', undefined)
  })

  it('false when the request throws (daemon down)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await isAvailable()).toBe(false)
  })

  it('false on non-ok status', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500))
    expect(await isAvailable()).toBe(false)
  })
})

describe('listInstalled (tags parsing)', () => {
  it('parses name, parameter_size and quantization_level', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        models: [
          {
            name: 'qwen2.5-coder:7b',
            details: { parameter_size: '7.6B', quantization_level: 'Q4_K_M' },
          },
          { name: 'nomic-embed-text:latest' }, // no details
        ],
      })
    )
    const out = await listInstalled()
    expect(out).toEqual([
      { name: 'qwen2.5-coder:7b', paramSize: '7.6B', quantization: 'Q4_K_M' },
      { name: 'nomic-embed-text:latest', paramSize: undefined, quantization: undefined },
    ])
  })

  it('returns [] when models is absent or malformed', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    expect(await listInstalled()).toEqual([])
  })

  it('throws on non-ok status', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 404))
    await expect(listInstalled()).rejects.toThrow(/api\/tags failed: 404/)
  })
})

describe('capabilities / tool-capability filter', () => {
  it('getCapabilities returns the capabilities array', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ capabilities: ['completion', 'tools'] }))
    expect(await getCapabilities('m')).toEqual(['completion', 'tools'])
  })

  it('isToolCapable true when tools present', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ capabilities: ['tools', 'vision'] }))
    expect(await isToolCapable('m')).toBe(true)
  })

  it('isToolCapable false when tools absent', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ capabilities: ['completion'] }))
    expect(await isToolCapable('m')).toBe(false)
  })

  it('isToolCapable false when capabilities missing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    expect(await isToolCapable('m')).toBe(false)
  })
})

describe('pull (NDJSON progress buffering)', () => {
  it('emits one progress per line even when lines are split across chunks', async () => {
    // The second object is split across a chunk boundary mid-line.
    fetchMock.mockResolvedValue(
      streamResponse([
        '{"status":"pulling","total":100,"completed":10}\n{"status":"pul',
        'ling","total":100,"completed":60}\n',
        '{"status":"success"}\n',
      ])
    )
    const progress: PullProgress[] = []
    await pull('qwen2.5-coder:7b', (p) => progress.push(p))
    expect(progress).toEqual([
      { status: 'pulling', total: 100, completed: 10, digest: undefined },
      { status: 'pulling', total: 100, completed: 60, digest: undefined },
      { status: 'success', total: undefined, completed: undefined, digest: undefined },
    ])
  })

  it('yields a trailing line with no final newline', async () => {
    fetchMock.mockResolvedValue(streamResponse(['{"status":"success"}']))
    const progress: PullProgress[] = []
    await pull('m', (p) => progress.push(p))
    expect(progress).toHaveLength(1)
    expect(progress[0].status).toBe('success')
  })

  it('rejects when a line carries an error', async () => {
    fetchMock.mockResolvedValue(streamResponse(['{"error":"model not found"}\n']))
    await expect(pull('bogus', () => {})).rejects.toThrow('model not found')
  })

  it('rejects on non-ok status', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 500))
    await expect(pull('m', () => {})).rejects.toThrow(/api\/pull failed/)
  })
})
