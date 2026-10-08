import { describe, it, expect } from 'vitest'
import {
  analyzeMemory,
  findMemoryIndex,
  normalizeMemoryKey,
  parseMemoryFrontmatter,
  type MemoryFile,
} from '../memory-health'

const f = (rel: string, content = ''): MemoryFile => ({ rel, content })
const kinds = (files: MemoryFile[]): string[] => analyzeMemory(files).map((i) => `${i.kind}:${i.rel}`)

describe('normalizeMemoryKey', () => {
  it('lowercases, strips .md and collapses whitespace/underscores', () => {
    expect(normalizeMemoryKey('  My_Note  File.md ')).toBe('my-note-file')
  })
})

describe('parseMemoryFrontmatter', () => {
  it('reads a quoted top-level name through BOM and CRLF', () => {
    expect(parseMemoryFrontmatter('﻿---\r\nname: "Deploy steps"\r\n---\r\nbody').name).toBe('Deploy steps')
  })

  it('ignores indented name keys and unclosed blocks', () => {
    expect(parseMemoryFrontmatter('---\nmeta:\n  name: nested\n---\n').name).toBeNull()
    expect(parseMemoryFrontmatter('---\nname: x\nbody').name).toBeNull()
    expect(parseMemoryFrontmatter('no frontmatter').name).toBeNull()
  })
})

describe('analyzeMemory: wiki links', () => {
  it('resolves by frontmatter name as well as basename', () => {
    const files = [
      f('MEMORY.md', '- [a](a.md)\n- [b](b.md)'),
      f('a.md', '---\nname: Release Process\n---\nsee [[release process]] and [[b]]'),
      f('b.md', 'see [[a]]'),
    ]
    expect(analyzeMemory(files)).toEqual([])
  })

  it('handles alias and heading forms', () => {
    const files = [f('x.md', '[[a|Alias]] [[a#Heading]] [[missing|shown]]'), f('a.md')]
    const issues = analyzeMemory(files)
    expect(issues.map((i) => i.message)).toEqual(['No memory named "missing"'])
  })

  it('ignores links in fenced and inline code', () => {
    const files = [f('x.md', '```\n[[nope]]\n```\n~~~md\n[[nope2]]\n~~~\nuse `[[nope3]]` or ``a [[nope4]] b``\n[[real-miss]]')]
    expect(analyzeMemory(files).map((i) => i.message)).toEqual(['No memory named "real-miss"'])
  })

  it('reports 1-based ranges around the link', () => {
    const [issue] = analyzeMemory([f('x.md', 'first\nab [[gone]] cd')])
    expect(issue).toMatchObject({ kind: 'broken-link', rel: 'x.md', line: 2, column: 4, endColumn: 12 })
  })

  it('accepts [[memory]] and relative-path keys for subfolder files', () => {
    const files = [f('x.md', '[[MEMORY]] [[topics/deep]] [[deep]]'), f('topics/deep.md')]
    expect(analyzeMemory(files)).toEqual([])
  })
})

describe('analyzeMemory: index', () => {
  it('flags index links to missing files at the link range', () => {
    const issues = analyzeMemory([f('MEMORY.md', 'intro\n- [Gone](gone.md) — x')])
    expect(issues).toEqual([
      expect.objectContaining({ kind: 'index-missing-file', rel: 'MEMORY.md', line: 2, column: 3, endColumn: 18 }),
    ])
  })

  it('resolves links without .md, with ./, URI encoding, fragments and angle brackets', () => {
    const files = [
      f('MEMORY.md', 'See [a](a) and [b](./my%20b.md#top), [c](<c.md?x=1>), inline [d](sub/d.md)'),
      f('a.md'),
      f('my b.md'),
      f('c.md'),
      f('sub/d.md'),
    ]
    expect(analyzeMemory(files)).toEqual([])
  })

  it('ignores external and anchor links', () => {
    const files = [f('MEMORY.md', '[x](https://e.com/a.md) [y](mailto:a@b) [z](#here)')]
    expect(analyzeMemory(files)).toEqual([])
  })

  it('flags root-level files not linked from the index', () => {
    const files = [f('MEMORY.md', '- [a](a.md)'), f('a.md'), f('b.md', 'title line'), f('sub/c.md'), f('notes.txt')]
    const issues = analyzeMemory(files)
    expect(kinds(files)).toEqual(['unindexed-file:b.md'])
    expect(issues[0]).toMatchObject({ line: 1, column: 1, endColumn: 11 })
  })

  it('counts a wiki link in the index as indexing the file', () => {
    const files = [f('MEMORY.md', 'see [[Deploy Steps]]'), f('deploy_steps.md')]
    expect(analyzeMemory(files)).toEqual([])
  })

  it('skips unindexed checks without an index', () => {
    expect(analyzeMemory([f('a.md'), f('b.md')])).toEqual([])
  })

  it('finds the index case-insensitively at the root only', () => {
    expect(findMemoryIndex([f('sub/MEMORY.md')])).toBeUndefined()
    expect(findMemoryIndex([f('memory.md')])?.rel).toBe('memory.md')
    expect(kinds([f('Memory.md', '- [x](x.md)'), f('x.md'), f('y.md')])).toEqual(['unindexed-file:y.md'])
  })
})
