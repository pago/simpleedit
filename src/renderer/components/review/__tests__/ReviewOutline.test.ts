import { render, screen, fireEvent, within } from '@testing-library/svelte'
import { describe, it, expect } from 'vitest'
import ReviewOutline from '../ReviewOutline.svelte'
import type { PrReviewComment } from '../../../../shared/screenprs'
import { URL_1, URL_2, layer, msg, thread } from './fixtures'

const LAYERS = [layer(183, URL_1), layer(184, URL_2)]
const THREADS = [
  thread({ id: 'rt_open0001', messages: [msg('tool', 'Open finding')] }),
  thread({ id: 'rt_done0001', status: 'done', messages: [msg('tool', 'Closed finding')] }),
  thread({ id: 'rt_mine0001', origin: { kind: 'user' }, anchor: { kind: 'pr', pr: 184 }, messages: [msg('user', 'My question')] }),
  thread({ id: 'rt_pre00001', origin: { kind: 'finding', source: 'triage', key: 'p', preExisting: true }, messages: [msg('tool', 'Old code')] }),
  thread({ id: 'rt_stack001', origin: { kind: 'user' }, anchor: { kind: 'stack' }, messages: [] }),
]
const comment: PrReviewComment = { id: 'c1', source: 'you', file: '', text: 'x', threadId: 'rt_stack001', severity: 'blocking' }
const DRAFTS = new Map([['rt_stack001', { url: URL_2, comment }]])

function show(onthread = (_id: string) => {}) {
  return render(ReviewOutline, { props: { layers: LAYERS, threads: THREADS, drafts: DRAFTS, reading: new Map(), onthread, onjump: () => {} } })
}

describe('ReviewOutline', () => {
  it('counts every filter', () => {
    show()
    expect(screen.getByTestId('outline-filter-open')).toHaveTextContent('Open 4')
    expect(screen.getByTestId('outline-filter-post')).toHaveTextContent('To post 1')
    expect(screen.getByTestId('outline-filter-done')).toHaveTextContent('Done 1')
    expect(screen.getByTestId('outline-filter-mine')).toHaveTextContent('Started by me 2')
    expect(screen.getByTestId('outline-filter-pre')).toHaveTextContent('Pre-existing 1')
    expect(screen.getByTestId('outline-filter-all')).toHaveTextContent('All 5')
  })

  it('lists what the filter picks, grouped by stack and layer', async () => {
    show()
    expect(screen.getAllByTestId('outline-item')).toHaveLength(4)
    await fireEvent.click(screen.getByTestId('outline-filter-post'))
    const items = screen.getAllByTestId('outline-item')
    expect(items).toHaveLength(1)
    expect(screen.getByText('Whole stack')).toBeInTheDocument()
    // The draft's severity is the one shown, not a tool's.
    expect(within(items[0]).getByText('blocking')).toBeInTheDocument()
    await fireEvent.click(screen.getByTestId('outline-filter-pre'))
    expect(screen.getAllByTestId('outline-item')[0]).toHaveTextContent('Old code')
  })

  it('jumps to a thread', async () => {
    let picked = ''
    show((id) => (picked = id))
    await fireEvent.click(screen.getByText('Open finding'))
    expect(picked).toBe('rt_open0001')
  })

  it('shows reading progress per layer', () => {
    render(ReviewOutline, {
      props: {
        layers: LAYERS,
        threads: [],
        drafts: new Map(),
        reading: new Map([[URL_1, [{ id: 'a', title: 'One', read: true }, { id: 'b', title: 'Two', read: false }]]]),
        onthread: () => {},
        onjump: () => {},
      },
    })
    expect(screen.getByTestId('reading-progress')).toHaveTextContent('#183 · 50% read')
    expect(screen.getByText('#184 · no reading order yet')).toBeInTheDocument()
  })
})
