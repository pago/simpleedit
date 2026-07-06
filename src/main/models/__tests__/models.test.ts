import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { HardwareInfo } from '../../../shared/ipc-types'
import type { InstalledTag } from '../ollama'

vi.mock('../ollama', () => ({
  listInstalled: vi.fn(),
  isToolCapable: vi.fn(),
}))
vi.mock('../hardware', () => ({
  detectHardware: vi.fn(),
}))

import { listInstalled, isToolCapable } from '../ollama'
import { detectHardware } from '../hardware'
import { listInstalledModels, listRecommendedModels, estimateMinRam } from '../index'
import { RECOMMENDED_MODELS } from '../recommendations'

const listInstalledMock = vi.mocked(listInstalled)
const isToolCapableMock = vi.mocked(isToolCapable)
const detectHardwareMock = vi.mocked(detectHardware)

const GB = 1024 ** 3

function hw(totalRamBytes: number): HardwareInfo {
  return { totalRamBytes, chip: 'Apple M-test', platform: 'darwin' }
}

beforeEach(() => {
  vi.clearAllMocks()
  detectHardwareMock.mockReturnValue(hw(16 * GB))
})

describe('estimateMinRam', () => {
  it('undefined when no param size', () => {
    expect(estimateMinRam(undefined, 'Q4_K_M')).toBeUndefined()
  })

  it('7B-Q4 lands in the ~4-6 GB range', () => {
    const est = estimateMinRam('7B', 'Q4_K_M')!
    expect(est).toBeGreaterThan(4 * GB)
    expect(est).toBeLessThan(7 * GB)
  })

  it('scales up for 32B', () => {
    const est = estimateMinRam('32B', 'Q4_K_M')!
    expect(est).toBeGreaterThan(18 * GB)
    expect(est).toBeLessThan(24 * GB)
  })

  it('handles M-suffixed small models', () => {
    const est = estimateMinRam('500M', 'Q4_K_M')!
    // dominated by context overhead, well under 2 GB
    expect(est).toBeLessThan(2 * GB)
  })
})

describe('listInstalledModels', () => {
  it('filters out non-tool-capable models and annotates fit', async () => {
    const tags: InstalledTag[] = [
      { name: 'qwen2.5-coder:7b', paramSize: '7B', quantization: 'Q4_K_M' },
      { name: 'nomic-embed-text', paramSize: '137M' },
    ]
    listInstalledMock.mockResolvedValue(tags)
    isToolCapableMock.mockImplementation(async (name) => name === 'qwen2.5-coder:7b')

    const out = await listInstalledModels()
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      name: 'qwen2.5-coder:7b',
      installed: true,
      toolCapable: true,
      fit: 'fits', // ~5GB on a 16GB machine
    })
    expect(out[0].minRamBytes).toBeGreaterThan(0)
  })

  it('marks a too-big model on a small machine', async () => {
    detectHardwareMock.mockReturnValue(hw(8 * GB))
    listInstalledMock.mockResolvedValue([{ name: 'big:32b', paramSize: '32B', quantization: 'Q4_K_M' }])
    isToolCapableMock.mockResolvedValue(true)
    const out = await listInstalledModels()
    expect(out[0].fit).toBe('too-big')
  })
})

describe('listRecommendedModels', () => {
  it('excludes already-installed models and annotates fit + installed=false', async () => {
    const firstName = RECOMMENDED_MODELS[0].name
    listInstalledMock.mockResolvedValue([{ name: firstName }])
    const out = await listRecommendedModels()
    expect(out.some((m) => m.name === firstName)).toBe(false)
    expect(out.length).toBe(RECOMMENDED_MODELS.length - 1)
    for (const m of out) {
      expect(m.installed).toBe(false)
      expect(m.toolCapable).toBe(true)
      expect(['fits', 'marginal', 'too-big']).toContain(m.fit)
    }
  })

  it('still returns the full list when Ollama is unreachable', async () => {
    listInstalledMock.mockRejectedValue(new Error('down'))
    const out = await listRecommendedModels()
    expect(out.length).toBe(RECOMMENDED_MODELS.length)
  })
})
