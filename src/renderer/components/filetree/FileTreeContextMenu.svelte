<script lang="ts">
  import type { FileEntry } from '../../../shared/ipc-types'

  export type ContextMenuAction = 'new-file' | 'new-folder' | 'rename' | 'delete'

  interface Props {
    x: number
    y: number
    entry: FileEntry
    onaction: (action: ContextMenuAction) => void
    onclose: () => void
  }

  let { x, y, entry, onaction, onclose }: Props = $props()

  let menuEl: HTMLDivElement | undefined = $state()

  // Reposition so the menu stays inside the viewport when opened near the
  // bottom or right edge.
  let posX = $state(x)
  let posY = $state(y)
  $effect(() => {
    if (!menuEl) return
    const rect = menuEl.getBoundingClientRect()
    const margin = 4
    if (rect.right > window.innerWidth - margin) {
      posX = Math.max(margin, window.innerWidth - rect.width - margin)
    }
    if (rect.bottom > window.innerHeight - margin) {
      posY = Math.max(margin, window.innerHeight - rect.height - margin)
    }
  })

  $effect(() => {
    function onPointerDown(e: PointerEvent): void {
      if (menuEl && !menuEl.contains(e.target as Node)) onclose()
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onclose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  })

  function pick(action: ContextMenuAction): void {
    onaction(action)
    onclose()
  }
</script>

<div
  bind:this={menuEl}
  role="menu"
  class="fixed z-50 min-w-[160px] rounded border border-zinc-700 bg-zinc-900 py-1 text-sm text-zinc-200 shadow-xl"
  style:left="{posX}px"
  style:top="{posY}px"
>
  {#if entry.isDirectory}
    <button
      role="menuitem"
      class="block w-full px-3 py-1 text-left hover:bg-zinc-800"
      onclick={() => pick('new-file')}
    >
      New File…
    </button>
    <button
      role="menuitem"
      class="block w-full px-3 py-1 text-left hover:bg-zinc-800"
      onclick={() => pick('new-folder')}
    >
      New Folder…
    </button>
    <div class="my-1 border-t border-zinc-800"></div>
  {/if}
  <button
    role="menuitem"
    class="block w-full px-3 py-1 text-left hover:bg-zinc-800"
    onclick={() => pick('rename')}
  >
    Rename…
  </button>
  <button
    role="menuitem"
    class="block w-full px-3 py-1 text-left text-red-400 hover:bg-zinc-800"
    onclick={() => pick('delete')}
  >
    Delete
  </button>
</div>
