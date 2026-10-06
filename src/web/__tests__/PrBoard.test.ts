import { render, screen, fireEvent } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import PrBoard from '../PrBoard.svelte'
import { screenPrsStore } from '../../renderer/stores/screenprs.svelte'
import type { PrRef, ScreenPrCard } from '../../shared/screenprs'

/**
 * Buckets ORDER the board; they do not gate it.
 *
 * An earlier draft of the plan let you approve only from `quick` and sent the
 * rest to the desk. That was wrong — GitHub's own app does full review, and the
 * anchoring problem it was meant to dodge is already solved in
 * `buildReviewPayload`. So the assertion here is that every card, in every
 * bucket, opens the same way.
 */
function card(over: Partial<ScreenPrCard> & Pick<ScreenPrCard, 'number' | 'bucket'>): ScreenPrCard {
  return {
    owner: 'acme', repo: 'acme/widgets', url: `https://github.com/acme/widgets/pull/${over.number}`,
    title: `PR ${over.number}`, author: 'dana', updatedAt: '2026-08-01T00:00:00Z',
    headSha: `sha${over.number}`, additions: 1, deletions: 0, changedFiles: 1,
    baseRefName: 'main', headRefName: `feat-${over.number}`, ci: 'green', ciFailing: [],
    reviewers: [], approvedByOther: false, body: '', diff: '',
    impact: 'low', findings: [],
    ...over,
  }
}

const CARDS = [
  card({ number: 1, bucket: 'fyi', approvedByOther: true }),
  card({ number: 2, bucket: 'waiting', ci: 'failing' }),
  card({ number: 3, bucket: 'quick' }),
  card({ number: 4, bucket: 'attention', impact: 'high', findings: [{ label: 'issue', file: 'a.ts', title: 'x' }] }),
]

beforeEach(() => {
  vi.stubGlobal('api', { invoke: vi.fn(async () => undefined), on: () => () => {} })
  screenPrsStore._onQueued([])
  for (const c of CARDS) screenPrsStore._onCard(c)
  screenPrsStore._onStatus('done', CARDS.length)
})

describe('PrBoard', () => {
  it('orders the sections attention → quick → waiting → fyi', () => {
    render(PrBoard, { onopen: vi.fn() })
    expect(screen.getAllByTestId('bucket').map((el) => el.dataset.bucket)).toEqual([
      'attention', 'quick', 'waiting', 'fyi',
    ])
  })

  it('opens a PR from every bucket, not just the quick one', async () => {
    const opened: PrRef[] = []
    render(PrBoard, { onopen: (pr: PrRef) => opened.push(pr) })

    for (const el of screen.getAllByTestId('pr-card')) await fireEvent.click(el)

    expect(opened.map((p) => p.number).sort()).toEqual([1, 2, 3, 4])
  })

  it('flags what makes an attention PR worth reading first', () => {
    render(PrBoard, { onopen: vi.fn() })
    const attention = screen.getAllByTestId('bucket')[0]
    expect(attention).toHaveTextContent('high impact')
    expect(attention.querySelector('[data-testid="issue-count"]')).toHaveTextContent('1 issue')
  })
})

describe('PrBoard — the shared filter', () => {
  let invoke: ReturnType<typeof vi.fn>
  let saved: { owner: string; cutoffDays: number }
  let rev = 1_000

  beforeEach(async () => {
    saved = { owner: 'acme', cutoffDays: 90 }
    invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === 'screenprs:filter-get') return { filter: saved, rev: ++rev }
      if (channel === 'screenprs:filter-set') {
        const next = args[0] as { owner: string; cutoffDays: number }
        if (next.owner.includes(' ')) throw new Error(`“${next.owner}” isn't a GitHub org or user name.`)
        saved = next
        return { filter: saved, rev: ++rev }
      }
      return undefined
    })
    vi.stubGlobal('api', { invoke, on: () => () => {} })
    await screenPrsStore.loadFilter()
  })

  it('shows the org and cutoff main holds', () => {
    render(PrBoard, { onopen: vi.fn() })
    expect(screen.getByTestId('filter-owner')).toHaveValue('acme')
    expect(screen.getByTestId('filter-cutoff')).toHaveValue('90')
  })

  it('offers the orgs on the board', () => {
    const { container } = render(PrBoard, { onopen: vi.fn() })
    expect([...container.querySelectorAll('datalist option')].map((o) => o.getAttribute('value'))).toEqual(['acme'])
  })

  it('saves an org for every client and screens with it', async () => {
    render(PrBoard, { onopen: vi.fn() })
    const field = screen.getByTestId('filter-owner')
    await fireEvent.focus(field)
    await fireEvent.input(field, { target: { value: ' widgets-inc ' } })
    await fireEvent.blur(field)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('screenprs:filter-set', { owner: 'widgets-inc', cutoffDays: 90 }))

    screenPrsStore._onStatus('done', 0)
    await fireEvent.click(screen.getByTestId('screen-prs'))
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('screenprs:start', expect.objectContaining({ owner: 'widgets-inc' })),
    )
  })

  it('saves a new cutoff', async () => {
    render(PrBoard, { onopen: vi.fn() })
    await fireEvent.change(screen.getByTestId('filter-cutoff'), { target: { value: '7' } })
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('screenprs:filter-set', { owner: 'acme', cutoffDays: 7 }))
  })

  it('says why main refused an org, and does not screen with it', async () => {
    render(PrBoard, { onopen: vi.fn() })
    const field = screen.getByTestId('filter-owner')
    await fireEvent.input(field, { target: { value: 'not an org' } })
    screenPrsStore._onStatus('done', 0)
    await fireEvent.click(screen.getByTestId('screen-prs'))
    expect(await screen.findByTestId('filter-error')).toHaveTextContent("isn't a GitHub org")
    expect(invoke).not.toHaveBeenCalledWith('screenprs:start', expect.anything())
    expect(field).toHaveValue('acme')
  })

  it('waits for the save a tap on Screen began, and does not screen with a refused org', async () => {
    render(PrBoard, { onopen: vi.fn() })
    const field = screen.getByTestId('filter-owner')
    await fireEvent.input(field, { target: { value: 'not an org' } })
    // The tap blurs the field first, which starts the save; the click lands while it is in flight.
    await fireEvent.blur(field)
    screenPrsStore._onStatus('done', 0)
    await fireEvent.click(screen.getByTestId('screen-prs'))
    expect(await screen.findByTestId('filter-error')).toHaveTextContent("isn't a GitHub org")
    // Whatever ran, it ran with the org the field went back to, never the refused one.
    const starts = invoke.mock.calls.filter(([ch]) => ch === 'screenprs:start').map(([, f]) => f as { owner?: string })
    expect(starts.every((f) => f.owner === 'acme')).toBe(true)
    expect(field).toHaveValue('acme')
  })

  it('does not save over another client\'s org when the field is only focused', async () => {
    render(PrBoard, { onopen: vi.fn() })
    const field = screen.getByTestId('filter-owner')
    await fireEvent.focus(field)
    saved = { owner: 'desk-org', cutoffDays: 90 }
    await screenPrsStore.loadFilter()
    await fireEvent.blur(field)
    expect(invoke).not.toHaveBeenCalledWith('screenprs:filter-set', expect.anything())
    expect(field).toHaveValue('desk-org')
  })

  it('follows a change made on another client', async () => {
    render(PrBoard, { onopen: vi.fn() })
    saved = { owner: 'other-org', cutoffDays: 30 }
    await screenPrsStore.loadFilter()
    await vi.waitFor(() => expect(screen.getByTestId('filter-owner')).toHaveValue('other-org'))
    expect(screen.getByTestId('filter-cutoff')).toHaveValue('30')
  })
})

/**
 * Screening belongs to the app, so a phone that switches project mid-run keeps
 * following it: the reconnect catches it up from main (`loadState`), and the
 * run's later events reach it on the new window's hub.
 */
describe('PrBoard — a run that outlives a project switch', () => {
  const pr = card({ number: 9, bucket: 'quick' })

  beforeEach(() => {
    screenPrsStore._onStatus('done', 0)
    screenPrsStore._onStatus('running')
  })

  it('shows the run still going after the switch, then its result', async () => {
    vi.stubGlobal('api', {
      on: () => () => {},
      invoke: vi.fn(async (channel: string) =>
        channel === 'screenprs:state'
          ? { run: { status: 'running', total: 1, entries: [{ ref: pr }], triaging: [] }, deep: {}, overviews: {} }
          : undefined,
      ),
    })
    render(PrBoard, { onopen: vi.fn() })
    await screenPrsStore.loadState()

    expect(await screen.findByTestId('screen-prs')).toHaveTextContent('Screening…')
    expect(screen.getByTestId('cancel-screen')).toBeInTheDocument()

    screenPrsStore._onCard(pr)
    screenPrsStore._onStatus('done', 1)

    await vi.waitFor(() => expect(screen.getByTestId('screen-prs')).toHaveTextContent('Re-screen'))
    expect(screen.getAllByTestId('pr-card')).toHaveLength(1)
  })

  it('settles when another client stops it', async () => {
    render(PrBoard, { onopen: vi.fn() })
    expect(screen.getByTestId('cancel-screen')).toBeInTheDocument()

    screenPrsStore._onStatus('cancelled')

    await vi.waitFor(() => expect(screen.queryByTestId('cancel-screen')).not.toBeInTheDocument())
    expect(screen.getByTestId('screen-prs')).toHaveTextContent('Re-screen')
    expect(screen.getByTestId('pr-board')).toHaveTextContent('Screening was stopped')
  })
})
