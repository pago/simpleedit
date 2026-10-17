import { describe, it, expect } from 'vitest'
import {
  isOpenSessionMessage,
  isOpenWorkflowMessage,
  parsePushPayload,
  planClick,
  planNotification,
  sameOriginUrl,
  sessionFromUrl,
  threadFromUrl,
  workflowFromUrl,
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
    ).toEqual({ title: 'Fix it', body: 'Blocked', terminalId: 't1', url: `${SCOPE}#session=t1`, windowId: null, threadId: null, workflowId: null, taskId: null })
  })

  it('reads a workflow push, whose terminal is empty so an older worker still parses it', () => {
    const raw = { title: 'Lead · Plan', body: 'Tests needs you: which db?', terminalId: '', url: `${SCOPE}#workflow=wf_1&task=tests`, windowId: 2, workflowId: 'wf_1', taskId: 'tests' }
    expect(parsePushPayload(JSON.stringify(raw))).toEqual({ ...raw, threadId: null })
  })

  it('reads a payload from before workflows as a session push', () => {
    const payload = parsePushPayload(JSON.stringify({ terminalId: 't1', url: SCOPE, taskId: 'stray' }))
    expect(payload?.workflowId).toBeNull()
    expect(payload?.taskId).toBeNull()
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

  /**
   * A tag replaces the entry for its session, which is right. Replacing it
   * SILENTLY is not: main only sends a second push after a real transition back
   * into blocked AND past the debounce, so one arriving is a genuinely new
   * reason to look. With `renotify` false the text would change under an unread
   * notification with no alert, and the user would never learn.
   */
  it('re-alerts when a session blocks again, rather than swapping the text in silence', () => {
    expect(planNotification(JSON.stringify({ terminalId: 't1', url: SCOPE }), SCOPE).renotify).toBe(true)
    expect(planNotification(null, SCOPE).renotify).toBe(true)
  })

  it('carries the window a session lives on, so the app can explain a miss', () => {
    const plan = planNotification(JSON.stringify({ terminalId: 't1', url: SCOPE, windowId: 7 }), SCOPE)
    expect(plan.windowId).toBe(7)
    expect(planNotification(JSON.stringify({ terminalId: 't1', url: SCOPE }), SCOPE).windowId).toBeNull()
  })

  it('gives a thread reply its own row, so it never replaces an unread block', () => {
    const plan = planNotification(
      JSON.stringify({ terminalId: 't7', url: `${SCOPE}#session=t7&thread=t_abcdef`, threadId: 't_abcdef' }),
      SCOPE,
    )
    expect(plan.tag).toBe('simpleedit-thread-t7')
    expect(plan.threadId).toBe('t_abcdef')
    expect(planNotification(JSON.stringify({ terminalId: 't7', url: SCOPE }), SCOPE).threadId).toBeNull()
  })

  it('gives a workflow one row for all its tasks, apart from any session', () => {
    const raw = { terminalId: '', url: `${SCOPE}#workflow=wf_1&task=a`, windowId: 2, workflowId: 'wf_1', taskId: 'a' }
    const plan = planNotification(JSON.stringify(raw), SCOPE)
    expect(plan.tag).toBe('simpleedit-workflow-wf_1')
    expect(planNotification(JSON.stringify({ ...raw, taskId: 'b' }), SCOPE).tag).toBe(plan.tag)
    expect(plan).toMatchObject({ workflowId: 'wf_1', taskId: 'a', windowId: 2, url: `${SCOPE}#workflow=wf_1&task=a` })
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
      message: { type: 'open-session', terminalId: 't1', url: `${SCOPE}#session=t1`, windowId: null, threadId: null },
    })
  })

  it('tells the tab which thread a reply was in', () => {
    const action = planClick(`${SCOPE}#session=t1&thread=t_abcdef`, 't1', [{ url: SCOPE }], 7, 't_abcdef')
    expect(action.kind === 'focus' && action.message.type === 'open-session' && action.message.threadId).toBe('t_abcdef')
  })

  it('tells the tab to open a workflow on its task, not a terminal', () => {
    const url = `${SCOPE}#workflow=wf_1&task=a`
    const action = planClick(url, '', [{ url: SCOPE }], 2, null, { workflowId: 'wf_1', taskId: 'a' })
    expect(action).toEqual({
      kind: 'focus',
      clientIndex: 0,
      message: { type: 'open-workflow', workflowId: 'wf_1', taskId: 'a', url, windowId: 2 },
    })
    expect(planClick(url, '', [], 2, null, { workflowId: 'wf_1', taskId: 'a' })).toEqual({ kind: 'open', url })
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

describe('threadFromUrl', () => {
  it('reads the thread beside the session', () => {
    expect(threadFromUrl(`${SCOPE}#session=t1&thread=t_abcdef`)).toBe('t_abcdef')
    expect(sessionFromUrl(`${SCOPE}#session=t1&thread=t_abcdef`)).toBe('t1')
    expect(threadFromUrl(`${SCOPE}#session=t1`)).toBeNull()
  })
})

describe('isOpenSessionMessage', () => {
  it('accepts only the message the worker sends', () => {
    expect(isOpenSessionMessage({ type: 'open-session', terminalId: 't1', url: SCOPE, windowId: 3 })).toBe(true)
    expect(isOpenSessionMessage({ type: 'open-session' })).toBe(false)
    expect(isOpenSessionMessage({ type: 'something-else', terminalId: 't1' })).toBe(false)
    expect(isOpenSessionMessage(null)).toBe(false)
    expect(isOpenSessionMessage('open-session')).toBe(false)
  })
})

describe('workflowFromUrl', () => {
  it('reads the workflow and task a deep link names', () => {
    expect(workflowFromUrl(`${SCOPE}#workflow=wf_1&task=impl.2`)).toEqual({ workflowId: 'wf_1', taskId: 'impl.2' })
    expect(workflowFromUrl(`${SCOPE}#workflow=wf_1`)).toEqual({ workflowId: 'wf_1', taskId: null })
  })

  it('is null for a session link or an ordinary load', () => {
    expect(workflowFromUrl(`${SCOPE}#session=t1`)).toBeNull()
    expect(workflowFromUrl(SCOPE)).toBeNull()
  })
})

describe('isOpenWorkflowMessage', () => {
  it('accepts only the message the worker sends for a workflow', () => {
    expect(isOpenWorkflowMessage({ type: 'open-workflow', workflowId: 'wf_1', taskId: null, url: SCOPE, windowId: 2 })).toBe(true)
    expect(isOpenWorkflowMessage({ type: 'open-workflow', workflowId: '' })).toBe(false)
    expect(isOpenWorkflowMessage({ type: 'open-session', terminalId: 't1' })).toBe(false)
    expect(isOpenSessionMessage({ type: 'open-workflow', workflowId: 'wf_1' })).toBe(false)
  })
})
