import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  onPtyData,
  emitPtyData,
  attachToTerminal,
  detachFromTerminal,
  detachAll,
} from '../claude-stream'

// WebContents is import type in claude-stream.ts — no Electron mock needed.
// We pass a plain object that satisfies the runtime interface.
function makeWebContents() {
  return { isDestroyed: vi.fn(() => false), send: vi.fn() }
}

beforeEach(() => {
  detachAll()
})

describe('onPtyData / emitPtyData', () => {
  it('delivers data to a registered callback', () => {
    const received: string[] = []
    const remove = onPtyData('t1', (d) => received.push(d))
    emitPtyData('t1', 'hello')
    remove()
    expect(received).toEqual(['hello'])
  })

  it('delivers to multiple callbacks on the same terminal', () => {
    const a: string[] = []
    const b: string[] = []
    const r1 = onPtyData('t2', (d) => a.push(d))
    const r2 = onPtyData('t2', (d) => b.push(d))
    emitPtyData('t2', 'hi')
    r1()
    r2()
    expect(a).toEqual(['hi'])
    expect(b).toEqual(['hi'])
  })

  it('stops delivering after removal', () => {
    const received: string[] = []
    const remove = onPtyData('t3', (d) => received.push(d))
    remove()
    emitPtyData('t3', 'ignored')
    expect(received).toEqual([])
  })

  it('does nothing when no callbacks are registered', () => {
    expect(() => emitPtyData('unknown', 'data')).not.toThrow()
  })
})

describe('attachToTerminal — OSC title parsing', () => {
  it('sends idle status for the ✳ asterisk indicator', () => {
    const wc = makeWebContents()
    attachToTerminal('ta1', '/repo/worktree', wc as never)
    emitPtyData('ta1', '\x1b]0;✳ Claude Code\x07')
    expect(wc.send).toHaveBeenCalledWith('agent:status', {
      worktreePath: '/repo/worktree',
      status: 'idle',
      terminalId: 'ta1',
      precise: true
    })
  })

  it('sends running status for braille spinner titles', () => {
    const wc = makeWebContents()
    attachToTerminal('ta2', '/repo/worktree', wc as never)
    // ⠂ U+2802 is in the braille block
    emitPtyData('ta2', '\x1b]0;⠂ Claude Code\x07')
    expect(wc.send).toHaveBeenCalledWith('agent:status', {
      worktreePath: '/repo/worktree',
      status: 'running',
      terminalId: 'ta2',
      precise: true
    })
  })

  it('handles all braille spinner variants', () => {
    const spinners = ['⠁', '⠂', '⠄', '⠈', '⠐', '⠠', '⡀', '⢀']
    for (const spinner of spinners) {
      const wc = makeWebContents()
      attachToTerminal(`ta-spin-${spinner}`, '/repo', wc as never)
      emitPtyData(`ta-spin-${spinner}`, `\x1b]0;${spinner} Claude Code\x07`)
      expect(wc.send).toHaveBeenCalledWith('agent:status', {
        worktreePath: '/repo',
        status: 'running',
        terminalId: `ta-spin-${spinner}`,
        precise: true
      })
    }
  })

  it('ignores non-Claude OSC titles like shell prompts', () => {
    const wc = makeWebContents()
    attachToTerminal('ta3', '/repo', wc as never)
    emitPtyData('ta3', '\x1b]0;bash\x07')
    emitPtyData('ta3', '\x1b]0;vim README.md\x07')
    expect(wc.send).not.toHaveBeenCalled()
  })

  it('handles multiple OSC sequences in a single chunk', () => {
    const wc = makeWebContents()
    attachToTerminal('ta4', '/repo', wc as never)
    emitPtyData('ta4', '\x1b]0;⠂ Claude Code\x07some output\x1b]0;✳ Claude Code\x07')
    expect(wc.send).toHaveBeenCalledTimes(2)
    expect(wc.send).toHaveBeenNthCalledWith(1, 'agent:status', {
      worktreePath: '/repo',
      status: 'running',
      terminalId: 'ta4',
      precise: true
    })
    expect(wc.send).toHaveBeenNthCalledWith(2, 'agent:status', {
      worktreePath: '/repo',
      status: 'idle',
      terminalId: 'ta4',
      precise: true
    })
  })

  it('skips sending when webContents is destroyed', () => {
    const wc = { isDestroyed: vi.fn(() => true), send: vi.fn() }
    attachToTerminal('ta5', '/repo', wc as never)
    emitPtyData('ta5', '\x1b]0;✳ Claude Code\x07')
    expect(wc.send).not.toHaveBeenCalled()
  })

  it('does not double-attach the same terminal', () => {
    const wc = makeWebContents()
    attachToTerminal('ta6', '/repo', wc as never)
    attachToTerminal('ta6', '/repo', wc as never) // second attach should be a no-op
    emitPtyData('ta6', '\x1b]0;✳ Claude Code\x07')
    expect(wc.send).toHaveBeenCalledTimes(1)
  })

  it('stops sending after detach', () => {
    const wc = makeWebContents()
    attachToTerminal('ta7', '/repo', wc as never)
    detachFromTerminal('ta7')
    emitPtyData('ta7', '\x1b]0;✳ Claude Code\x07')
    expect(wc.send).not.toHaveBeenCalled()
  })

  it('accepts ST terminator (ESC \\) in addition to BEL', () => {
    const wc = makeWebContents()
    attachToTerminal('ta8', '/repo', wc as never)
    emitPtyData('ta8', '\x1b]0;✳ Claude Code\x1b\\')
    expect(wc.send).toHaveBeenCalledWith('agent:status', {
      worktreePath: '/repo',
      status: 'idle',
      terminalId: 'ta8',
      precise: true
    })
  })
})
