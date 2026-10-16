import { render, screen, fireEvent } from '@testing-library/svelte'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import DefaultModelPane from '../DefaultModelPane.svelte'
import { _resetAllowlistedModelsForTests } from '../../../lib/agentModels'

let invoke: ReturnType<typeof vi.fn>
const SONNET = { provider: 'claude', model: { provider: 'anthropic', model: 'claude-sonnet-5-5' } }

beforeEach(() => {
  _resetAllowlistedModelsForTests()
  invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'models:config-get') return { defaults: {}, submenuAllowlist: ['claude-sonnet-5-5'] }
    if (channel === 'models:config-set') return { defaults: {}, submenuAllowlist: ['claude-sonnet-5-5'], ...(args[0] as object) }
    if (channel === 'models:claude') return [{ model: 'claude-sonnet-5-5', displayName: 'Sonnet' }]
    return []
  })
  vi.stubGlobal('api', { invoke, on: () => () => {} })
})

describe('DefaultModelPane — review companion', () => {
  it('offers Default plus the Models allowlist, and saves the pick', async () => {
    render(DefaultModelPane)
    const select = await screen.findByLabelText('Default review companion')
    await vi.waitFor(() => expect(screen.getByRole('option', { name: 'Claude · Sonnet' })).toBeInTheDocument())
    expect(select).toHaveValue('')
    const option = screen.getByRole<HTMLOptionElement>('option', { name: 'Claude · Sonnet' })
    await fireEvent.change(select, { target: { value: option.value } })
    expect(invoke).toHaveBeenCalledWith('models:config-set', { reviewCompanion: SONNET })

    await fireEvent.change(select, { target: { value: '' } })
    const cleared = invoke.mock.calls.at(-1)
    expect(cleared?.[0]).toBe('models:config-set')
    expect(cleared?.[1]).toHaveProperty('reviewCompanion', undefined)
  })
})
