/**
 * Per-directory refresh ticks. Bumping a directory's nonce signals every
 * FileNode whose `entry.path` matches to reload its children.
 *
 * SimpleEdit doesn't watch the workspace filesystem yet, so the nonce is the
 * tree's notification channel for changes that happen via our own IPC calls
 * (new file/folder, rename, delete). External changes still need a manual
 * refresh.
 */
let nonces = $state<Record<string, number>>({})

export function fsNonceFor(dirPath: string): number {
  return nonces[dirPath] ?? 0
}

export function bumpFsNonce(dirPath: string): void {
  nonces = { ...nonces, [dirPath]: (nonces[dirPath] ?? 0) + 1 }
}
