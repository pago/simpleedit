import { describe, it, expect } from 'vitest'
import { isIsoDate, parseFilterPrefs, parseScreeningFilters, scheduleHint, screeningFilters } from '../screenprs-filter'

describe('parseFilterPrefs', () => {
  it('keeps a valid org and cutoff, trimmed', () => {
    expect(parseFilterPrefs({ owner: '  acme-corp ', cutoffDays: 7 })).toEqual({ owner: 'acme-corp', cutoffDays: 7, autoScreenHours: 0 })
  })

  it('takes an empty org as every org', () => {
    expect(parseFilterPrefs({ owner: '', cutoffDays: 30 })).toEqual({ owner: '', cutoffDays: 30, autoScreenHours: 0 })
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

  it('keeps an offered interval and refuses any other', () => {
    expect(parseFilterPrefs({ owner: '', cutoffDays: 30, autoScreenHours: 4 })).toMatchObject({ autoScreenHours: 4 })
    expect(() => parseFilterPrefs({ owner: '', cutoffDays: 30, autoScreenHours: 3 })).toThrow(/Auto-screening/)
    expect(() => parseFilterPrefs({ owner: '', cutoffDays: 30, autoScreenHours: '4' })).toThrow(/Auto-screening/)
  })

  it('takes a missing interval from the current filter, so an older client keeps the schedule', () => {
    const current = { owner: 'acme', cutoffDays: 30 as const, autoScreenHours: 2 as const }
    expect(parseFilterPrefs({ owner: 'acme', cutoffDays: 7 }, current)).toMatchObject({ autoScreenHours: 2 })
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
    expect(screeningFilters({ owner: 'acme', cutoffDays: 30, autoScreenHours: 4 }, now)).toEqual({ owner: 'acme', updatedSince: '2026-09-05' })
  })

  it('leaves the org out when it is every org', () => {
    expect(screeningFilters({ owner: '', cutoffDays: 7, autoScreenHours: 0 }, now)).toEqual({ updatedSince: '2026-09-28' })
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

describe('scheduleHint', () => {
  const now = 10 * 3_600_000
  it('says when it last screened and when it screens next', () => {
    expect(scheduleHint({ lastAt: now - 23 * 60_000, nextAt: now + 97 * 60_000 }, now)).toBe('screened 23m ago · next in 1h 37m')
    expect(scheduleHint({ lastAt: now - 5 * 3_600_000 }, now)).toBe('screened 5h ago')
    expect(scheduleHint({ lastAt: now - 10_000, nextAt: now + 2 * 3_600_000 }, now)).toBe('screened just now · next in 2h')
  })

  it('says shortly for a run that is due, and nothing before the first screening with the schedule off', () => {
    expect(scheduleHint({ nextAt: now - 1 }, now)).toBe('next shortly')
    expect(scheduleHint({}, now)).toBeNull()
  })
})
