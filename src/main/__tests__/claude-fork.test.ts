/**
 * Unit tests for `performFork` — the main-process orchestration that runs
 * when the renderer invokes `claude:fork`.
 *
 * We mock the pty layer (so claude doesn't actually spawn) and use a real
 * tmpdir for the JSONL copy paths, with HOME overridden so the helper
 * computes paths under our scratch space.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'simpleedit-claude-fork-test-'))
const fakeHome = join(tmpRoot, 'home')
mkdirSync(fakeHome, { recursive: true })
const originalHome = process.env.HOME
process.env.HOME = fakeHome

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  rmSync(tmpRoot, { recursive: true, force: true })
})

// Mock the pty layer so we don't try to spawn a real claude. The mock's
// behavior is configurable per-test via the `spawnForkedClaudeTerminal` spy.
vi.mock('../pty', () => ({
  spawnForkedClaudeTerminal: vi.fn(),
}))

let performFork: typeof import('../claude-fork').performFork
let spawnForkedClaudeTerminal: ReturnType<typeof vi.fn>

beforeEach(async () => {
  vi.resetModules()
  const fork = await import('../claude-fork')
  const pty = await import('../pty')
  performFork = fork.performFork
  spawnForkedClaudeTerminal = pty.spawnForkedClaudeTerminal as ReturnType<typeof vi.fn>
  spawnForkedClaudeTerminal.mockReset()
})

interface SpyWebContents {
  sent: Array<{ channel: string; payload: unknown }>
  send: (channel: string, payload: unknown) => void
  isDestroyed: () => boolean
}

function makeSpyWebContents(): SpyWebContents {
  const sent: Array<{ channel: string; payload: unknown }> = []
  return {
    sent,
    send(channel, payload) { sent.push({ channel, payload }) },
    isDestroyed: () => false,
  }
}

import { claudeProjectsDir } from '../claude-paths'

function setupSourceTranscript(
  sourceWorktreePath: string,
  sourceSessionId: string,
  body = '{}\n',
): { srcDir: string; srcJsonl: string } {
  const srcDir = claudeProjectsDir(sourceWorktreePath)
  mkdirSync(srcDir, { recursive: true })
  const srcJsonl = join(srcDir, `${sourceSessionId}.jsonl`)
  writeFileSync(srcJsonl, body)
  return { srcDir, srcJsonl }
}

describe('performFork', () => {
  it('copies the source JSONL into the target project dir and spawns the fork', async () => {
    const sourceWorktreePath = mkdtempSync(join(tmpRoot, 'src-'))
    const targetWorktreePath = mkdtempSync(join(tmpRoot, 'tgt-'))
    const sourceSessionId = '11111111-2222-3333-4444-555555555555'
    const forkUuid = '66666666-7777-8888-9999-aaaaaaaaaaaa'

    setupSourceTranscript(sourceWorktreePath, sourceSessionId, 'hello\n')

    const wc = makeSpyWebContents()
    await performFork(
      {
        sourceTerminalId: 'src-term',
        sourceSessionId,
        sourceWorktreePath,
        targetWorktreePath,
        forkUuid,
        placeholderTabId: 'fork-placeholder',
      },
      wc as unknown as Parameters<typeof performFork>[1],
    )

    // JSONL copied into the target's project dir under the SOURCE session id
    // (matches what claude --resume <src> --fork-session looks up).
    const tgtJsonl = join(claudeProjectsDir(targetWorktreePath), `${sourceSessionId}.jsonl`)
    expect(existsSync(tgtJsonl)).toBe(true)

    // PTY spawn fired with the fork's UUID + source's session id.
    expect(spawnForkedClaudeTerminal).toHaveBeenCalledOnce()
    expect(spawnForkedClaudeTerminal.mock.calls[0][0]).toEqual({
      placeholderTabId: 'fork-placeholder',
      sourceSessionId,
      targetWorktreePath,
      forkUuid,
    })

    // claude:session-id was emitted synchronously with the pre-minted forkUuid.
    const sid = wc.sent.find((e) => e.channel === 'claude:session-id')
    expect(sid).toBeDefined()
    expect((sid!.payload as { sessionId: string }).sessionId).toBe(forkUuid)

    // Success result fired.
    const result = wc.sent.find((e) => e.channel === 'claude:fork-result')
    expect(result?.payload).toEqual({ placeholderTabId: 'fork-placeholder', ok: true })
  })

  it('also copies the subagent subdir when present', async () => {
    const sourceWorktreePath = mkdtempSync(join(tmpRoot, 'src-sub-'))
    const targetWorktreePath = mkdtempSync(join(tmpRoot, 'tgt-sub-'))
    const sourceSessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const forkUuid = 'ffffffff-0000-1111-2222-333333333333'

    const { srcDir } = setupSourceTranscript(sourceWorktreePath, sourceSessionId)
    const srcSubagentDir = join(srcDir, sourceSessionId)
    mkdirSync(join(srcSubagentDir, 'subagents'), { recursive: true })
    writeFileSync(
      join(srcSubagentDir, 'subagents', 'agent-1.jsonl'),
      '{"role":"subagent"}\n',
    )

    const wc = makeSpyWebContents()
    await performFork(
      {
        sourceTerminalId: 'src',
        sourceSessionId,
        sourceWorktreePath,
        targetWorktreePath,
        forkUuid,
        placeholderTabId: 'p',
      },
      wc as unknown as Parameters<typeof performFork>[1],
    )

    const tgtSub = join(claudeProjectsDir(targetWorktreePath), sourceSessionId, 'subagents', 'agent-1.jsonl')
    expect(existsSync(tgtSub)).toBe(true)
  })

  it('errors out and rolls back when the source transcript is missing', async () => {
    const sourceWorktreePath = mkdtempSync(join(tmpRoot, 'src-missing-'))
    const targetWorktreePath = mkdtempSync(join(tmpRoot, 'tgt-missing-'))
    const sourceSessionId = '99999999-aaaa-bbbb-cccc-dddddddddddd'
    const forkUuid = '88888888-aaaa-bbbb-cccc-dddddddddddd'

    // Don't create the source transcript — performFork should fail cleanly.

    const wc = makeSpyWebContents()
    await performFork(
      {
        sourceTerminalId: 'src',
        sourceSessionId,
        sourceWorktreePath,
        targetWorktreePath,
        forkUuid,
        placeholderTabId: 'p',
      },
      wc as unknown as Parameters<typeof performFork>[1],
    )

    expect(spawnForkedClaudeTerminal).not.toHaveBeenCalled()

    const result = wc.sent.find((e) => e.channel === 'claude:fork-result')
    expect(result?.payload).toMatchObject({
      placeholderTabId: 'p',
      ok: false,
    })
    expect(
      (result!.payload as { error: string }).error,
    ).toContain('source session transcript not found')

    // Nothing copied into the target dir.
    const tgtJsonl = join(claudeProjectsDir(targetWorktreePath), `${sourceSessionId}.jsonl`)
    expect(existsSync(tgtJsonl)).toBe(false)
  })

  it('refuses to spawn (and emits an error) when forkUuid === sourceSessionId', async () => {
    const sourceWorktreePath = mkdtempSync(join(tmpRoot, 'src-collide-'))
    const targetWorktreePath = mkdtempSync(join(tmpRoot, 'tgt-collide-'))
    const sourceSessionId = 'cafebabe-1111-2222-3333-444444444444'

    // Don't even prepare a source transcript — the collision check fires before
    // we touch the FS, by design.

    const wc = makeSpyWebContents()
    await performFork(
      {
        sourceTerminalId: 'src',
        sourceSessionId,
        sourceWorktreePath,
        targetWorktreePath,
        forkUuid: sourceSessionId, // <-- collision
        placeholderTabId: 'p',
      },
      wc as unknown as Parameters<typeof performFork>[1],
    )

    expect(spawnForkedClaudeTerminal).not.toHaveBeenCalled()
    const result = wc.sent.find((e) => e.channel === 'claude:fork-result')
    expect(result?.payload).toMatchObject({
      placeholderTabId: 'p',
      ok: false,
    })
    expect((result!.payload as { error: string }).error).toContain('fork uuid collision')
  })

  it('rolls back the copied JSONL when spawnForkedClaudeTerminal throws', async () => {
    const sourceWorktreePath = mkdtempSync(join(tmpRoot, 'src-rollback-'))
    const targetWorktreePath = mkdtempSync(join(tmpRoot, 'tgt-rollback-'))
    const sourceSessionId = '12345678-1234-1234-1234-123456789abc'
    const forkUuid = 'abcdef00-1234-1234-1234-123456789abc'

    setupSourceTranscript(sourceWorktreePath, sourceSessionId)

    spawnForkedClaudeTerminal.mockImplementation(() => {
      throw new Error('simulated spawn failure')
    })

    const wc = makeSpyWebContents()
    await performFork(
      {
        sourceTerminalId: 'src',
        sourceSessionId,
        sourceWorktreePath,
        targetWorktreePath,
        forkUuid,
        placeholderTabId: 'p',
      },
      wc as unknown as Parameters<typeof performFork>[1],
    )

    // Size of the freshly-copied JSONL is unchanged (no claude touched it),
    // so rollback should unlink it.
    const tgtJsonl = join(claudeProjectsDir(targetWorktreePath), `${sourceSessionId}.jsonl`)
    expect(existsSync(tgtJsonl)).toBe(false)

    const result = wc.sent.find((e) => e.channel === 'claude:fork-result')
    expect(result?.payload).toMatchObject({ ok: false })
    expect((result!.payload as { error: string }).error).toContain('simulated spawn failure')
  })
})
