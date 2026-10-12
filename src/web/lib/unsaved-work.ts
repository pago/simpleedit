/**
 * Work held only in a mounted component's own state, which a reload the user
 * didn't ask for would destroy (`PocketApp` `reloadDiscards`). A component
 * registers a description of what it holds — null while it holds nothing —
 * for as long as it is mounted.
 */
const sources = new Set<() => string | null>()

/** Returns the unregister, so it can be an `$effect`'s whole body. */
export function holdUnsaved(describe: () => string | null): () => void {
  sources.add(describe)
  return () => { sources.delete(describe) }
}

export function unsavedWork(): string[] {
  return [...sources].map((describe) => describe()).filter((what): what is string => what !== null)
}
