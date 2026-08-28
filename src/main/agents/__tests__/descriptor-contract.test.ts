import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/app' },
}))

import { claudeProvider } from '../claude'
import { codexProvider } from '../codex'
import { opencodeProvider } from '../opencode'
import type { AgentProvider } from '../provider'

/**
 * Contracts every descriptor owes, asserted against the REAL descriptors.
 *
 * A descriptor field that nothing checks is a field that can be forgotten, and
 * forgetting one does not fail loudly — it silently removes a code path. Codex
 * shipped without `nativeModelBrand`, which made `lastUsed` unwritable for a
 * Codex session and therefore made "start the last agent I used" unable to
 * produce Codex at all. Nothing broke; a whole provider just stopped being
 * reachable that way.
 *
 * Every renderer-side test of that path built its own capability fixtures, so
 * they all passed against a world production could not produce.
 */
const PROVIDERS: AgentProvider[] = [claudeProvider, codexProvider, opencodeProvider]

describe('agent descriptor contracts', () => {
  it.each(PROVIDERS.map((p) => [p.id, p] as const))(
    '%s: a model-id provider names the ModelRef brand its bare ids belong to',
    (_id, provider) => {
      const caps = provider.capabilities
      // Without it, `createAgent` cannot lift a bare native id into the
      // uniform ModelRef that "last model used" is stored as — so the model is
      // remembered as nothing, and every path keyed off it resolves elsewhere.
      if (caps.modelSelector === 'model-id') {
        expect(caps.nativeModelBrand).toBeTruthy()
      } else {
        // A `model-ref` provider already carries a fully-formed ModelRef;
        // declaring a brand as well would give the id two owners.
        expect(caps.nativeModelBrand).toBeUndefined()
      }
    },
  )

  it('gives every brand exactly one owner, so a remembered model resolves back', () => {
    const brands = PROVIDERS.map((p) => p.capabilities.nativeModelBrand).filter(Boolean)
    expect(new Set(brands).size).toBe(brands.length)
  })
})
