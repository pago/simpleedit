import { describe, it, expect } from 'vitest'
import { compileSequenceDiagram } from '../mermaid-compiler'

describe('compileSequenceDiagram', () => {
  it('emits a participant declaration per actor and a message per messages entry', () => {
    const out = compileSequenceDiagram({
      kind: 'sequence',
      actors: [
        { id: 'u', label: 'User' },
        { id: 's', label: 'Server' },
      ],
      messages: [
        { from: 'u', to: 's', label: 'GET /' },
        { from: 's', to: 'u', label: '200 OK', kind: 'return' },
      ],
    })
    const lines = out.split('\n')
    expect(lines[0]).toBe('sequenceDiagram')
    expect(lines).toContain('  participant u as User')
    expect(lines).toContain('  participant s as Server')
    expect(lines.some((l) => l.includes('u->>s: GET /'))).toBe(true)
    expect(lines.some((l) => l.includes('s-->>u: 200 OK'))).toBe(true)
  })

  it('escapes label characters that would break mermaid parsing', () => {
    const out = compileSequenceDiagram({
      kind: 'sequence',
      actors: [{ id: 'a', label: 'with #hash and "quote"' }],
      messages: [
        { from: 'a', to: 'a', label: 'multi\nline\rmessage' },
      ],
    })
    expect(out).not.toContain('#')
    expect(out).not.toContain('"')
    expect(out).not.toContain('\r')
    // newlines inside labels become spaces
    expect(out.split('\n').filter((l) => l.includes('a->>a:')).length).toBe(1)
  })

  it('sanitises actor ids that contain non-word characters', () => {
    const out = compileSequenceDiagram({
      kind: 'sequence',
      actors: [{ id: 'frontend.app', label: 'Frontend' }],
      messages: [{ from: 'frontend.app', to: 'frontend.app', label: 'tick' }],
    })
    // sanitised id replaces "." with "_"
    expect(out).toContain('participant frontend_app as Frontend')
    expect(out).toContain('frontend_app->>frontend_app: tick')
  })

  it('uses sync arrow by default and --> for async/return', () => {
    const out = compileSequenceDiagram({
      kind: 'sequence',
      actors: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      messages: [
        { from: 'a', to: 'b', label: 'sync' },
        { from: 'a', to: 'b', label: 'async', kind: 'async' },
        { from: 'b', to: 'a', label: 'return', kind: 'return' },
      ],
    })
    expect(out).toContain('a->>b: sync')
    expect(out).toContain('a-->>b: async')
    expect(out).toContain('b-->>a: return')
  })
})
