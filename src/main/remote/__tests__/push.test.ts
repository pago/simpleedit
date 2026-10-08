import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AgentStatusEvent } from '../../../shared/ipc-types'
import type { AgentThread } from '../../../shared/agent-threads'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import {
  addSubscription,
  buildPayload,
  buildThreadPayload,
  configurePush,
  deliver,
  getPushStatus,
  handleAgentStatus,
  handleThreadReply,
  noteTurnStarted,
  removeAllSubscriptions,
  removeSubscription,
  resetPushState,
  shouldNotify,
} from '../push'
import { encryptPayload, fromBase64Url, generateVapidKeys, toBase64Url } from '../webpush'
import { createDecipheriv, createECDH, hkdfSync } from 'crypto'

/**
 * A device, with the private half kept so a test can read what we sent it —
 * the only way to assert that the payload really is the payload.
 */
function fakeDevice(endpoint: string): {
  endpoint: string
  keys: { p256dh: string; auth: string }
  read: (body: Buffer) => string
} {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = Buffer.from('0123456789abcdef', 'utf8')
  return {
    endpoint,
    keys: { p256dh: toBase64Url(ecdh.getPublicKey()), auth: toBase64Url(auth) },
    read(body) {
      const salt = body.subarray(0, 16)
      const asPublic = body.subarray(21, 86)
      const ciphertext = body.subarray(86)
      const shared = ecdh.computeSecret(asPublic)
      const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic])
      const ikm = Buffer.from(hkdfSync('sha256', shared, auth, keyInfo, 32))
      const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
      const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
      const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
      decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
      const plain = Buffer.concat([
        decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
        decipher.final(),
      ])
      return plain.subarray(0, plain.length - 1).toString('utf8')
    },
  }
}

const phone = fakeDevice('https://web.push.apple.com/abc')
const laptop = fakeDevice('https://updates.push.services.mozilla.com/wpush/v2/def')

let dir = ''
let configPath = ''
let sent: { url: string; body: Buffer }[] = []
let statusFor: Record<string, number> = {}
let now = 1_000_000

function transportReturning(byEndpoint: Record<string, number>) {
  return (url: string, _headers: Record<string, string>, body: Buffer) => {
    sent.push({ url, body })
    return Promise.resolve({ status: byEndpoint[url] ?? 201 })
  }
}

function waiting(overrides: Partial<AgentStatusEvent> = {}): AgentStatusEvent {
  return {
    worktreePath: '/Users/dev/project/feat/push',
    status: 'waiting',
    terminalId: 't1',
    precise: true,
    ...overrides,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'simpleedit-push-'))
  configPath = join(dir, 'push.json')
  process.env.SIMPLEEDIT_E2E_PUSH_CONFIG = configPath
  sent = []
  statusFor = {}
  now = 1_000_000
  resetPushState()
  configurePush({
    now: () => now,
    targetUrl: () => 'https://mac.tailnet.ts.net/tok/',
    labelFor: () => 'Fix the flaky test',
    // Away from the desk: the state this whole feature exists for. The tests
    // that care about presence set it explicitly.
    userIsPresent: () => false,
    onStatusChange: undefined,
    transport: (url, headers, body) => transportReturning(statusFor)(url, headers, body),
  })
})

afterEach(() => {
  delete process.env.SIMPLEEDIT_E2E_PUSH_CONFIG
  rmSync(dir, { recursive: true, force: true })
})

describe('VAPID key persistence', () => {
  it('mints a key pair on first use and keeps it across restarts', () => {
    const first = getPushStatus().vapidPublicKey
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(fromBase64Url(first)).toHaveLength(65)

    resetPushState()
    expect(getPushStatus().vapidPublicKey).toBe(first)
  })

  it('never puts the private key anywhere a client can read it', () => {
    addSubscription({ endpoint: phone.endpoint, keys: phone.keys })
    const status = getPushStatus()
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as { vapid: { privateKey: string } }
    expect(onDisk.vapid.privateKey).toHaveLength(43)
    expect(JSON.stringify(status)).not.toContain(onDisk.vapid.privateKey)
    // Nor the endpoint, which is itself a capability to push to the device.
    expect(JSON.stringify(status)).not.toContain(phone.endpoint)
    expect(status.devices[0].service).toBe('web.push.apple.com')
  })

  it('replaces a key pair whose halves do not match, rather than failing forever', () => {
    const stale = generateVapidKeys()
    writeFileSync(
      configPath,
      JSON.stringify({
        vapid: { publicKey: stale.publicKey, privateKey: generateVapidKeys().privateKey },
        subscriptions: [{ endpoint: phone.endpoint, p256dh: phone.keys.p256dh, auth: phone.keys.auth }],
      }),
    )
    resetPushState()
    const status = getPushStatus()
    expect(status.vapidPublicKey).not.toBe(stale.publicKey)
    // The subscriptions went with it: they were minted against a key that can
    // no longer sign for them, so keeping them would fail on every push.
    expect(status.devices).toHaveLength(0)
  })
})

describe('subscriptions', () => {
  it('survives a restart', () => {
    addSubscription({ endpoint: phone.endpoint, keys: phone.keys, label: 'iPhone' })
    resetPushState()
    expect(getPushStatus().devices.map((d) => d.label)).toEqual(['iPhone'])
  })

  it('is idempotent per endpoint, so a re-subscribe does not double-buzz', () => {
    addSubscription({ endpoint: phone.endpoint, keys: phone.keys, label: 'iPhone' })
    const status = addSubscription({ endpoint: phone.endpoint, keys: phone.keys, label: 'iPhone (again)' })
    expect(status.devices).toHaveLength(1)
    expect(status.devices[0].label).toBe('iPhone (again)')
  })

  it('refuses an endpoint that is not https, or one missing its keys', () => {
    expect(() => addSubscription({ endpoint: 'http://evil.test/x', keys: phone.keys })).toThrow(/https/)
    expect(() =>
      addSubscription({ endpoint: phone.endpoint, keys: { p256dh: '', auth: phone.keys.auth } }),
    ).toThrow(/both of its keys/)
  })

  it('can be forgotten by endpoint (what a browser knows) or by id (what the pane shows)', () => {
    addSubscription({ endpoint: phone.endpoint, keys: phone.keys })
    const { id } = addSubscription({ endpoint: laptop.endpoint, keys: laptop.keys }).devices[1]
    expect(removeSubscription(phone.endpoint).devices).toHaveLength(1)
    expect(removeSubscription(id).devices).toHaveLength(0)
  })

  it('forgets everything at once', () => {
    addSubscription({ endpoint: phone.endpoint, keys: phone.keys })
    addSubscription({ endpoint: laptop.endpoint, keys: laptop.keys })
    expect(removeAllSubscriptions().devices).toHaveLength(0)
    resetPushState()
    expect(getPushStatus().devices).toHaveLength(0)
  })

  it('drops the oldest rather than refusing the phone in your hand', () => {
    for (let i = 0; i < 10; i++) {
      now += 1000
      const device = fakeDevice(`https://web.push.apple.com/d${i}`)
      addSubscription({ endpoint: device.endpoint, keys: device.keys, label: `device ${i}` })
    }
    const labels = getPushStatus().devices.map((d) => d.label)
    expect(labels).toHaveLength(8)
    expect(labels).toContain('device 9')
    expect(labels).not.toContain('device 0')
  })
})

describe('shouldNotify', () => {
  it('fires on a precise transition into waiting', () => {
    expect(shouldNotify(waiting(), 'running', undefined, now)).toBe(true)
  })

  it('never fires on an imprecise signal', () => {
    expect(shouldNotify(waiting({ precise: false }), 'running', undefined, now)).toBe(false)
  })

  it('never fires for a status other than waiting', () => {
    for (const status of ['idle', 'running', 'initializing', 'error', 'exited'] as const) {
      expect(shouldNotify(waiting({ status }), 'running', undefined, now)).toBe(false)
    }
  })

  it('does not re-fire while already waiting', () => {
    expect(shouldNotify(waiting(), 'waiting', undefined, now)).toBe(false)
  })

  it('debounces a session that flickers', () => {
    expect(shouldNotify(waiting(), 'running', now - 1000, now)).toBe(false)
    expect(shouldNotify(waiting(), 'running', now - 6 * 60 * 1000, now)).toBe(true)
  })
})

describe('the trigger', () => {
  beforeEach(() => {
    addSubscription({ endpoint: phone.endpoint, keys: phone.keys, label: 'iPhone' })
  })

  it('sends one encrypted push, readable only by the device', async () => {
    handleAgentStatus(waiting({ status: 'running' }), 7)
    handleAgentStatus(waiting(), 7)
    await vi.waitFor(() => expect(sent).toHaveLength(1))

    expect(sent[0].url).toBe(phone.endpoint)
    const payload = JSON.parse(phone.read(sent[0].body)) as Record<string, string>
    expect(payload.title).toBe('Fix the flaky test')
    expect(payload.terminalId).toBe('t1')
    expect(payload.body).toContain('feat/push')
    // The deep link carries the CURRENT token: the service worker's own scope
    // goes stale on every server restart.
    expect(payload.url).toBe('https://mac.tailnet.ts.net/tok/#session=t1')
  })

  it('stays silent for an imprecise waiting', async () => {
    handleAgentStatus(waiting({ precise: false }), 7)
    await new Promise((r) => setTimeout(r, 20))
    expect(sent).toHaveLength(0)
  })

  it('stays silent while a session is already waiting', async () => {
    handleAgentStatus(waiting(), 7)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    handleAgentStatus(waiting(), 7)
    await new Promise((r) => setTimeout(r, 20))
    expect(sent).toHaveLength(1)
  })

  it('debounces a session that flaps in and out of waiting', async () => {
    handleAgentStatus(waiting(), 7)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    handleAgentStatus(waiting({ status: 'running' }), 7)
    now += 1000
    handleAgentStatus(waiting(), 7)
    await new Promise((r) => setTimeout(r, 20))
    expect(sent).toHaveLength(1)

    // Past the debounce, a genuine second block still reaches you.
    handleAgentStatus(waiting({ status: 'running' }), 7)
    now += 6 * 60 * 1000
    handleAgentStatus(waiting(), 7)
    await vi.waitFor(() => expect(sent).toHaveLength(2))
  })

  /**
   * The defect that made this feature actively annoying: presence machinery was
   * built in the same change, exported to Claude Code so IT would stay quiet,
   * and never consulted for our own send. An OpenCode session in ask-mode at
   * your desk buzzed the phone in your pocket every five minutes for a prompt
   * already on the screen in front of you.
   */
  it('stays silent while you are at the Mac', async () => {
    configurePush({ userIsPresent: () => true })
    handleAgentStatus(waiting(), 7)
    await new Promise((r) => setTimeout(r, 20))
    expect(sent).toHaveLength(0)
  })

  it('does not burn the debounce on a block you were present for', async () => {
    configurePush({ userIsPresent: () => true })
    handleAgentStatus(waiting(), 7)
    await new Promise((r) => setTimeout(r, 20))
    expect(sent).toHaveLength(0)

    // You walk away. The session is still blocked, and the next transition
    // must reach you rather than be swallowed by a debounce it never set.
    configurePush({ userIsPresent: () => false })
    handleAgentStatus(waiting({ status: 'running' }), 7)
    now += 1000
    handleAgentStatus(waiting(), 7)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
  })

  it('carries the window the session lives on, so a phone can explain a miss', async () => {
    handleAgentStatus(waiting(), 42)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect((JSON.parse(phone.read(sent[0].body)) as { windowId: number }).windowId).toBe(42)
  })

  /**
   * No provider emits an imprecise `waiting` today. This pins the ordering that
   * keeps the next one from being a silent regression: recorded first, the
   * inferred signal would make the real one behind it look like a repeat.
   */
  it('does not let an imprecise waiting swallow the precise one behind it', async () => {
    handleAgentStatus(waiting({ precise: false }), 7)
    handleAgentStatus(waiting(), 7)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
  })

  it('stays silent when nothing a phone could open is reachable', async () => {
    configurePush({ targetUrl: () => null })
    handleAgentStatus(waiting(), 7)
    await new Promise((r) => setTimeout(r, 20))
    expect(sent).toHaveLength(0)
  })

  it('stays silent when no device is registered', async () => {
    removeAllSubscriptions()
    handleAgentStatus(waiting(), 7)
    await new Promise((r) => setTimeout(r, 20))
    expect(sent).toHaveLength(0)
  })

  it('forgets a session that ended, so the gate maps cannot grow forever', async () => {
    handleAgentStatus(waiting(), 7)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    // Exit clears the debounce; a *new* session reusing that id is not muted
    // by a block the old one had.
    handleAgentStatus(waiting({ status: 'exited', precise: false }), 7)
    handleAgentStatus(waiting({ status: 'running' }), 7)
    handleAgentStatus(waiting(), 7)
    await vi.waitFor(() => expect(sent).toHaveLength(2))
  })

  it('falls back to a generic title when the window has no label for the session', async () => {
    configurePush({ labelFor: () => null })
    handleAgentStatus(waiting(), 7)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect((JSON.parse(phone.read(sent[0].body)) as { title: string }).title).toBe('A session is blocked')
  })
})

describe('pruning', () => {
  beforeEach(() => {
    addSubscription({ endpoint: phone.endpoint, keys: phone.keys, label: 'iPhone' })
    addSubscription({ endpoint: laptop.endpoint, keys: laptop.keys, label: 'Laptop' })
  })

  it('drops an endpoint the push service says is gone', async () => {
    statusFor = { [phone.endpoint]: 410, [laptop.endpoint]: 201 }
    await deliver(buildPayload(waiting(), 'x', 'https://mac.ts.net/tok/', 7))
    expect(getPushStatus().devices.map((d) => d.label)).toEqual(['Laptop'])
    resetPushState()
    expect(getPushStatus().devices.map((d) => d.label)).toEqual(['Laptop'])
  })

  it('drops a 404 too', async () => {
    statusFor = { [phone.endpoint]: 404 }
    await deliver(buildPayload(waiting(), 'x', 'https://mac.ts.net/tok/', 7))
    expect(getPushStatus().devices.map((d) => d.label)).toEqual(['Laptop'])
  })

  it('keeps a device through a transient failure, and says what happened', async () => {
    statusFor = { [phone.endpoint]: 429, [laptop.endpoint]: 502 }
    await deliver(buildPayload(waiting(), 'x', 'https://mac.ts.net/tok/', 7))
    const devices = getPushStatus().devices
    expect(devices).toHaveLength(2)
    expect(devices[0].lastError).toMatch(/429/)
    expect(devices[0].lastPushAt).toBeNull()
  })

  it('records a successful delivery', async () => {
    await deliver(buildPayload(waiting(), 'x', 'https://mac.ts.net/tok/', 7))
    expect(getPushStatus().devices.every((d) => d.lastPushAt === now && d.lastError === null)).toBe(true)
  })
})

describe('thread replies', () => {
  function replied(body = 'Renamed it.\nAnd moved the test.', overrides: Partial<AgentThread> = {}): AgentThread {
    return {
      id: 't_abcdef',
      sessionId: 't1',
      worktreePath: '/Users/dev/project/feat/push',
      anchor: { path: 'src/a.ts', startLine: 12, endLine: 14, snippet: 'x', before: '', after: '', context: 'file' },
      status: 'open',
      messages: [
        { id: 'm_aaaaaa', author: 'user', body: 'why?', at: '2026-10-08T10:00:00.000Z' },
        { id: 'm_bbbbbb', author: 'agent', body, at: '2026-10-08T10:01:00.000Z' },
      ],
      lastReadAt: null,
      createdAt: '2026-10-08T10:00:00.000Z',
      updatedAt: '2026-10-08T10:01:00.000Z',
      ...overrides,
    }
  }

  beforeEach(() => {
    addSubscription({ endpoint: phone.endpoint, keys: phone.keys, label: 'iPhone' })
    configurePush({ windowOf: () => 7 })
  })

  it('names the session, the anchor and the first line, and links to the thread', async () => {
    const labels: Array<[number, string]> = []
    configurePush({ labelFor: (w, t) => (labels.push([w, t]), 'Fix the flaky test') })
    handleThreadReply(replied())
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    const payload = JSON.parse(phone.read(sent[0].body)) as Record<string, unknown>
    expect(labels).toEqual([[7, 't1']])
    expect(payload).toMatchObject({
      title: 'Fix the flaky test replied',
      body: 'src/a.ts:12 — Renamed it.',
      terminalId: 't1',
      threadId: 't_abcdef',
      windowId: 7,
      url: 'https://mac.tailnet.ts.net/tok/#session=t1&thread=t_abcdef',
    })
  })

  it('still notifies when no window lists the session', async () => {
    configurePush({ windowOf: () => null })
    handleThreadReply(replied())
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(JSON.parse(phone.read(sent[0].body))).toMatchObject({ title: 'An agent replied', windowId: null })
  })

  it('says the agent commented when it opened the thread', async () => {
    configurePush({ labelFor: () => 'Fix the flaky test' })
    handleThreadReply(replied('', { messages: [{ id: 'm_cccccc', author: 'agent', body: 'Is this intended?', at: '2026-10-08T10:01:00.000Z' }] }))
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(JSON.parse(phone.read(sent[0].body))).toMatchObject({ title: 'Fix the flaky test commented', body: 'src/a.ts:12 — Is this intended?' })
  })

  it('buzzes once per turn, however far apart its replies and opened threads are', async () => {
    const status = (s: AgentStatusEvent['status']) => handleAgentStatus(waiting({ status: s }), 7)
    status('running')
    handleThreadReply(replied())
    now += 3 * 60 * 1000
    handleThreadReply(replied('Other answer', { id: 't_ghijkl' }))
    now += 3 * 60 * 1000
    handleThreadReply(replied('', { id: 't_mnopqr', messages: [{ id: 'm_cccccc', author: 'agent', body: 'Is this intended?', at: '2026-10-08T10:01:00.000Z' }] }))
    await new Promise((r) => setTimeout(r, 20))
    expect(sent).toHaveLength(1)

    // A permission dialog inside the turn is not a new turn.
    status('waiting')
    status('running')
    handleThreadReply(replied('After the dialog'))
    await new Promise((r) => setTimeout(r, 20))
    // The block buzzed on its own; the reply after it did not.
    expect(sent).toHaveLength(2)

    status('idle')
    status('running')
    handleThreadReply(replied('Next turn'))
    await vi.waitFor(() => expect(sent).toHaveLength(3))
  })

  it('re-arms a hook-reporting session only on its next UserPromptSubmit, not on an idle title under a dialog', async () => {
    const status = (s: AgentStatusEvent['status']) => handleAgentStatus(waiting({ status: s, precise: false }), 7)
    noteTurnStarted('t1')
    status('running')
    handleThreadReply(replied())
    await vi.waitFor(() => expect(sent).toHaveLength(1))

    // Claude's title reads idle under a permission dialog; approving it is not a new turn.
    status('idle')
    status('running')
    handleThreadReply(replied('After the dialog'))
    await new Promise((r) => setTimeout(r, 20))
    expect(sent).toHaveLength(1)

    noteTurnStarted('t1')
    handleThreadReply(replied('Next turn'))
    await vi.waitFor(() => expect(sent).toHaveLength(2))
  })

  it('shows the bare path for a thread whose code moved', () => {
    const thread = replied()
    const orphan = { ...thread, anchor: { ...thread.anchor, orphaned: true as const } }
    expect(buildThreadPayload(orphan, null, 'https://x.test/tok/', 7).body).toBe('src/a.ts — Renamed it.')
  })

  it('falls back to ten minutes for a session that reports no status', async () => {
    handleThreadReply(replied())
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    now += 9 * 60 * 1000
    handleThreadReply(replied('Still the same turn, as far as we know'))
    await new Promise((r) => setTimeout(r, 20))
    expect(sent).toHaveLength(1)
    now += 2 * 60 * 1000
    handleThreadReply(replied('Later'))
    await vi.waitFor(() => expect(sent).toHaveLength(2))
  })

  it('does not share its debounce with a block', async () => {
    handleAgentStatus(waiting(), 7)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    handleThreadReply(replied())
    await vi.waitFor(() => expect(sent).toHaveLength(2))
  })

  it('stays silent at the Mac, without burning the debounce', async () => {
    configurePush({ userIsPresent: () => true })
    handleThreadReply(replied())
    await new Promise((r) => setTimeout(r, 20))
    expect(sent).toHaveLength(0)

    configurePush({ userIsPresent: () => false })
    handleThreadReply(replied())
    await vi.waitFor(() => expect(sent).toHaveLength(1))
  })

  it('stays silent with nowhere to land a tap', async () => {
    configurePush({ targetUrl: () => null })
    handleThreadReply(replied())
    await new Promise((r) => setTimeout(r, 20))
    expect(sent).toHaveLength(0)
  })

  it('ignores a thread whose last message is not the agent\'s', async () => {
    const thread = replied()
    handleThreadReply({ ...thread, messages: thread.messages.slice(0, 1) })
    await new Promise((r) => setTimeout(r, 20))
    expect(sent).toHaveLength(0)
  })

  it('caps the body, skipping leading blank lines', () => {
    const payload = buildThreadPayload(replied(`\n\n   ${'y'.repeat(500)}`), null, 'https://x.test/tok/', 7)
    expect(payload.body.startsWith('src/a.ts:12 — yyy')).toBe(true)
    expect(payload.body.length).toBeLessThanOrEqual(140)
  })
})

describe('buildPayload', () => {
  it('appends the session to an existing fragment rather than replacing it', () => {
    expect(buildPayload(waiting(), 'A', 'https://x.test/tok/#already', 7).url).toBe(
      'https://x.test/tok/#alreadysession=t1',
    )
    expect(buildPayload(waiting(), 'A', 'https://x.test/tok/', 7).url).toBe('https://x.test/tok/#session=t1')
  })

  it('caps what it puts in front of a lock screen', () => {
    const long = 'x'.repeat(500)
    const payload = buildPayload(waiting({ message: long }), long, 'https://x.test/tok/', 7)
    expect(payload.title.length).toBeLessThanOrEqual(60)
    expect(payload.body.length).toBeLessThanOrEqual(140)
  })

  it('escapes a terminal id so it cannot break out of the fragment', () => {
    expect(buildPayload(waiting({ terminalId: 'a b&c' }), 'A', 'https://x.test/tok/', 7).url).toBe(
      'https://x.test/tok/#session=a%20b%26c',
    )
  })
})

describe('the file on disk', () => {
  it('is written atomically, leaving no temp file behind', () => {
    addSubscription({ endpoint: phone.endpoint, keys: phone.keys })
    expect(existsSync(configPath)).toBe(true)
    expect(existsSync(`${configPath}.${process.pid}.tmp`)).toBe(false)
  })

  it('ignores rows that are not usable subscriptions instead of failing to load', () => {
    const keys = generateVapidKeys()
    writeFileSync(
      configPath,
      JSON.stringify({
        vapid: keys,
        subscriptions: [
          null,
          { endpoint: 'http://insecure.test/x', p256dh: 'a', auth: 'b' },
          { endpoint: phone.endpoint, p256dh: phone.keys.p256dh, auth: phone.keys.auth },
        ],
      }),
    )
    resetPushState()
    const status = getPushStatus()
    expect(status.vapidPublicKey).toBe(keys.publicKey)
    expect(status.devices).toHaveLength(1)
  })
})

describe('encryptPayload, at the size this feature actually sends', () => {
  it('round-trips a full notification body', () => {
    const payload = JSON.stringify(buildPayload(waiting(), 'A long-ish session label', 'https://mac.ts.net/tok/', 7))
    const body = encryptPayload(Buffer.from(payload, 'utf8'), { keys: phone.keys })
    expect(phone.read(body)).toBe(payload)
  })
})
