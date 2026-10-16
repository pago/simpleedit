<script lang="ts">
  import { untrack } from 'svelte'
  import { SvelteFlow, Background, Controls, type Node, type Edge, type NodeTypes } from '@xyflow/svelte'
  import '@xyflow/svelte/dist/style.css'
  import TaskNode from './TaskNode.svelte'
  import type { TaskCard } from '../../lib/workflow-view'

  interface Props {
    cards: TaskCard[]
    /** Each task's `after`: an edge from every dependency to the task. */
    after: Record<string, string[]>
    onselect: (taskId: string) => void
  }

  let { cards, after, onselect }: Props = $props()

  const WIDTH = 220
  const HEIGHT = 84
  const nodeTypes: NodeTypes = { task: TaskNode }

  let nodes = $state<Node[]>([])
  let edges = $state<Edge[]>([])
  let layoutError = $state<string | null>(null)
  /** Positions only change with the graph's shape, so a status change never re-runs the layout. */
  let positions = $state<Map<string, { x: number; y: number }>>(new Map())
  let shapeKey = $derived(cards.map((c) => `${c.id}:${c.depth}:${(after[c.id] ?? []).join(',')}`).join('|'))

  $effect(() => {
    const key = shapeKey
    const { input, links } = untrack(() => ({
      input: cards.map((c) => ({ id: c.id, depth: c.depth })),
      links: cards.flatMap((c) => (after[c.id] ?? []).filter((d) => cards.some((x) => x.id === d)).map((d) => ({ from: d, to: c.id }))),
    }))
    let stale = false
    void (async () => {
      try {
        const { default: ELK } = await import('elkjs/lib/elk.bundled.js')
        const graph = await new ELK().layout({
          id: 'root',
          layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': 'RIGHT',
            // Columns are dependency depth, exactly as the store computes it.
            'elk.partitioning.activate': 'true',
            'elk.spacing.nodeNode': '24',
            'elk.layered.spacing.nodeNodeBetweenLayers': '56',
          },
          children: input.map((n) => ({
            id: n.id,
            width: WIDTH,
            height: HEIGHT,
            layoutOptions: { 'elk.partitioning.partition': String(n.depth) },
          })),
          edges: links.map((l) => ({ id: `${l.from}->${l.to}`, sources: [l.from], targets: [l.to] })),
        })
        if (stale || key !== shapeKey) return
        positions = new Map((graph.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]))
        layoutError = null
      } catch (error) {
        layoutError = error instanceof Error ? error.message : String(error)
        positions = new Map(input.map((n, i) => [n.id, { x: n.depth * (WIDTH + 56), y: i * (HEIGHT + 24) }]))
      }
    })()
    return () => {
      stale = true
    }
  })

  $effect(() => {
    nodes = cards.map((card) => ({
      id: card.id,
      type: 'task',
      position: positions.get(card.id) ?? { x: card.depth * (WIDTH + 56), y: 0 },
      data: { card, onselect },
      width: WIDTH,
      height: HEIGHT,
      draggable: false,
      connectable: false,
    }))
    edges = cards.flatMap((card) =>
      (after[card.id] ?? [])
        .filter((dep) => cards.some((c) => c.id === dep))
        .map((dep) => ({
          id: `${dep}->${card.id}`,
          source: dep,
          target: card.id,
          animated: card.tone === 'running',
        })),
    )
  })
</script>

<div class="workflow-graph h-full min-h-64 w-full" data-testid="workflow-graph">
  {#if positions.size > 0 || cards.length === 0}
    <SvelteFlow
      bind:nodes
      bind:edges
      {nodeTypes}
      fitView
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      nodesFocusable={false}
      edgesFocusable={false}
      proOptions={{ hideAttribution: true }}
    >
      <Background />
      <Controls showLock={false} />
    </SvelteFlow>
  {/if}
  {#if layoutError}
    <p class="px-2 text-[11px] text-zinc-500">Layout fell back to a plain grid: {layoutError}</p>
  {/if}
</div>

<style>
  .workflow-graph :global(.svelte-flow) {
    --xy-background-color: #18181b;
    --xy-background-pattern-color: #3f3f46;
    --xy-node-background-color-default: transparent;
    --xy-node-border-default: none;
    --xy-node-boxshadow-default: none;
    --xy-edge-stroke-default: #71717a;
    --xy-handle-background-color-default: #52525b;
    --xy-handle-border-color-default: #18181b;
    --xy-controls-button-background-color-default: #27272a;
    --xy-controls-button-background-color-hover-default: #3f3f46;
    --xy-controls-button-color-default: #fafafa;
    --xy-controls-button-border-color-default: #52525b;
  }
  .workflow-graph :global(.svelte-flow__node) {
    padding: 0;
  }
</style>
