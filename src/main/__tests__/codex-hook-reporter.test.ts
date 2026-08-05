/**
 * The Codex hook reporter, end to end against a stub bridge.
 *
 * This is the whole agent-to-agent messaging channel for Codex: Codex runs the
 * reporter as a `command` hook, the reporter POSTs the hook payload to the
 * bridge, and whatever the bridge answers is written back to stdout — where a
 * `{"decision":"block","reason":…}` feeds a peer's message into Codex's next
 * turn. Discard the response and Codex can send mail but never receive it.
 *
 * Runs the real built reporter (`out/mcp-server/index.mjs`) as a subprocess, so
 * it also covers the argv/env contract rather than just the logic.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { spawn, spawnSync } from 'child_process'
import { createServer, type Server } from 'http'
import { existsSync } from 'fs'
import { join } from 'path'
import { AddressInfo } from 'net'

const REPORTER = join(process.cwd(), 'out', 'mcp-server', 'index.mjs')

beforeAll(() => {
  // The reporter is a build artifact; build it if this is a bare checkout.
  if (!existsSync(REPORTER)) {
    spawnSync('node', ['scripts/build-mcp-server.mjs'], { cwd: process.cwd(), stdio: 'inherit' })
  }
}, 120_000)

/** A stub bridge that records what it received and replies with `reply`. */
function stubBridge(reply: unknown, status = 200): Promise<{
  server: Server; port: number; token: string; received: () => unknown[]
}> {
  const token = 'test-token'
  const received: unknown[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (req.url !== `/${token}/hooks`) {
        res.writeHead(404).end()
        return
      }
      try { received.push(JSON.parse(body)) } catch { received.push(body) }
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(reply))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port, token, received: () => received })
    })
  })
}

/** Run the reporter with `payload` on stdin; resolve its stdout. */
function runReporter(payload: unknown, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [REPORTER, '--codex-hook-reporter'], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    proc.stdout.on('data', (c) => { out += c })
    proc.on('error', reject)
    proc.on('close', () => resolve(out))
    proc.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
    setTimeout(() => { try { proc.kill() } catch { /* done */ } reject(new Error('reporter timed out')) }, 15_000)
  })
}

function envFor(port: number, token: string, terminalId = 'agent-codex-1'): Record<string, string> {
  return {
    SIMPLEEDIT_BRIDGE_PORT: String(port),
    SIMPLEEDIT_BRIDGE_TOKEN: token,
    SIMPLEEDIT_TERMINAL_ID: terminalId,
  }
}

describe('codex hook reporter', () => {
  it('stamps the terminal id so the bridge can route without a session registry', async () => {
    const bridge = await stubBridge({})
    try {
      await runReporter({ hook_event_name: 'Stop', session_id: 'thr_1', cwd: '/repo' }, envFor(bridge.port, bridge.token))
      expect(bridge.received()[0]).toMatchObject({
        hook_event_name: 'Stop',
        session_id: 'thr_1',
        cwd: '/repo',
        simpleedit_terminal_id: 'agent-codex-1',
      })
    } finally {
      bridge.server.close()
    }
  })

  it('relays a Stop-hook block back to Codex — this is mail delivery', async () => {
    const decision = { decision: 'block', reason: 'Claude 2 asks: is the parser done?' }
    const bridge = await stubBridge(decision)
    try {
      const out = await runReporter(
        { hook_event_name: 'Stop', session_id: 'thr_1', cwd: '/repo', stop_hook_active: false },
        envFor(bridge.port, bridge.token),
      )
      expect(JSON.parse(out)).toEqual(decision)
    } finally {
      bridge.server.close()
    }
  })

  it('stays silent when there is no mail, so ordinary events print nothing', async () => {
    const bridge = await stubBridge({})
    try {
      const out = await runReporter(
        { hook_event_name: 'PostToolUse', session_id: 'thr_1', cwd: '/repo' },
        envFor(bridge.port, bridge.token),
      )
      expect(out.trim()).toBe('')
    } finally {
      bridge.server.close()
    }
  })

  /**
   * Reporting is advisory: SimpleEdit going away, or answering with something
   * unusable, must leave Codex running exactly as it would have.
   */
  it('is inert when the bridge is unreachable', async () => {
    // Port 1 is not listening; the fetch fails.
    const out = await runReporter({ hook_event_name: 'Stop', session_id: 's', cwd: '/repo' }, envFor(1, 'nope'))
    expect(out.trim()).toBe('')
  })

  it('is inert on a non-OK response or a non-JSON body', async () => {
    const failing = await stubBridge({ decision: 'block', reason: 'ignored' }, 500)
    try {
      expect((await runReporter({ hook_event_name: 'Stop', session_id: 's', cwd: '/r' }, envFor(failing.port, failing.token))).trim()).toBe('')
    } finally {
      failing.server.close()
    }
  })

  it('does nothing without the bridge env — it must not run outside SimpleEdit', async () => {
    const bridge = await stubBridge({ decision: 'block', reason: 'should never be fetched' })
    try {
      const out = await runReporter({ hook_event_name: 'Stop', session_id: 's', cwd: '/r' }, {
        SIMPLEEDIT_BRIDGE_PORT: '', SIMPLEEDIT_BRIDGE_TOKEN: '', SIMPLEEDIT_TERMINAL_ID: '',
      })
      expect(out.trim()).toBe('')
      expect(bridge.received()).toHaveLength(0)
    } finally {
      bridge.server.close()
    }
  })

  it('ignores a malformed payload rather than failing the hook', async () => {
    const bridge = await stubBridge({})
    try {
      expect((await runReporter('not json at all', envFor(bridge.port, bridge.token))).trim()).toBe('')
      expect(bridge.received()).toHaveLength(0)
    } finally {
      bridge.server.close()
    }
  })
})
