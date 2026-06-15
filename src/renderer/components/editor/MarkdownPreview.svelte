<script lang="ts">
  import { renderMarkdown } from '../../lib/markdown'
  import { enhanceCodeBlocks, rewriteRelativeImages, resolvePosix } from '../../lib/markdown-enhance'

  interface Props {
    source: string
    filePath: string
    worktreeRoot: string | null
    onOpenFile?: (path: string) => void
    /** Reports the scrollable element so the hybrid view can sync scroll. */
    onScrollElement?: (el: HTMLElement | null) => void
  }

  let { source, filePath, worktreeRoot, onOpenFile, onScrollElement }: Props = $props()

  let scroller: HTMLDivElement | undefined = $state()
  let html = $state('')
  let renderToken = 0
  let firstRender = true

  const fileDir = $derived(filePath.slice(0, filePath.lastIndexOf('/')) || '/')

  // Parse markdown → sanitized HTML. Debounced after the first paint so live
  // edits in hybrid mode don't re-parse on every keystroke.
  $effect(() => {
    const src = source
    const delay = firstRender ? 0 : 120
    const t = setTimeout(() => {
      html = renderMarkdown(src)
      firstRender = false
    }, delay)
    return () => clearTimeout(t)
  })

  // After the HTML mounts, rewrite relative images and enhance code blocks.
  // Runs post-DOM-update because it depends on `html`.
  $effect(() => {
    void html
    const el = scroller
    if (!el || !html) return
    const token = ++renderToken
    if (worktreeRoot) rewriteRelativeImages(el, fileDir, worktreeRoot)
    void enhanceCodeBlocks(el, token, (t) => t === renderToken)
  })

  $effect(() => {
    onScrollElement?.(scroller ?? null)
    return () => onScrollElement?.(null)
  })

  function handleClick(e: MouseEvent): void {
    const anchor = (e.target as HTMLElement).closest('a')
    if (!anchor) return
    const href = anchor.getAttribute('href')
    e.preventDefault()
    if (!href || href.startsWith('#')) return
    if (/^https?:/i.test(href)) {
      window.api.invoke('app:open-external', href)
      return
    }
    // Relative in-repo link → open as a tab. Other schemes are inert. The
    // resolved target must stay inside the worktree so a crafted `../` link
    // can't open (and thus read) arbitrary files outside the project.
    if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('//')) {
      const path = href.split(/[#?]/)[0]
      const abs = path.startsWith('/') ? path : resolvePosix(fileDir, path)
      if (!worktreeRoot) return
      const root = worktreeRoot.replace(/\/+$/, '')
      if (abs !== root && !abs.startsWith(root + '/')) return
      onOpenFile?.(abs)
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div
  bind:this={scroller}
  data-testid="markdown-preview"
  class="h-full overflow-y-auto bg-zinc-950 px-8 py-6"
  onclick={handleClick}
>
  <div class="prose prose-invert prose-sm max-w-none">
    {@html html}
  </div>
</div>
