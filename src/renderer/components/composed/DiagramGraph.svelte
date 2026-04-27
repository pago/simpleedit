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

<div class="h-80 w-full rounded border border-zinc-800 bg-zinc-900">
  <SvelteFlow bind:nodes bind:edges fitView>
    <Background />
    <Controls />
  </SvelteFlow>
</div>
