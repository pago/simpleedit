import { describe, it, expect } from 'vitest'
import {
  isOpenSessionMessage,
  parsePushPayload,
  planClick,
  planNotification,
  sameOriginUrl,
  sessionFromUrl,
} from '../lib/push-payload'

/**
 * The service worker's judgement, tested where a service worker's judgement
 * cannot be: `sw.ts` itself runs in a scope no test can enter, so everything
 * that could be wrong lives in the module these tests cover and the worker is
 * left as wiring.
 */

const SCOPE = 'https://mac.tailnet.ts.net/deadbeef/'

describe('parsePushPayload', () => {
  it('reads what main sends', () => {
    expect(
      parsePushPayload(JSON.stringify({ title: 'Fix it', body: 'Blocked', terminalId: 't1', url: `${SCOPE}#session=t1` })),
    ).toEqual({ title: 'Fix it', body: 'Blocked', terminalId: 't1', url: `${SCOPE}#session=t1` })
  })

  it('returns null rather than throwing on anything unusable', () => {
    for (const raw of ['', null, undefined, 'not json', '[]', '{}', '{"terminalId":"t1"}']) {
      expect(parsePushPayload(raw)).toBeNull()
    }
  })

  it('supplies a title when one is missing, since a silent push is the worst outcome', () => {
    expect(parsePushPayload(JSON.stringify({ terminalId: 't1', url: SCOPE }))?.title).toBe('A session is blocked')
  })
})

describe('planNotification', () => {
  it('tags per session, so one session cannot stack two entries', () => {
    const plan = planNotification(JSON.stringify({ title: 'A', body: 'B', terminalId: 't7', url: SCOPE }), SCOPE)
    expect(plan.tag).toBe('simpleedit-t7')
    expect(plan.terminalId).toBe('t7')
  })

  it('never re-alerts for a notification already on screen', () => {
    expect(planNotification(JSON.stringify({ terminalId: 't1', url: SCOPE }), SCOPE).renotify).toBe(false)
    expect(planNotification(null, SCOPE).renotify).toBe(false)
  })

  it('still shows something when the body cannot be read', () => {
    const plan = planNotification('garbage', SCOPE)
    expect(plan.title).toBe('A session needs you')
    expect(plan.url).toBe(SCOPE)
  })
})

describe('sameOriginUrl', () => {
  /**
   * The payload is encrypted end to end, so a URL in it came from our own Mac.
   * That is a property of the crypto, not of this function — and a
   * notification that can be made to open an arbitrary page is worth four
   * lines to make impossible. Enforced here, at the point of use.
   */
  it('refuses to leave the origin, falling back to the scope', () => {
    expect(sameOriginUrl('https://evil.test/steal', SCOPE)).toBe(SCOPE)
    expect(sameOriginUrl('javascript:alert(1)', SCOPE)).toBe(SCOPE)
    expect(sameOriginUrl('http://mac.tailnet.ts.net/deadbeef/', SCOPE)).toBe(SCOPE)
  })

  it('keeps a same-origin URL, including one under a different token', () => {
    expect(sameOriginUrl(`${SCOPE}#session=t1`, SCOPE)).toBe(`${SCOPE}#session=t1`)
    // The token rotates on every server start, so the worker's own scope goes
    // stale while the message carries the live one. Same origin, so allowed.
    expect(sameOriginUrl('https://mac.tailnet.ts.net/newtoken/#session=t1', SCOPE)).toBe(
      'https://mac.tailnet.ts.net/newtoken/#session=t1',
    )
  })

  it('resolves a relative path against the scope rather than throwing', () => {
    expect(sameOriginUrl('', SCOPE)).toBe(SCOPE)
    expect(sameOriginUrl('::::', SCOPE)).toBe(`${SCOPE}::::`)
  })
})

describe('planClick', () => {
  it('opens a window when nothing is running', () => {
    expect(planClick(`${SCOPE}#session=t1`, 't1', [])).toEqual({ kind: 'open', url: `${SCOPE}#session=t1` })
  })

  /**
   * The open tab holds a live socket, an xterm buffer and any half-typed
   * reply. Reopening or navigating would throw all three away.
   */
  it('focuses an existing tab and tells it where to go', () => {
    const action = planClick(`${SCOPE}#session=t1`, 't1', [{ url: SCOPE }])
    expect(action).toEqual({
      kind: 'focus',
      clientIndex: 0,
      message: { type: 'open-session', terminalId: 't1', url: `${SCOPE}#session=t1` },
    })
  })

  it('prefers the tab the user was last looking at', () => {
    const action = planClick(SCOPE, 't1', [{ url: SCOPE }, { url: SCOPE, focused: true }])
    expect(action.kind === 'focus' && action.clientIndex).toBe(1)
  })
})

describe('sessionFromUrl', () => {
  it('reads the session a deep link names', () => {
    expect(sessionFromUrl(`${SCOPE}#session=t1`)).toBe('t1')
    expect(sessionFromUrl(`${SCOPE}#other=1&session=t2`)).toBe('t2')
    expect(sessionFromUrl('#session=t3')).toBe('t3')
  })

  it('decodes an id that needed escaping', () => {
    expect(sessionFromUrl(`${SCOPE}#session=a%20b%26c`)).toBe('a b&c')
  })

  it('is null for an ordinary load', () => {
    expect(sessionFromUrl(SCOPE)).toBeNull()
    expect(sessionFromUrl(`${SCOPE}#session=`)).toBeNull()
    expect(sessionFromUrl('')).toBeNull()
  })
})

describe('isOpenSessionMessage', () => {
  it('accepts only the message the worker sends', () => {
    expect(isOpenSessionMessage({ type: 'open-session', terminalId: 't1', url: SCOPE })).toBe(true)
    expect(isOpenSessionMessage({ type: 'open-session' })).toBe(false)
    expect(isOpenSessionMessage({ type: 'something-else', terminalId: 't1' })).toBe(false)
    expect(isOpenSessionMessage(null)).toBe(false)
    expect(isOpenSessionMessage('open-session')).toBe(false)
  })
})
