<script lang="ts">
  import * as monaco from 'monaco-editor'
  import { untrack } from 'svelte'
  import { resolveDropPath } from '../../lib/dropped-paths'

  interface Props {
    /** Initial text; later edits flow out through `onchange` only. Remount (`{#key}`) to replace it. */
    value: string
    onchange: (value: string) => void
    label: string
    /** ⌘↵. Monaco keeps the key from reaching the page, so a host's shortcut needs this. */
    onsubmit?: () => void
    /** Take the cursor on mount. Only when the user asked for this field, never on a remount. */
    autofocus?: boolean
  }

  let { value, onchange, label, onsubmit, autofocus = false }: Props = $props()

  let container: HTMLDivElement | undefined = $state()
  let dropping = $state(false)

  $effect(() => {
    const el = container
    if (!el) return
    const editor = monaco.editor.create(el, {
      value: untrack(() => value),
      language: 'markdown',
      theme: 'vs-dark',
      automaticLayout: true,
      fontSize: 13,
      wordWrap: 'on',
      lineNumbers: 'off',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'none',
      ariaLabel: untrack(() => label),
    })
    const sub = editor.onDidChangeModelContent(() => onchange(editor.getValue()))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => onsubmit?.())
    if (untrack(() => autofocus)) editor.focus()

    // Monaco treats a drop as text. Files become their absolute paths instead —
    // plain text, never a provider's own syntax: the prompt is sent verbatim,
    // and the session launches at the project root, so a relative path would
    // point at the wrong place.
    let disposed = false
    const hasFiles = (e: DragEvent): boolean => e.dataTransfer?.types.includes('Files') ?? false
    const onDragOver = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      dropping = true
    }
    const onDragLeave = (e: DragEvent): void => {
      const next = e.relatedTarget as Node | null
      if (!next || !el.contains(next)) dropping = false
    }
    const onDrop = async (e: DragEvent): Promise<void> => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      dropping = false
      const at = editor.getTargetAtClientPoint(e.clientX, e.clientY)?.position ?? editor.getPosition()
      const paths = await Promise.all(Array.from(e.dataTransfer?.files ?? []).map(resolveDropPath))
      // The field may have been remounted or closed while the paths resolved.
      if (disposed || !paths.length || !at) return
      const range = new monaco.Range(at.lineNumber, at.column, at.lineNumber, at.column)
      editor.executeEdits('drop-files', [{ range, text: paths.join('\n'), forceMoveMarkers: true }])
      editor.focus()
    }
    el.addEventListener('dragover', onDragOver, true)
    el.addEventListener('dragleave', onDragLeave, true)
    el.addEventListener('drop', onDrop, true)
    return () => {
      disposed = true
      el.removeEventListener('dragover', onDragOver, true)
      el.removeEventListener('dragleave', onDragLeave, true)
      el.removeEventListener('drop', onDrop, true)
      sub.dispose()
      editor.getModel()?.dispose()
      editor.dispose()
    }
  })
</script>

<div class="relative h-full w-full">
  <div class="h-full w-full" bind:this={container}></div>
  {#if dropping}
    <div class="pointer-events-none absolute inset-0 rounded border-2 border-dashed border-blue-500 bg-blue-500/10"></div>
  {/if}
</div>
