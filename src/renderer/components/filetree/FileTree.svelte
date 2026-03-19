<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import type { FileEntry, FsEventMap } from '../../../shared/ipc-types'
  import FileNode from './FileNode.svelte'

  interface Props {
    rootPath: string
    highlightedFiles?: Set<string>
    onselect?: (path: string) => void
  }

  let { rootPath, highlightedFiles = new Set(), onselect }: Props = $props()

  let entries = $state<FileEntry[]>([])
  let unsubscribe: (() => void) | undefined

  async function loadRoot(): Promise<void> {
    entries = await window.api.invoke('fs:list', rootPath)
  }

  onMount(() => {
    loadRoot()

    // Start watching
    window.api.invoke('fs:watch', rootPath)

    // Listen for changes and refresh
    unsubscribe = window.api.on('fs:changed', (_data: FsEventMap['fs:changed']) => {
      // Refresh root listing on any change
      loadRoot()
    })
  })

  onDestroy(() => {
    unsubscribe?.()
    window.api.invoke('fs:unwatch')
  })
</script>

<div role="tree" class="select-none text-sm">
  {#each entries as entry (entry.path)}
    <FileNode {entry} {highlightedFiles} {onselect} />
  {/each}
</div>
