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

function getProviderForPrefix(prefix: PalettePrefix): PaletteProvider | null {
  if (prefix === null) return null
  const category = PREFIX_CATEGORY_MAP[prefix]
  return providers.find((p) => p.category === category) ?? null
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
    const provider = getProviderForPrefix(prefix)
    if (!provider) return { groups: [], flat: [] }

    const items = await provider.search(query, context)
    return {
      groups: [{ category: provider.category, items }],
      flat: items
    }
  }

  // All mode: query all providers, limit each
  const results = await Promise.all(
    providers.map(async (p) => {
      const items = await p.search(query, context)
      const limit = ALL_MODE_LIMITS[p.category]
      return { category: p.category, items: items.slice(0, limit) }
    })
  )

  // Sort groups by the defined order, filter out empty
  const groups = CATEGORY_ORDER
    .map((cat) => results.find((r) => r.category === cat)!)
    .filter((g) => g.items.length > 0)

  const flat = groups.flatMap((g) => g.items)

  return { groups, flat }
}

export function executeItem(item: PaletteItem, context: PaletteContext): void {
  const provider = providers.find((p) => p.category === item.category)
  provider?.execute(item, context)
}
