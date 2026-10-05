import { describe, it, expect } from 'vitest'
import { isIsoDate, parseFilterPrefs, parseScreeningFilters, screeningFilters } from '../screenprs-filter'

describe('parseFilterPrefs', () => {
  it('keeps a valid org and cutoff, trimmed', () => {
    expect(parseFilterPrefs({ owner: '  acme-corp ', cutoffDays: 7 })).toEqual({ owner: 'acme-corp', cutoffDays: 7 })
  })

  it('takes an empty org as every org', () => {
    expect(parseFilterPrefs({ owner: '', cutoffDays: 30 })).toEqual({ owner: '', cutoffDays: 30 })
  })

  it.each(['-acme', 'acme-', 'ac--me', 'acme corp', '--owner=x', 'a'.repeat(40), 'acme/widgets'])(
    'refuses %j, which GitHub would not allow as a name',
    (owner) => {
      expect(() => parseFilterPrefs({ owner, cutoffDays: 30 })).toThrow(/isn't a GitHub org/)
    },
  )

  it('refuses a cutoff neither client offers', () => {
    expect(() => parseFilterPrefs({ owner: '', cutoffDays: 14 })).toThrow(/cutoff/)
    expect(() => parseFilterPrefs({ owner: '', cutoffDays: '30' })).toThrow(/cutoff/)
  })

  it('refuses something that is not a filter at all', () => {
    expect(() => parseFilterPrefs(null)).toThrow()
    expect(() => parseFilterPrefs([])).toThrow()
    expect(() => parseFilterPrefs({ owner: 3, cutoffDays: 30 })).toThrow()
  })
})

describe('screeningFilters', () => {
  const now = new Date('2026-10-05T12:00:00Z')

  it('resolves the cutoff to a date and scopes to the org', () => {
    expect(screeningFilters({ owner: 'acme', cutoffDays: 30 }, now)).toEqual({ owner: 'acme', updatedSince: '2026-09-05' })
  })

  it('leaves the org out when it is every org', () => {
    expect(screeningFilters({ owner: '', cutoffDays: 7 }, now)).toEqual({ updatedSince: '2026-09-28' })
  })
})

describe('parseScreeningFilters', () => {
  it('keeps known fields only', () => {
    expect(parseScreeningFilters({ owner: 'acme', updatedSince: '2026-09-05', force: true, extra: 1 })).toEqual({
      owner: 'acme',
      updatedSince: '2026-09-05',
      force: true,
    })
    expect(parseScreeningFilters({})).toEqual({})
  })

  it.each([null, 'acme', [], 7])('refuses %j, which is not an object', (raw) => {
    expect(() => parseScreeningFilters(raw)).toThrow(/must be an object/)
  })

  it.each(['2026-99-99', '2026-02-30', '2026-9-5', '05.09.2026', 20260905])('refuses the date %j', (updatedSince) => {
    expect(() => parseScreeningFilters({ updatedSince })).toThrow(/real YYYY-MM-DD/)
  })

  it('refuses an org GitHub would not allow, and a non-boolean force', () => {
    expect(() => parseScreeningFilters({ owner: '--evil' })).toThrow(/isn't a GitHub org/)
    expect(() => parseScreeningFilters({ force: 'yes' })).toThrow(/force/)
  })
})

it('reads a leap day as a date only in a leap year', () => {
  expect(isIsoDate('2028-02-29')).toBe(true)
  expect(isIsoDate('2026-02-29')).toBe(false)
})
