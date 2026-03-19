<script lang="ts">
  import Sidebar from './components/sidebar/Sidebar.svelte'
  import PaneManager from './components/layout/PaneManager.svelte'

  let sidebarWidth = $state(260)
  let isResizing = $state(false)

  function onMouseDown() {
    isResizing = true

    function onMouseMove(e: MouseEvent) {
      sidebarWidth = Math.max(180, Math.min(500, e.clientX))
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

<div class="flex h-full flex-col" class:select-none={isResizing}>
  <!-- Title bar / drag region -->
  <div class="drag-region flex h-9 flex-none items-center border-b border-zinc-700 bg-zinc-900">
    <div class="flex items-center pl-[78px]" style:width="{sidebarWidth}px">
      <h1 class="text-xs font-semibold tracking-wide text-zinc-400">SimpleEdit</h1>
    </div>
  </div>

  <!-- Main content below title bar -->
  <div class="flex min-h-0 flex-1">
    <aside
      class="flex-none overflow-y-auto border-r border-zinc-700 bg-zinc-900"
      style:width="{sidebarWidth}px"
    >
      <Sidebar />
    </aside>

    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      class="w-1 flex-none cursor-col-resize bg-zinc-800 hover:bg-blue-500 transition-colors"
      role="separator"
      aria-orientation="vertical"
      tabindex="0"
      onmousedown={onMouseDown}
    ></div>

    <main class="flex-1 overflow-hidden bg-zinc-950">
      <PaneManager />
    </main>
  </div>
</div>
