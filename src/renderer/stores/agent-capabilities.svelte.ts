/**
 * Renderer-side cache of each provider's `AgentCapabilities`.
 *
 * The descriptors live in main (`main/agents/*.ts`) and are the single place
 * that knows how a given agent behaves. Components ask this store what a
 * provider can do rather than branching on its id, so adding a provider means
 * registering a descriptor in main — not hunting down `provider === '…'`
 * conditionals across the UI.
 *
 * Capabilities are static per provider, so one fetch per provider is enough;
 * `capabilitiesFor` returns undefined on the first call and fills in reactively.
 */
import type { AgentCapabilities, AgentProviderId } from '../../shared/ipc-types'

let byProvider = $state<Partial<Record<AgentProviderId, AgentCapabilities>>>({})
const inFlight = new Set<AgentProviderId>()

/**
 * Discover every registered provider and cache its capabilities. Call once at
 * startup so components (and the session store, which needs them synchronously
 * when naming a new session) can read capabilities without awaiting.
 */
export async function initAgentCapabilities(): Promise<void> {
  const providers = await window.api.invoke('agent:providers').catch(() => [] as AgentProviderId[])
  const entries = await Promise.all(
    providers.map(async (id) => [id, await window.api.invoke('agent:capabilities', id).catch(() => undefined)] as const),
  )
  const loaded: Partial<Record<AgentProviderId, AgentCapabilities>> = {}
  for (const [id, caps] of entries) if (caps) loaded[id] = caps
  byProvider = { ...byProvider, ...loaded }
}

/**
 * Every provider whose capabilities have been cached, in registration order.
 * Drives provider pickers so a new provider appears by registering in main,
 * not by editing a hard-coded `<option>` list. Empty until priming completes.
 */
export function knownProviders(): AgentProviderId[] {
  return Object.keys(byProvider) as AgentProviderId[]
}

/**
 * Capabilities for `provider`, or undefined until the first fetch resolves.
 * Safe to call from a template or `$derived` — it self-primes and the result
 * lands reactively.
 */
export function capabilitiesFor(provider: AgentProviderId | undefined): AgentCapabilities | undefined {
  if (!provider) return undefined
  const known = byProvider[provider]
  if (known) return known
  if (!inFlight.has(provider)) {
    inFlight.add(provider)
    void window.api
      .invoke('agent:capabilities', provider)
      .then((caps) => { byProvider = { ...byProvider, [provider]: caps } })
      .catch(() => { /* leave undefined; callers fall back to safe defaults */ })
      .finally(() => inFlight.delete(provider))
  }
  return undefined
}

/**
 * Human-facing provider name. Falls back to the capitalised id so a brand-new
 * provider still reads sensibly before its descriptor arrives.
 */
export function providerLabel(provider: AgentProviderId | undefined): string {
  if (!provider) return 'Agent'
  return capabilitiesFor(provider)?.displayName ?? provider.charAt(0).toUpperCase() + provider.slice(1)
}

/**
 * Which agent owns a remembered `ModelRef`.
 *
 * The inverse of `nativeModelBrand`: "last model used" is persisted as a
 * ModelRef, and reopening that session needs the agent it belongs to. Resolving
 * it from the descriptors keeps the mapping in one place — the alternative was
 * a `provider === 'openai'` check that quietly sent every non-Codex native
 * model to Claude.
 */
export function providerForModelBrand(brand: string | undefined): AgentProviderId | undefined {
  if (!brand) return undefined
  return knownProviders().find((id) => byProvider[id]?.nativeModelBrand === brand)
}
