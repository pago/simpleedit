<script lang="ts">
  // Placeholder — will be built out by Tracks B, C, D
  // Terminal (bottom), file tree (left of editor), editor (center)

  let splitPosition = $state(60) // percentage for editor vs terminal
  let isResizing = $state(false)

  function onMouseDown() {
    isResizing = true
    const container = document.getElementById('main-panel')!

    function onMouseMove(e: MouseEvent) {
      const rect = container.getBoundingClientRect()
      const pct = ((e.clientY - rect.top) / rect.height) * 100
      splitPosition = Math.max(20, Math.min(80, pct))
    }

    function onMouseUp() {
      isResizing = false
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }
</script>

<div
  id="main-panel"
  class="flex h-full flex-col"
  class:select-none={isResizing}
>
  <!-- Top: file tree + editor area -->
  <div class="flex min-h-0" style:height="{splitPosition}%">
    <div class="w-52 flex-none overflow-y-auto border-r border-zinc-800 p-2">
      <p class="text-xs text-zinc-500">File tree placeholder</p>
    </div>
    <div class="flex-1 flex items-center justify-center">
      <p class="text-sm text-zinc-600">Open a file to start editing</p>
    </div>
  </div>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="h-1 flex-none cursor-row-resize bg-zinc-800 hover:bg-blue-500 transition-colors"
    role="separator"
    aria-orientation="horizontal"
    tabindex="0"
    onmousedown={onMouseDown}
  ></div>

  <!-- Bottom: terminal area -->
  <div class="min-h-0 flex-1 bg-black p-2">
    <p class="text-xs text-zinc-500">Terminal placeholder</p>
  </div>
</div>
