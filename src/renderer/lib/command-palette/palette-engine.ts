import type { PaletteItem, PaletteCategory, PaletteContext, PaletteProvider, PalettePrefix } from './types'
import { parseQuery, PREFIX_CATEGORY_MAP, ALL_MODE_LIMITS } from './types'
import { fileProvider } from './providers/file-provider'
import { worktreeProvider } from './providers/worktree-provider'
import { actionProvider } from './providers/action-provider'
import { commitProvider } from './providers/commit-provider'

const providers: PaletteProvider[] = [
  fileProvider,
  worktreeProvider,
  actionProvider,
  commitProvider
]

const GIT_CATEGORIES: ReadonlySet<PaletteCategory> = new Set(['action', 'commit'])

function activeProviders(context: PaletteContext): PaletteProvider[] {
  return context.memory ? providers.filter((p) => !GIT_CATEGORIES.has(p.category)) : providers
}

function getProviderForPrefix(prefix: PalettePrefix, context: PaletteContext): PaletteProvider | null {
  if (prefix === null) return null
  const category = PREFIX_CATEGORY_MAP[prefix]
  return activeProviders(context).find((p) => p.category === category) ?? null
}

export interface GroupedResults {
  groups: { category: PaletteCategory; items: PaletteItem[] }[]
  flat: PaletteItem[]
}

/** Category display order */
const CATEGORY_ORDER: PaletteCategory[] = ['file', 'worktree', 'action', 'commit']

export async function search(raw: string, context: PaletteContext): Promise<GroupedResults> {
  const { prefix, query } = parseQuery(raw)

  if (prefix !== null) {
    // Filtered mode: single provider
    const provider = getProviderForPrefix(prefix, context)
    if (!provider) return { groups: [], flat: [] }

    let items: PaletteItem[]
    try {
      items = await provider.search(query, context)
    } catch (err) {
      console.warn('[palette] provider failed:', err)
      items = []
    }
    return {
      groups: [{ category: provider.category, items }],
      flat: items
    }
  }

  // All mode: query all providers, limit each. One failing provider must not
  // blank the others.
  const settled = await Promise.allSettled(
    activeProviders(context).map(async (p) => {
      const items = await p.search(query, context)
      const limit = ALL_MODE_LIMITS[p.category]
      return { category: p.category, items: items.slice(0, limit) }
    })
  )
  const results = settled.flatMap((r) => {
    if (r.status === 'fulfilled') return [r.value]
    console.warn('[palette] provider failed:', r.reason)
    return []
  })

  // Sort groups by the defined order, filter out empty
  const groups = CATEGORY_ORDER
    .flatMap((cat) => results.filter((r) => r.category === cat))
    .filter((g) => g.items.length > 0)

  const flat = groups.flatMap((g) => g.items)

  return { groups, flat }
}

export function executeItem(item: PaletteItem, context: PaletteContext): void {
  const provider = activeProviders(context).find((p) => p.category === item.category)
  provider?.execute(item, context)
}
