import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'

// node-pty is a native module, and pty.ts (via its providers) touches electron.
// The fake PTY records resize calls and lets a test drive `onExit` by hand.
interface FakePty {
  resize: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  exit: (code: number) => void
}
const spawned = new Map<string, FakePty>()
let nextSpawnKey = ''

vi.mock('node-pty', () => ({
  spawn: () => {
    let onExit: (e: { exitCode: number }) => void = () => {}
    const fake: FakePty = {
      resize: vi.fn(),
      kill: vi.fn(),
      exit: (code: number) => onExit({ exitCode: code }),
    }
    spawned.set(nextSpawnKey, fake)
    return {
      ...fake,
      write: vi.fn(),
      onData: () => {},
      onExit: (cb: (e: { exitCode: number }) => void) => { onExit = cb },
    }
  },
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/app', getPath: () => tmpdir() },
}))

import {
  spawnTerminal,
  claimTerminal,
  getTerminalOwner,
  resizeTerminal,
  killTerminal,
  killAllTerminals,
} from '../pty'

// Two transports of ONE hub: same `id` (the window they share), different
// client keys. That is the case ownership has to arbitrate, and the case a
// hub-id-keyed owner map could not see at all.
const OWNER = '1'
const OTHER = 'w1.1'

const hub = { id: 1, isDestroyed: () => false, send: vi.fn() }

beforeEach(() => {
  hub.send.mockClear()
})

/** Spawn a plain terminal owned by `clientKey`; returns its fake PTY. */
function spawnFor(id: string, clientKey: string): FakePty {
  nextSpawnKey = id
  spawnTerminal({ id, worktreePath: tmpdir() }, hub as never, clientKey)
  const fake = spawned.get(id)
  if (!fake) throw new Error(`no PTY spawned for ${id}`)
  return fake
}

beforeEach(() => {
  spawned.clear()
})

afterEach(() => {
  killAllTerminals()
})

describe('PTY size ownership', () => {
  it('makes the spawning client the initial owner', () => {
    spawnFor('t1', OWNER)
    expect(getTerminalOwner('t1')).toBe(OWNER)
  })

  it('applies a resize from the owner', () => {
    const term = spawnFor('t2', OWNER)
    resizeTerminal('t2', 120, 40, OWNER)
    expect(term.resize).toHaveBeenCalledWith(120, 40)
  })

  it('drops a resize from a non-owner', () => {
    const term = spawnFor('t3', OWNER)
    resizeTerminal('t3', 80, 24, OTHER)
    expect(term.resize).not.toHaveBeenCalled()
  })

  it('does not queue a dropped resize — a later claim replays nothing', () => {
    const term = spawnFor('t4', OWNER)
    resizeTerminal('t4', 80, 24, OTHER)
    claimTerminal('t4', OTHER, hub as never)
    expect(term.resize).not.toHaveBeenCalled()
  })

  it('transfers ownership on claim, so the old owner stops sizing it', () => {
    const term = spawnFor('t5', OWNER)
    claimTerminal('t5', OTHER, hub as never)
    expect(getTerminalOwner('t5')).toBe(OTHER)

    resizeTerminal('t5', 100, 30, OWNER)
    expect(term.resize).not.toHaveBeenCalled()

    resizeTerminal('t5', 100, 30, OTHER)
    expect(term.resize).toHaveBeenCalledWith(100, 30)
  })

  it('last claim wins when two clients claim in turn', () => {
    spawnFor('t6', OWNER)
    claimTerminal('t6', OTHER, hub as never)
    claimTerminal('t6', OWNER, hub as never)
    expect(getTerminalOwner('t6')).toBe(OWNER)
  })

  it('ignores a zero-sized resize even from the owner', () => {
    const term = spawnFor('t7', OWNER)
    resizeTerminal('t7', 0, 0, OWNER)
    expect(term.resize).not.toHaveBeenCalled()
  })

  it('drops the owner entry when the PTY exits', () => {
    const term = spawnFor('t8', OWNER)
    term.exit(0)
    expect(getTerminalOwner('t8')).toBeUndefined()
  })

  it('drops the owner entry when the terminal is killed', () => {
    spawnFor('t9', OWNER)
    killTerminal('t9')
    expect(getTerminalOwner('t9')).toBeUndefined()
  })

  it('drops every owner entry when all terminals are killed', () => {
    spawnFor('t10', OWNER)
    spawnFor('t11', OTHER)
    killAllTerminals()
    expect(getTerminalOwner('t10')).toBeUndefined()
    expect(getTerminalOwner('t11')).toBeUndefined()
  })

  it('tells every transport of the hub when the size moves to another', () => {
    spawnFor('t12', OWNER)
    claimTerminal('t12', OTHER, hub as never)
    expect(hub.send).toHaveBeenCalledWith('pty:owner-changed', { id: 't12', owner: OTHER })
  })

  it('stays quiet when the current owner re-claims', () => {
    spawnFor('t13', OWNER)
    claimTerminal('t13', OWNER, hub as never)
    expect(hub.send).not.toHaveBeenCalled()
  })

  it('does not resize an unowned terminal id', () => {
    resizeTerminal('never-spawned', 90, 30, OWNER)
    expect(getTerminalOwner('never-spawned')).toBeUndefined()
  })
})
