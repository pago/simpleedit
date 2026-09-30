import { describe, it, expect } from 'vitest'
import { parseOverview, extractRefs, resolveRefPath } from '../pr-overview'

/** A well-formed answer in the shape the overview contract asks for. */
const WELL_FORMED = `## What changed
Adds a raw-text mode to the task runner (\`src/main/agent-tasks/runner.ts:25\`) so a task can take
the model's final answer as markdown.

- Each runner reads its own final message.
- JSON mode is unchanged.

## Why
The overview answer is prose; scanning it for \`{…}\` would pick up braces in code spans.

## Impact
New optional \`output\` field on \`RunRequest\`. No behaviour change for existing tasks.

## Look into
1. Does Codex's last \`agent_message\` always hold the whole answer? \`src/main/agent-tasks/runner.ts:590-604\`
2. Is swallowing a throwing \`parse\` right for text mode?
   See \`src/main/agent-tasks/runner.ts:92\` and \`src/main/agent-tasks/orchestrator.ts:44\`.
3. Should the parser live in \`shared/\`? \`src/shared/pr-overview.ts\`
`

describe('parseOverview — well-formed', () => {
  const parsed = parseOverview(WELL_FORMED)

  it('is well-formed and keeps the raw text verbatim', () => {
    expect(parsed.wellFormed).toBe(true)
    expect(parsed.raw).toBe(WELL_FORMED)
  })

  it('splits the prose sections, trimmed, with their inner markdown intact', () => {
    expect(parsed.sections.what).toBe(
      'Adds a raw-text mode to the task runner (`src/main/agent-tasks/runner.ts:25`) so a task can take\n' +
        "the model's final answer as markdown.\n\n- Each runner reads its own final message.\n- JSON mode is unchanged."
    )
    expect(parsed.sections.why).toMatch(/^The overview answer is prose/)
    expect(parsed.sections.impact).toBe('New optional `output` field on `RunRequest`. No behaviour change for existing tasks.')
  })

  it('splits Look into into one item per number, continuation lines included', () => {
    const items = parsed.sections.lookInto ?? []
    expect(items).toHaveLength(3)
    expect(items[0].markdown).toBe(
      "Does Codex's last `agent_message` always hold the whole answer? `src/main/agent-tasks/runner.ts:590-604`"
    )
    expect(items[1].markdown).toBe(
      'Is swallowing a throwing `parse` right for text mode?\n' +
        'See `src/main/agent-tasks/runner.ts:92` and `src/main/agent-tasks/orchestrator.ts:44`.'
    )
  })

  it('extracts the refs of each item, ranges and bare paths included', () => {
    const refs = (parsed.sections.lookInto ?? []).map((i) => i.refs)
    expect(refs).toEqual([
      [{ path: 'src/main/agent-tasks/runner.ts', line: '590-604' }],
      [
        { path: 'src/main/agent-tasks/runner.ts', line: '92' },
        { path: 'src/main/agent-tasks/orchestrator.ts', line: '44' },
      ],
      [{ path: 'src/shared/pr-overview.ts' }],
    ])
  })
})

describe('parseOverview — tolerated variation', () => {
  it('accepts CRLF line endings, trailing whitespace and surrounding blank lines', () => {
    const text = `\n\n## What changed  \r\nA.\r\n\r\n## Why\t\r\nB.\r\n## Impact\r\nC.\r\n## Look into\r\n1. Q? \`a/b.ts:1\`  \r\n\n`
    const parsed = parseOverview(text)
    expect(parsed.wellFormed).toBe(true)
    expect(parsed.sections.what).toBe('A.')
    expect(parsed.sections.lookInto?.[0].refs).toEqual([{ path: 'a/b.ts', line: '1' }])
  })

  it('matches headings case-insensitively, at levels 1–3, with a trailing colon or closing hashes', () => {
    const parsed = parseOverview('# WHAT CHANGED\nA\n### why:\nB\n## Impact ##\nC\n##   Look  Into\n1. Q')
    expect(parsed.wellFormed).toBe(true)
    expect(parsed.sections).toMatchObject({ what: 'A', why: 'B', impact: 'C' })
  })

  it("accepts the /pr-overview skill's own heading names", () => {
    const parsed = parseOverview(
      '## What changed\nA\n## Why\nB\n## Impact / public API\nC\n## What to look into in more detail\n1. Q'
    )
    expect(parsed.wellFormed).toBe(true)
    expect(parsed.sections.impact).toBe('C')
    expect(parsed.sections.lookInto).toHaveLength(1)
  })

  it('accepts the sections in any order', () => {
    const parsed = parseOverview('## Why\nB\n## What changed\nA\n## Look into\n1. Q\n## Impact\nC')
    expect(parsed.wellFormed).toBe(true)
    expect(parsed.sections).toMatchObject({ what: 'A', why: 'B', impact: 'C' })
  })

  it('unwraps an answer the model fenced as a whole in ```markdown', () => {
    const parsed = parseOverview('```markdown\n## What changed\nA\n## Why\nB\n## Impact\nC\n## Look into\n1. Q\n```')
    expect(parsed.wellFormed).toBe(true)
    expect(parsed.sections.what).toBe('A')
  })

  it('keeps level-3+ sub-headings inside a section as its content', () => {
    const parsed = parseOverview('## What changed\n### Main process\nA\n#### Detail\nB\n## Why\nB\n## Impact\nC\n## Look into\n1. Q')
    expect(parsed.wellFormed).toBe(true)
    expect(parsed.sections.what).toBe('### Main process\nA\n#### Detail\nB')
  })

  it('ignores heading-looking lines inside fenced code', () => {
    const parsed = parseOverview(
      '## What changed\nNew config:\n```yaml\n## Why\nkey: 1\n```\n## Why\nB\n## Impact\nC\n## Look into\n1. Q'
    )
    expect(parsed.wellFormed).toBe(true)
    expect(parsed.sections.what).toBe('New config:\n```yaml\n## Why\nkey: 1\n```')
    expect(parsed.sections.why).toBe('B')
  })

  it('accepts `1)` numbering and a bulleted Look into list', () => {
    const numbered = parseOverview('## What changed\nA\n## Why\nB\n## Impact\nC\n## Look into\n1) One\n2) Two')
    expect(numbered.sections.lookInto?.map((i) => i.markdown)).toEqual(['One', 'Two'])
    const bulleted = parseOverview('## What changed\nA\n## Why\nB\n## Impact\nC\n## Look into\n- One\n* Two')
    expect(bulleted.wellFormed).toBe(true)
    expect(bulleted.sections.lookInto?.map((i) => i.markdown)).toEqual(['One', 'Two'])
  })

  it('keeps a nested list and blank-separated indented paragraphs inside their item', () => {
    const parsed = parseOverview(
      '## What changed\nA\n## Why\nB\n## Impact\nC\n## Look into\n' +
        '1. First\n   - sub one `a/x.ts:3`\n   - sub two\n\n   More on first.\n2. Second'
    )
    expect(parsed.wellFormed).toBe(true)
    const items = parsed.sections.lookInto ?? []
    expect(items).toHaveLength(2)
    expect(items[0].markdown).toBe('First\n- sub one `a/x.ts:3`\n- sub two\n\nMore on first.')
    expect(items[0].refs).toEqual([{ path: 'a/x.ts', line: '3' }])
  })

  it('treats an empty section as present', () => {
    const parsed = parseOverview('## What changed\nA\n## Why\n\n## Impact\nC\n## Look into\n')
    expect(parsed.wellFormed).toBe(true)
    expect(parsed.sections.why).toBe('')
    expect(parsed.sections.lookInto).toEqual([])
  })
})

describe('parseOverview — not well-formed (raw is rendered instead)', () => {
  const SECTIONS = '## What changed\nA\n## Why\nB\n## Impact\nC\n## Look into\n1. Q'

  it('rejects a preamble before the first heading', () => {
    const parsed = parseOverview(`Here is the overview you asked for:\n\n${SECTIONS}`)
    expect(parsed.wellFormed).toBe(false)
    // Sections are still parsed on a best-effort basis.
    expect(parsed.sections.what).toBe('A')
  })

  it('rejects a title or metadata line', () => {
    expect(parseOverview(`**#123 Add text mode** · @pago · draft\n\n${SECTIONS}`).wellFormed).toBe(false)
    expect(parseOverview(`# PR #123 overview\n${SECTIONS}`).wellFormed).toBe(false)
  })

  it('rejects a missing section', () => {
    const parsed = parseOverview('## What changed\nA\n## Why\nB\n## Look into\n1. Q')
    expect(parsed.wellFormed).toBe(false)
    expect(parsed.sections.impact).toBeUndefined()
  })

  it('rejects an unknown top-level section', () => {
    expect(parseOverview(`${SECTIONS}\n## Verdict\nShip it.`).wellFormed).toBe(false)
    expect(parseOverview(`## Summary\nX\n${SECTIONS}`).wellFormed).toBe(false)
  })

  it('rejects a duplicated section', () => {
    expect(parseOverview(`${SECTIONS}\n## Why\nAgain.`).wellFormed).toBe(false)
  })

  it('rejects text in Look into that belongs to no item', () => {
    expect(parseOverview('## What changed\nA\n## Why\nB\n## Impact\nC\n## Look into\nHighest first:\n1. Q').wellFormed).toBe(false)
    expect(parseOverview(`${SECTIONS}\n\nWant a deep review? Run it.`).wellFormed).toBe(false)
    expect(parseOverview('## What changed\nA\n## Why\nB\n## Impact\nC\n## Look into\nJust prose, no list.').wellFormed).toBe(false)
  })

  it('rejects the old bold-label shape, which has no headings at all', () => {
    const parsed = parseOverview('**What changed**\nA\n\n**Why**\nB\n\n**Impact / public API**\nC\n\n**What to look into in more detail**\n1. Q')
    expect(parsed.wellFormed).toBe(false)
    expect(parsed.sections).toEqual({})
  })

  it('rejects empty output', () => {
    expect(parseOverview('').wellFormed).toBe(false)
    expect(parseOverview('   \n').wellFormed).toBe(false)
  })
})

describe('extractRefs', () => {
  it('reads single lines, hyphen and en-dash ranges, columns and GitHub #L anchors', () => {
    expect(extractRefs('`a/b.ts:12` `a/c.ts:12-18` `a/d.ts:3–9` `a/e.ts:7:14` `a/f.ts#L5-L8` `a/g.ts#L2`')).toEqual([
      { path: 'a/b.ts', line: '12' },
      { path: 'a/c.ts', line: '12-18' },
      { path: 'a/d.ts', line: '3-9' },
      { path: 'a/e.ts', line: '7' },
      { path: 'a/f.ts', line: '5-8' },
      { path: 'a/g.ts', line: '2' },
    ])
  })

  it('reads several refs out of one span and drops duplicates', () => {
    expect(extractRefs('`a/b.ts:1, a/c.ts:2` then `a/b.ts:1` again')).toEqual([
      { path: 'a/b.ts', line: '1' },
      { path: 'a/c.ts', line: '2' },
    ])
  })

  it('strips a leading ./ and keeps bracketed route segments', () => {
    expect(extractRefs('`./src/x.ts:4` `app/[id]/page.tsx`')).toEqual([
      { path: 'src/x.ts', line: '4' },
      { path: 'app/[id]/page.tsx' },
    ])
  })

  it('accepts a slash-less name only with a known extension or a line', () => {
    expect(extractRefs('`package.json` `CLAUDE.md` `.gitignore` `foo.xyz:3`')).toEqual([
      { path: 'package.json' },
      { path: 'CLAUDE.md' },
      { path: '.gitignore' },
      { path: 'foo.xyz', line: '3' },
    ])
  })

  it('ignores identifiers, branches, hosts, URLs, versions and directories', () => {
    expect(
      extractRefs(
        '`Array.from` `store.get()` `origin/main` `localhost:3000` `https://github.com/a/b.ts` `v1.2.3` `src/main/` `{a: 1}` `runTask`'
      )
    ).toEqual([])
  })

  it('ignores citations outside backticks', () => {
    expect(extractRefs('See src/a.ts:12 for details.')).toEqual([])
  })

  it('reads double-backtick spans', () => {
    expect(extractRefs('``src/a.ts:3``')).toEqual([{ path: 'src/a.ts', line: '3' }])
  })
})

describe('resolveRefPath', () => {
  const paths = ['packages/ui/src/Table/table-body.tsx', 'packages/ui/src/Table/types.ts', 'packages/next/src/types.ts']

  it('takes an exact path as is', () => {
    expect(resolveRefPath(paths, 'packages/ui/src/Table/types.ts')).toBe('packages/ui/src/Table/types.ts')
  })

  it('finds the one diff path a shortened citation ends with', () => {
    expect(resolveRefPath(paths, 'Table/table-body.tsx')).toBe('packages/ui/src/Table/table-body.tsx')
  })

  it('refuses to guess between several, or on a partial segment', () => {
    expect(resolveRefPath(paths, 'types.ts')).toBeUndefined()
    expect(resolveRefPath(paths, 'able-body.tsx')).toBeUndefined()
    expect(resolveRefPath(paths, 'src/missing.ts')).toBeUndefined()
  })
})
