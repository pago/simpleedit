<script lang="ts">
  import { SvelteFlow, Background, Controls, type Node, type Edge } from '@xyflow/svelte'
  import '@xyflow/svelte/dist/style.css'

  interface Props {
    nodes: { id: string; label: string; x: number; y: number; width: number; height: number }[]
    edges: { id: string; source: string; target: string; label?: string }[]
  }

  let { nodes: nodesIn, edges: edgesIn }: Props = $props()

  let nodes = $state<Node[]>([])
  let edges = $state<Edge[]>([])

  $effect(() => {
    nodes = nodesIn.map((n) => ({
      id: n.id,
      type: 'default',
      position: { x: n.x, y: n.y },
      data: { label: n.label },
      width: n.width,
      height: n.height,
    }))
    edges = edgesIn.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
    }))
  })
</script>

<div class="diagram-graph h-80 w-full rounded border border-zinc-800 bg-zinc-900">
  <SvelteFlow bind:nodes bind:edges fitView>
    <Background />
    <Controls />
  </SvelteFlow>
</div>

<style>
  /* Match SimpleEdit's zinc-on-zinc dark theme — xyflow ships light defaults
   * (white nodes with no explicit text color) which inherit from our dark
   * surrounding text and end up gray-on-white. Override the documented CSS
   * variables to opt into dark theme styling. */
  .diagram-graph :global(.svelte-flow) {
    --xy-background-color: #18181b;            /* zinc-900 */
    --xy-background-pattern-color: #3f3f46;    /* zinc-700 */

    --xy-node-background-color-default: #27272a; /* zinc-800 */
    --xy-node-color-default: #fafafa;            /* zinc-50  */
    --xy-node-border-default: 1px solid #52525b; /* zinc-600 */
    --xy-node-boxshadow-default:
      0 1px 2px rgb(0 0 0 / 0.3),
      0 0 0 1px rgb(82 82 91 / 0.4);

    --xy-edge-stroke-default: #71717a;            /* zinc-500 */
    --xy-edge-stroke-selected-default: #60a5fa;   /* blue-400 */
    --xy-edge-label-color-default: #d4d4d8;       /* zinc-300 */
    --xy-edge-label-background-color-default: #27272a;

    --xy-handle-background-color-default: #71717a;
    --xy-handle-border-color-default: #18181b;

    --xy-controls-button-background-color-default: #27272a;
    --xy-controls-button-background-color-hover-default: #3f3f46;
    --xy-controls-button-color-default: #fafafa;
    --xy-controls-button-border-color-default: #52525b;
  }
</style>
