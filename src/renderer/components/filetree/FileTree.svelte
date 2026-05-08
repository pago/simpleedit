<script lang="ts">
  import type { FileEntry } from '../../../shared/ipc-types'
  import FileNode from './FileNode.svelte'
  import FileTreeContextMenu, { type ContextMenuAction } from './FileTreeContextMenu.svelte'
  import PromptModal from './PromptModal.svelte'
  import { bumpFsNonce, fsNonceFor } from '../../stores/fsRefresh.svelte'

  interface Props {
    rootPath: string
    activeFilePath?: string | null
    highlightedFiles?: Set<string>
    onselect?: (path: string) => void
    oncollapse?: () => void
  }

  let {
    rootPath,
    activeFilePath = null,
    highlightedFiles = new Set(),
    onselect,
    oncollapse,
  }: Props = $props()

  let entries = $state<FileEntry[]>([])
  let revealRequest = $state<{ path: string; nonce: number } | null>(null)

  async function loadRoot(): Promise<void> {
    entries = await window.api.invoke('fs:list', rootPath)
  }

  // Reload when rootPath changes
  $effect(() => {
    void rootPath
    loadRoot()
  })

  // Reload when the root's nonce bumps (a context menu action affected the
  // top level of this worktree).
  $effect(() => {
    void fsNonceFor(rootPath)
    void loadRoot()
  })

  function revealActive(): void {
    if (!activeFilePath) return
    revealRequest = {
      path: activeFilePath,
      nonce: (revealRequest?.nonce ?? 0) + 1,
    }
  }

  // ── Context menu / modal state ──────────────────────────
  type Modal =
    | { kind: 'new-file'; parent: FileEntry }
    | { kind: 'new-folder'; parent: FileEntry }
    | { kind: 'rename'; entry: FileEntry }
    | { kind: 'delete'; entry: FileEntry }

  let menuState = $state<{ x: number; y: number; entry: FileEntry } | null>(null)
  let modal = $state<Modal | null>(null)
  let opError = $state<string | null>(null)

  function openContextMenu(entry: FileEntry, x: number, y: number): void {
    menuState = { x, y, entry }
  }

  function closeMenu(): void {
    menuState = null
  }

  function handleAction(action: ContextMenuAction): void {
    const target = menuState?.entry
    if (!target) return
    closeMenu()
    if (action === 'new-file') modal = { kind: 'new-file', parent: target }
    else if (action === 'new-folder') modal = { kind: 'new-folder', parent: target }
    else if (action === 'rename') modal = { kind: 'rename', entry: target }
    else if (action === 'delete') modal = { kind: 'delete', entry: target }
  }

  function closeModal(): void {
    modal = null
    opError = null
  }

  function joinPath(parent: string, name: string): string {
    const sep = parent.includes('\\') && !parent.includes('/') ? '\\' : '/'
    const trimmed = parent.endsWith(sep) ? parent.slice(0, -1) : parent
    return `${trimmed}${sep}${name}`
  }

  function parentDir(path: string): string {
    const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    return lastSlash <= 0 ? path : path.slice(0, lastSlash)
  }

  function validateName(value: string): string | null {
    const trimmed = value.trim()
    if (!trimmed) return 'Name is required'
    if (trimmed.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
      return 'Name must be relative'
    }
    const parts = trimmed.split(/[\\/]/)
    if (parts.some((s) => s === '..' || s === '.' || s === '')) {
      return 'Name cannot contain "." or ".." segments'
    }
    return null
  }

  async function performCreateFile(parent: FileEntry, name: string): Promise<void> {
    const fullPath = joinPath(parent.path, name.trim())
    await window.api.invoke('fs:create-file', fullPath)
    bumpFsNonce(parent.path)
    onselect?.(fullPath)
  }

  async function performCreateFolder(parent: FileEntry, name: string): Promise<void> {
    const fullPath = joinPath(parent.path, name.trim())
    await window.api.invoke('fs:create-dir', fullPath)
    bumpFsNonce(parent.path)
  }

  async function performRename(entry: FileEntry, newName: string): Promise<void> {
    const parent = parentDir(entry.path)
    const newPath = joinPath(parent, newName.trim())
    if (newPath === entry.path) return
    await window.api.invoke('fs:rename', entry.path, newPath)
    bumpFsNonce(parent)
  }

  async function performDelete(entry: FileEntry): Promise<void> {
    await window.api.invoke('fs:delete', entry.path)
    bumpFsNonce(parentDir(entry.path))
  }

  async function submitModal(value: string): Promise<void> {
    if (!modal) return
    opError = null
    try {
      if (modal.kind === 'new-file') await performCreateFile(modal.parent, value)
      else if (modal.kind === 'new-folder') await performCreateFolder(modal.parent, value)
      else if (modal.kind === 'rename') await performRename(modal.entry, value)
      modal = null
    } catch (err: unknown) {
      opError = err instanceof Error ? err.message : String(err)
    }
  }

  async function confirmDelete(): Promise<void> {
    if (modal?.kind !== 'delete') return
    opError = null
    try {
      await performDelete(modal.entry)
      modal = null
    } catch (err: unknown) {
      opError = err instanceof Error ? err.message : String(err)
    }
  }
</script>

<div class="flex flex-col">
  <div class="sticky top-0 z-10 -mx-2 flex items-center justify-between bg-zinc-950 px-3 pb-1 pt-2">
    <span class="text-xs font-medium uppercase tracking-wider text-zinc-400">Files</span>
    <div class="flex items-center gap-0.5">
      <button
        class="rounded px-1 py-0.5 text-zinc-400 enabled:hover:bg-zinc-700 enabled:hover:text-zinc-200 disabled:opacity-40"
        onclick={revealActive}
        disabled={!activeFilePath}
        title="Select opened file"
        aria-label="Select opened file"
      >
        <svg viewBox="0 0 16 16" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round">
          <circle cx="8" cy="8" r="5.5" />
          <circle cx="8" cy="8" r="2.5" />
          <path d="M8 0.5v3" />
          <path d="M8 12.5v3" />
          <path d="M0.5 8h3" />
          <path d="M12.5 8h3" />
        </svg>
      </button>
      <button
        class="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
        onclick={loadRoot}
        title="Refresh"
      >
        ↻
      </button>
      {#if oncollapse}
        <button
          class="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
          onclick={oncollapse}
          title="Collapse file tree"
        >
          ⏵
        </button>
      {/if}
    </div>
  </div>

  <div role="tree" class="select-none text-sm">
    {#each entries as entry (entry.path)}
      <FileNode
        {entry}
        {highlightedFiles}
        {revealRequest}
        {onselect}
        oncontextmenu={openContextMenu}
      />
    {/each}
  </div>
</div>

{#if menuState}
  <FileTreeContextMenu
    x={menuState.x}
    y={menuState.y}
    entry={menuState.entry}
    onaction={handleAction}
    onclose={closeMenu}
  />
{/if}

{#if modal?.kind === 'new-file'}
  <PromptModal
    title="New File"
    label="File name (forward slashes create subdirectories)"
    confirmLabel="Create"
    validate={validateName}
    onsubmit={submitModal}
    oncancel={closeModal}
  />
{:else if modal?.kind === 'new-folder'}
  <PromptModal
    title="New Folder"
    label="Folder name"
    confirmLabel="Create"
    validate={validateName}
    onsubmit={submitModal}
    oncancel={closeModal}
  />
{:else if modal?.kind === 'rename'}
  <PromptModal
    title="Rename"
    label="New name"
    defaultValue={modal.entry.name}
    selectionRange={[0, modal.entry.isDirectory
      ? modal.entry.name.length
      : modal.entry.name.lastIndexOf('.') > 0
        ? modal.entry.name.lastIndexOf('.')
        : modal.entry.name.length]}
    confirmLabel="Rename"
    validate={validateName}
    onsubmit={submitModal}
    oncancel={closeModal}
  />
{:else if modal?.kind === 'delete'}
  <!-- Confirmation dialog reuses PromptModal's chrome shape via inline render -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    onclick={closeModal}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div
      class="w-[420px] rounded-md border border-zinc-700 bg-zinc-900 p-4 shadow-2xl"
      onclick={(e) => e.stopPropagation()}
      role="alertdialog"
      aria-modal="true"
      aria-label="Confirm delete"
    >
      <h2 class="mb-2 text-sm font-medium text-zinc-100">Delete {modal.entry.isDirectory ? 'folder' : 'file'}?</h2>
      <p class="text-sm text-zinc-300">
        Move <span class="font-mono text-zinc-100">{modal.entry.name}</span> to the system trash. You can restore it from there.
      </p>
      {#if opError}
        <p class="mt-2 text-xs text-red-400">{opError}</p>
      {/if}
      <div class="mt-4 flex justify-end gap-2">
        <button
          class="rounded border border-zinc-700 px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-800"
          onclick={closeModal}
        >
          Cancel
        </button>
        <button
          class="rounded bg-red-600 px-3 py-1 text-sm text-white hover:bg-red-500"
          onclick={confirmDelete}
        >
          Move to Trash
        </button>
      </div>
    </div>
  </div>
{/if}

{#if opError && modal && modal.kind !== 'delete'}
  <!-- Surface non-delete errors above the modal as a transient banner. The
       modal itself stays open so the user can fix the input and retry. -->
  <div class="fixed bottom-4 right-4 z-[60] max-w-md rounded border border-red-700 bg-red-950 px-3 py-2 text-xs text-red-200 shadow-lg">
    {opError}
  </div>
{/if}
