import { render, screen, fireEvent, waitFor } from '@testing-library/svelte'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Welcome from '../Welcome.svelte'

beforeEach(() => {
  vi.stubGlobal('api', {
    invoke: vi.fn().mockResolvedValue([]) // no recent repos by default
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Welcome', () => {
  it('renders the app name and tagline', () => {
    render(Welcome, { onreposelected: vi.fn() })
    expect(screen.getByRole('heading', { name: 'SimpleEdit' })).toBeInTheDocument()
    expect(
      screen.getByText('Agentic Development Environment for Claude Code')
    ).toBeInTheDocument()
  })

  it('shows Open Repository and Checkout Repository buttons', () => {
    render(Welcome, { onreposelected: vi.fn() })
    expect(screen.getByRole('button', { name: 'Open Repository...' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Checkout Repository...' })).toBeInTheDocument()
  })

  it('clone form is hidden by default', () => {
    render(Welcome, { onreposelected: vi.fn() })
    expect(screen.queryByLabelText('Repository URL')).not.toBeInTheDocument()
  })

  it('clone form expands when Checkout Repository is clicked', async () => {
    render(Welcome, { onreposelected: vi.fn() })
    await fireEvent.click(screen.getByRole('button', { name: 'Checkout Repository...' }))
    expect(screen.getByLabelText('Repository URL')).toBeInTheDocument()
    expect(screen.getByLabelText('Destination')).toBeInTheDocument()
  })

  it('Clone button is disabled when fields are empty', async () => {
    render(Welcome, { onreposelected: vi.fn() })
    await fireEvent.click(screen.getByRole('button', { name: 'Checkout Repository...' }))
    expect(screen.getByRole('button', { name: 'Clone' })).toBeDisabled()
  })

  it('does not show Recent Repos section when there are none', () => {
    render(Welcome, { onreposelected: vi.fn() })
    expect(screen.queryByText('Recently Opened')).not.toBeInTheDocument()
  })

  it('shows recent repos when available', async () => {
    const recent = [
      { name: 'myproject', path: '/repos/myproject.git', lastOpened: new Date().toISOString() }
    ]
    vi.mocked(window.api.invoke).mockResolvedValue(recent)

    render(Welcome, { onreposelected: vi.fn() })

    await waitFor(() => {
      expect(screen.getByText('Recently Opened')).toBeInTheDocument()
      expect(screen.getByText('myproject')).toBeInTheDocument()
    })
  })

  it('calls onreposelected when a recent repo is clicked', async () => {
    const onreposelected = vi.fn()
    const recent = [
      { name: 'myproject', path: '/repos/myproject.git', lastOpened: new Date().toISOString() }
    ]
    vi.mocked(window.api.invoke).mockResolvedValue(recent)

    render(Welcome, { onreposelected })

    await waitFor(() => screen.getByText('myproject'))
    await fireEvent.click(screen.getByText('myproject'))
    expect(onreposelected).toHaveBeenCalledWith('/repos/myproject.git')
  })
})
