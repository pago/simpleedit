import { describe, expect, it } from 'vitest'
import { parseGithubRemote } from '../repo-remote'

describe('parseGithubRemote', () => {
  it('reads https, ssh and scp-style remotes', () => {
    expect(parseGithubRemote('https://github.com/pago/simpleedit.git')).toEqual({ host: 'github.com', owner: 'pago', repo: 'simpleedit' })
    expect(parseGithubRemote('ssh://git@github.example.com/acme/app.git')).toEqual({ host: 'github.example.com', owner: 'acme', repo: 'app' })
    expect(parseGithubRemote('git@github.com:pago/simpleedit.git')).toEqual({ host: 'github.com', owner: 'pago', repo: 'simpleedit' })
  })

  it('refuses what is not owner/repo on a host', () => {
    expect(parseGithubRemote('/srv/git/app.git')).toBeNull()
    expect(parseGithubRemote('file:///srv/git/app.git')).toBeNull()
    expect(parseGithubRemote('https://github.com/only-owner')).toBeNull()
  })
})
