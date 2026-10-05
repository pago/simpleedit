import { describe, it, expect } from 'vitest'
import { chooseAttachWindow, parseAttachRequest, projectsOf, type WindowCandidate } from '../attach-target'

const A: WindowCandidate = { windowId: 1, repoPath: '/p/a.git', focused: false }
const B: WindowCandidate = { windowId: 2, repoPath: '/p/b.git', focused: true }
const WELCOME: WindowCandidate = { windowId: 3, repoPath: null, focused: false }

describe('parseAttachRequest', () => {
  it('reads the window and repo a socket URL names', () => {
    expect(parseAttachRequest('/tok/ws?window=2&repo=%2Fp%2Fb.git')).toEqual({ windowId: 2, repoPath: '/p/b.git' })
    expect(parseAttachRequest('/tok/ws?repo=%2Fp%2Fb.git')).toEqual({ windowId: null, repoPath: '/p/b.git' })
  })

  it('reads anything malformed as no request, never as a guess', () => {
    expect(parseAttachRequest('/tok/ws')).toBeNull()
    expect(parseAttachRequest(undefined)).toBeNull()
    expect(parseAttachRequest('/tok/ws?window=0')).toBeNull()
    expect(parseAttachRequest('/tok/ws?window=1e3&repo=')).toBeNull()
    expect(parseAttachRequest('/tok/ws?window=2x')).toBeNull()
    expect(parseAttachRequest(`/tok/ws?repo=${'a'.repeat(5000)}`)).toBeNull()
    expect(parseAttachRequest('/tok/ws?repo=%2Fp%00')).toBeNull()
  })
})

describe('chooseAttachWindow', () => {
  it('keeps the focus rule when nothing is asked for', () => {
    expect(chooseAttachWindow([A, B], null)).toBe(2)
    expect(chooseAttachWindow([WELCOME, A], null)).toBe(1)
    expect(chooseAttachWindow([WELCOME], null)).toBe(3)
    expect(chooseAttachWindow([], null)).toBeNull()
  })

  it('honours the requested window while it still has the requested repo', () => {
    expect(chooseAttachWindow([A, B], { windowId: 1, repoPath: '/p/a.git' })).toBe(1)
  })

  // After a restart window ids are handed out again, so a remembered id can
  // name a window that now holds another project.
  it('does not trust a window id whose repo has changed', () => {
    expect(chooseAttachWindow([{ ...A, repoPath: '/p/c.git' }, B], { windowId: 1, repoPath: '/p/a.git' })).toBe(2)
  })

  it('finds the repo in another window when the id is stale', () => {
    const reopened: WindowCandidate = { windowId: 9, repoPath: '/p/a.git', focused: false }
    expect(chooseAttachWindow([B, reopened], { windowId: 1, repoPath: '/p/a.git' })).toBe(9)
  })

  it('prefers the focused window of two on the same repo', () => {
    const twin: WindowCandidate = { windowId: 5, repoPath: '/p/b.git', focused: false }
    expect(chooseAttachWindow([twin, B], { windowId: null, repoPath: '/p/b.git' })).toBe(2)
  })

  it('falls back to the focus rule when the project is not open', () => {
    expect(chooseAttachWindow([A, B], { windowId: 4, repoPath: '/p/gone.git' })).toBe(2)
  })

  it('never attaches to a repo-less window by asking for it', () => {
    expect(chooseAttachWindow([WELCOME, A], { windowId: 3, repoPath: null })).toBe(1)
  })
})

describe('projectsOf', () => {
  it('lists the windows with a repo, named as the title bar names them', () => {
    expect(projectsOf([A, WELCOME, B])).toEqual([
      { windowId: 1, repoPath: '/p/a.git', name: 'a', focused: false },
      { windowId: 2, repoPath: '/p/b.git', name: 'b', focused: true },
    ])
  })
})
