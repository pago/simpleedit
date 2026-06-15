<script lang="ts" module>
  import type { Tab } from '../../stores/tabsStore.svelte'
  import { isMarkdownPath } from '../../lib/markdown'

  /** Whether a tab contributes any right-side actions. Keeps PaneTabBar's
   *  action-region gating in sync with what this component renders. */
  export function tabHasActions(tab: Tab | null): boolean {
    return !!tab && tab.kind === 'file' && isMarkdownPath(tab.path)
  }
</script>

<script lang="ts">
  import { markdownViewStore } from '../../stores/markdownView.svelte'
  import ViewModeToggle from './ViewModeToggle.svelte'

  interface Props {
    tab: Tab | null
  }

  let { tab }: Props = $props()
</script>

{#if tab && tab.kind === 'file' && isMarkdownPath(tab.path)}
  {@const path = tab.path}
  <ViewModeToggle
    current={markdownViewStore.get(path)}
    onsetmode={(mode) => markdownViewStore.set(path, mode)}
  />
{/if}
