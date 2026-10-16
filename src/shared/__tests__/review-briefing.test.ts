import { describe, expect, it } from 'vitest'
import { BRIEFING_EXCERPT_MAX, finishBriefing, parseBriefingInput, renderBriefingMarkdown } from '../review-briefing'

describe('parseBriefingInput', () => {
  it('reads one layer from top-level fields, dropping unknown fields and control characters', () => {
    const parsed = parseBriefingInput({ what: 'Adds\u0007 a\r\nlimit', why: 42, extra: 'x', open_questions: ['Ship it?', { text: '' }] }, 7)
    expect(parsed.layers).toEqual([
      { pr: 7, briefing: { what: 'Adds  a\nlimit', why: '', impact: '', readingOrder: [], openQuestions: [{ text: 'Ship it?' }], evidence: [] } },
    ])
    expect(parsed.layers[0]!.briefing).not.toHaveProperty('extra')
  })

  it('reads a stack: a summary and one briefing per PR, refusing a PR named twice', () => {
    const parsed = parseBriefingInput({ summary: 'Two steps', layers: [{ pr: 1, what: 'a' }, { pr: 2, what: 'b' }, { pr: 3 }] }, 2)
    expect(parsed.stack).toEqual({ summary: 'Two steps' })
    // An empty layer briefing says nothing, so it isn't kept.
    expect(parsed.layers.map((l) => [l.pr, l.briefing.what])).toEqual([[1, 'a'], [2, 'b']])
    expect(() => parseBriefingInput({ layers: [{ pr: 1 }, { pr: 1 }] }, 1)).toThrow('twice')
    expect(() => parseBriefingInput({ layers: [{ what: 'x' }] }, 1)).toThrow('needs `pr`')
    expect(() => parseBriefingInput('nope', 1)).toThrow('must be an object')
    expect(parseBriefingInput(undefined, 1)).toEqual({ layers: [], notes: [] })
  })

  it('caps sections, questions and evidence, says so, and cuts an output excerpt', () => {
    const parsed = parseBriefingInput({
      reading_order: Array.from({ length: 60 }, (_, i) => ({ title: `s${i}` })),
      open_questions: Array.from({ length: 40 }, (_, i) => `q${i}`),
      evidence: [
        { command: 'pnpm test', output_excerpt: 'x'.repeat(BRIEFING_EXCERPT_MAX + 100), exit_code: 1 },
        ...Array.from({ length: 12 }, () => ({ command: 'c' })),
      ],
    }, 1)
    const b = parsed.layers[0]!.briefing
    expect([b.readingOrder.length, b.openQuestions.length, b.evidence.length]).toEqual([50, 30, 10])
    expect(b.evidence[0]).toMatchObject({ command: 'pnpm test', exitCode: 1 })
    expect(b.evidence[0]!.outputExcerpt.length).toBe(BRIEFING_EXCERPT_MAX + 1)
    expect(parsed.notes).toHaveLength(3)
  })

  it('drops bidi overrides and zero-width characters, which could disguise a path or command', () => {
    const parsed = parseBriefingInput({ evidence: [{ command: 'pnpm \u202etset\u202c\u200b test' }] }, 1)
    expect(parsed.layers[0]!.briefing.evidence[0]!.command).toBe('pnpm tset test')
  })

  it('refuses a layer over 20 KB, and paths that climb out', () => {
    expect(() => parseBriefingInput({ what: 'x'.repeat(4000), why: 'y'.repeat(4000), impact: 'z'.repeat(4000), reading_order: Array.from({ length: 10 }, () => ({ title: 't', summary: 's'.repeat(2000) })) }, 1))
      .toThrow('the limit is 20480')
    const parsed = parseBriefingInput({ reading_order: [{ title: 't', refs: [{ path: '../etc/passwd' }, { path: './src/a.ts', start_line: 9, end_line: 3 }] }] }, 1)
    expect(parsed.layers[0]!.briefing.readingOrder[0]!.refs).toEqual([{ path: 'src/a.ts', startLine: 9, endLine: 9 }])
  })
})

describe('finishBriefing', () => {
  it('keeps refs and question paths only when they resolve in the review diff, and stamps the head', () => {
    const { layers } = parseBriefingInput({
      reading_order: [{ title: 'Core', refs: [{ path: 'a.ts' }, { path: 'lib/gone.ts' }] }],
      open_questions: [{ text: 'Why?', path: 'nowhere.ts', line: 3 }, { text: 'Here?', path: 'src/a.ts', line: 2 }],
    }, 1)
    const { briefing, dropped } = finishBriefing(layers[0]!.briefing, ['src/a.ts', 'src/b.ts'], 'head1')
    expect(dropped).toBe(2)
    expect(briefing.forHead).toBe('head1')
    expect(briefing.readingOrder[0]!.refs).toEqual([{ path: 'src/a.ts' }])
    expect(briefing.openQuestions).toEqual([{ text: 'Why?' }, { text: 'Here?', path: 'src/a.ts', line: 2 }])
  })
})

describe('renderBriefingMarkdown', () => {
  it('says when no evidence was attached, so the overview can flag unbacked claims', () => {
    const { briefing } = finishBriefing(parseBriefingInput({ what: 'Tests pass.' }, 1).layers[0]!.briefing, [], 'h')
    expect(renderBriefingMarkdown(briefing, 'Stack')).toBe('## Stack\nStack\n\n## What changed\nTests pass.\n\n## Evidence the author reports\n(none)')
  })
})
