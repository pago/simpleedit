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

import type { RemoteClient } from '../client-hub'
import {
  spawnTerminal,
  claimTerminal,
  getTerminalOwner,
  resizeTerminal,
  releaseTerminalsOwnedBy,
  killTerminal,
  killAllTerminals,
} from '../pty'

// Two transports of ONE hub: same `id` (the window they share), different
// client keys. That is the case ownership has to arbitrate, and the case a
// hub-id-keyed owner map could not see at all.
const OWNER = '1'
const OTHER = 'w1.1'

// Typed rather than cast: these tests exist to check the ownership contract,
// and an `as never` here would hide the very signature it depends on.
const hubSend = vi.fn<(channel: string, data: unknown) => void>()
const hub: RemoteClient = { id: 1, send: hubSend, isDestroyed: () => false }

beforeEach(() => {
  hubSend.mockClear()
})

/** Spawn a plain terminal owned by `clientKey`; returns its fake PTY. */
function spawnFor(id: string, clientKey: string): FakePty {
  nextSpawnKey = id
  spawnTerminal({ id, worktreePath: tmpdir() }, hub, clientKey)
  const fake = spawned.get(id)
  if (!fake) throw new Error(`no PTY spawned for ${id}`)
  return fake
}

/** Claim without handing over a usable geometry (0×0 is skipped, as in a hidden tab). */
function claim(id: string, clientKey: string, cols = 0, rows = 0): void {
  claimTerminal(id, clientKey, hub, cols, rows)
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
    claim('t4', OTHER)
    expect(term.resize).not.toHaveBeenCalled()
  })

  it('transfers ownership on claim, so the old owner stops sizing it', () => {
    const term = spawnFor('t5', OWNER)
    claim('t5', OTHER)
    expect(getTerminalOwner('t5')).toBe(OTHER)

    resizeTerminal('t5', 100, 30, OWNER)
    expect(term.resize).not.toHaveBeenCalled()

    resizeTerminal('t5', 100, 30, OTHER)
    expect(term.resize).toHaveBeenCalledWith(100, 30)
  })

  it('last claim wins when two clients claim in turn', () => {
    spawnFor('t6', OWNER)
    claim('t6', OTHER)
    claim('t6', OWNER)
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
    claim('t12', OTHER)
    expect(hubSend).toHaveBeenCalledWith('pty:owner-changed', { id: 't12', owner: OTHER })
  })

  // The client that needs telling is the one that LOST the size. A second
  // window is a second hub, so sending only to the claimer's client would
  // leave the loser fitting its xterm to a width the PTY no longer uses.
  it('tells the client that spawned the terminal, not just the one claiming it', () => {
    const spawnerSend = vi.fn<(channel: string, data: unknown) => void>()
    const spawner: RemoteClient = { id: 2, send: spawnerSend, isDestroyed: () => false }
    nextSpawnKey = 't18'
    spawnTerminal({ id: 't18', worktreePath: tmpdir() }, spawner, '2')

    // A different window entirely — a different hub — takes the size.
    claimTerminal('t18', OWNER, hub, 100, 30)

    expect(spawnerSend).toHaveBeenCalledWith('pty:owner-changed', { id: 't18', owner: OWNER })
    expect(hubSend).toHaveBeenCalledWith('pty:owner-changed', { id: 't18', owner: OWNER })
  })

  it('drops a client that has gone away rather than sending into it', () => {
    const goneSend = vi.fn<(channel: string, data: unknown) => void>()
    const gone: RemoteClient = { id: 3, send: goneSend, isDestroyed: () => true }
    nextSpawnKey = 't19'
    spawnTerminal({ id: 't19', worktreePath: tmpdir() }, gone, '3')

    claimTerminal('t19', OWNER, hub, 100, 30)

    expect(goneSend).not.toHaveBeenCalled()
    expect(hubSend).toHaveBeenCalledWith('pty:owner-changed', { id: 't19', owner: OWNER })
  })

  // A transport can vanish without any terminal knowing: a phone locks its
  // screen and its socket closes. Nothing else releases the claim, and
  // `pty:claim` only fires on a focus/visibility CHANGE — so a desktop window
  // already sitting on the terminal never reclaims and never recovers.
  it('releases the claim of a client that has gone', () => {
    spawnFor('t20', OWNER)
    claim('t20', OTHER)
    releaseTerminalsOwnedBy(OTHER)
    expect(getTerminalOwner('t20')).toBeUndefined()
  })

  it('lets any client size a terminal nobody owns', () => {
    const term = spawnFor('t21', OWNER)
    claim('t21', OTHER)
    releaseTerminalsOwnedBy(OTHER)
    resizeTerminal('t21', 90, 25, OWNER)
    expect(term.resize).toHaveBeenCalledWith(90, 25)
  })

  it('does not hand ownership to whoever resizes an unowned terminal', () => {
    spawnFor('t22', OWNER)
    claim('t22', OTHER)
    releaseTerminalsOwnedBy(OTHER)
    resizeTerminal('t22', 90, 25, OWNER)
    expect(getTerminalOwner('t22')).toBeUndefined()
  })

  it('announces the release, so the loser stops saying it lost the size', () => {
    spawnFor('t23', OWNER)
    claim('t23', OTHER)
    hubSend.mockClear()
    releaseTerminalsOwnedBy(OTHER)
    expect(hubSend).toHaveBeenCalledWith('pty:owner-changed', { id: 't23', owner: null })
  })

  it('leaves terminals owned by anyone else alone', () => {
    spawnFor('t24', OWNER)
    spawnFor('t25', OTHER)
    releaseTerminalsOwnedBy(OTHER)
    expect(getTerminalOwner('t24')).toBe(OWNER)
    expect(getTerminalOwner('t25')).toBeUndefined()
  })

  it('stays quiet when the current owner re-claims', () => {
    spawnFor('t13', OWNER)
    claim('t13', OWNER)
    expect(hubSend).not.toHaveBeenCalled()
  })

  // The regression this whole call shape exists for: while a client is not the
  // owner its resizes are dropped, so its container can reflow unheard. Taking
  // ownership back has to bring the current geometry with it, or the PTY sits
  // at a size nothing on screen matches until some later resize fixes it by luck.
  it('applies the geometry that comes with a claim', () => {
    const term = spawnFor('t14', OWNER)
    claim('t14', OTHER, 132, 43)
    expect(term.resize).toHaveBeenCalledWith(132, 43)
    expect(getTerminalOwner('t14')).toBe(OTHER)
  })

  it('applies a claim geometry even when the claimer already owned it', () => {
    const term = spawnFor('t15', OWNER)
    claim('t15', OWNER, 100, 30)
    expect(term.resize).toHaveBeenCalledWith(100, 30)
    // Ownership did not move, so there is nothing to announce.
    expect(hubSend).not.toHaveBeenCalled()
  })

  it('ignores a zero-sized claim, which is what a hidden container fits to', () => {
    const term = spawnFor('t16', OWNER)
    claim('t16', OTHER, 0, 0)
    expect(term.resize).not.toHaveBeenCalled()
    expect(getTerminalOwner('t16')).toBe(OTHER)
  })

  // `pty:exit` drops the owner entry while the component stays mounted, so an
  // unguarded claim would re-insert one per focus and never reclaim it — and
  // would let a client name a terminal it was never attached to.
  it('ignores a claim on a terminal that no longer exists', () => {
    const term = spawnFor('t17', OWNER)
    term.exit(0)
    hubSend.mockClear() // the exit itself pushes pty:exit
    claim('t17', OTHER, 90, 30)
    expect(getTerminalOwner('t17')).toBeUndefined()
    expect(hubSend).not.toHaveBeenCalled()
  })

  it('ignores a claim on an id that was never spawned', () => {
    claim('never-spawned-claim', OWNER, 90, 30)
    expect(getTerminalOwner('never-spawned-claim')).toBeUndefined()
  })

  it('does not resize an unowned terminal id', () => {
    resizeTerminal('never-spawned', 90, 30, OWNER)
    expect(getTerminalOwner('never-spawned')).toBeUndefined()
  })
})
