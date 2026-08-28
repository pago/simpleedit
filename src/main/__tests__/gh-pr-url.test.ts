import { describe, it, expect } from 'vitest'
import { isPrUrl, getPrDiff } from '../github/gh'

/**
 * `screenprs:pr-diff` reaches `gh` with a url the caller supplied, and a socket
 * client is a caller. `spawn` uses no shell, so there is no command to inject —
 * but an argument that starts with `-` is read as an OPTION, which is how you
 * turn `gh pr diff <url>` into `gh pr diff -R someone/else`. The shape check is
 * what stops that, and it has to stay a check rather than an assumption.
 */
describe('isPrUrl', () => {
  it('accepts an absolute PR url, on github.com or an enterprise host', () => {
    expect(isPrUrl('https://github.com/acme/widgets/pull/7')).toBe(true)
    expect(isPrUrl('https://git.acme.internal/acme/widgets/pull/7')).toBe(true)
  })

  it('rejects anything gh would read as an option or a subcommand', () => {
    expect(isPrUrl('-R someone/else')).toBe(false)
    expect(isPrUrl('--help')).toBe(false)
    expect(isPrUrl('acme/widgets#7')).toBe(false)
    expect(isPrUrl('')).toBe(false)
  })

  it('rejects a non-http scheme', () => {
    expect(isPrUrl('file:///etc/passwd')).toBe(false)
  })
})

describe('getPrDiff', () => {
  it('refuses to spawn gh at all for a url that fails the check', async () => {
    await expect(getPrDiff({ url: '--version' })).rejects.toThrow('Not a pull-request URL')
  })
})
