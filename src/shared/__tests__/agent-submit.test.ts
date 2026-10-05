import { describe, it, expect } from 'vitest'
import { agentSubmitWrite } from '../agent-submit'

describe('agentSubmitWrite', () => {
  it('wraps the text in bracketed-paste markers and submits after them', () => {
    expect(agentSubmitWrite('ship it')).toBe('\x1b[200~ship it\x1b[201~\r')
  })

  it('keeps newlines inside the paste, so only the final CR submits', () => {
    expect(agentSubmitWrite('one\r\ntwo\rthree')).toBe('\x1b[200~one\ntwo\nthree\x1b[201~\r')
  })

  it('cannot be ended early by a marker in the text', () => {
    expect(agentSubmitWrite('a\x1b[201~\rb\x1b[200~')).toBe('\x1b[200~a\nb\x1b[201~\r')
  })
})
