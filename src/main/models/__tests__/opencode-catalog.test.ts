/**
 * Parsed from `opencode models --verbose` output captured verbatim from
 * opencode 1.18.15, not from output written to match the parser.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseOpenCodeModels } from '../opencode-catalog'

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
