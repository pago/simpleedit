import { describe, it, expect } from 'vitest'
import { sanitizeBranchName, isValidBranchName } from './branchName'

describe('sanitizeBranchName', () => {
  it('passes a clean name through unchanged', () => {
    expect(sanitizeBranchName('feature-a')).toBe('feature-a')
    expect(sanitizeBranchName('feat/sub-thing')).toBe('feat/sub-thing')
  })

  it('strips git-illegal characters', () => {
    expect(sanitizeBranchName('feat branch')).toBe('featbranch') // space
    expect(sanitizeBranchName('a~b^c:d?e*f[g]h\\i@j{k')).toBe('abcdefghijk')
  })

  it('collapses consecutive dots and slashes', () => {
    expect(sanitizeBranchName('a..b')).toBe('a.b')
    expect(sanitizeBranchName('a//b')).toBe('a/b')
  })

  it('removes a .lock component', () => {
    expect(sanitizeBranchName('feature.lock')).toBe('feature')
    expect(sanitizeBranchName('feature.lock/x')).toBe('feature/x')
  })

  it('cannot start with . or /', () => {
    expect(sanitizeBranchName('.hidden')).toBe('hidden')
    expect(sanitizeBranchName('/abs')).toBe('abs')
  })
})

describe('isValidBranchName', () => {
  it('accepts a non-empty name not ending in . or /', () => {
    expect(isValidBranchName('feature-a')).toBe(true)
    expect(isValidBranchName('  feature-a  ')).toBe(true) // trimmed
  })

  it('rejects empty / whitespace-only', () => {
    expect(isValidBranchName('')).toBe(false)
    expect(isValidBranchName('   ')).toBe(false)
  })

  it('rejects names ending in . or /', () => {
    expect(isValidBranchName('feature.')).toBe(false)
    expect(isValidBranchName('feature/')).toBe(false)
  })
})
