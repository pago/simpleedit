<script lang="ts">
  import * as monaco from 'monaco-editor'
  import { untrack } from 'svelte'

  interface Props {
    /** Initial text; later edits flow out through `onchange` only. */
    value: string
    onchange: (value: string) => void
    label: string
  }

  let { value, onchange, label }: Props = $props()

  let container: HTMLDivElement | undefined = $state()

  $effect(() => {
    if (!container) return
    const editor = monaco.editor.create(container, {
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
    return () => {
      sub.dispose()
      editor.getModel()?.dispose()
      editor.dispose()
    }
  })
</script>

<div class="h-full w-full" bind:this={container}></div>
