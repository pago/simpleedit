<script lang="ts">
  import type { DiagramSpec } from '../../../shared/gen-ui-catalog'
  import { compileSequenceDiagram } from './mermaid-compiler'

  interface Props {
    props: DiagramSpec
  }

  let { props }: Props = $props()

  // Lazy-loaded modules — keep mermaid (~150 kB gzip + lazy chunks) and
  // @xyflow/svelte + elkjs (~750 kB gzip combined) out of the main renderer
  // bundle. Each branch only pulls in its own dependency.

  let mermaidSvg = $state<string | null>(null)
  let mermaidError = $state<string | null>(null)

  async function renderSequence(spec: Extract<DiagramSpec, { kind: 'sequence' }>): Promise<void> {
    mermaidSvg = null
    mermaidError = null
    try {
      const { default: mermaid } = await import('mermaid')
      mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })
      const id = `gen-ui-mermaid-${Math.random().toString(36).slice(2, 10)}`
      const source = compileSequenceDiagram(spec)
      const { svg } = await mermaid.render(id, source)
      mermaidSvg = svg
    } catch (err) {
      mermaidError = err instanceof Error ? err.message : String(err)
    }
  }

  type GraphSpec = Extract<DiagramSpec, { kind: 'graph' }>
  type LaidOutNode = { id: string; label: string; x: number; y: number; width: number; height: number }
  type LaidOutEdge = { id: string; source: string; target: string; label?: string }
  let graphLayout = $state<{ nodes: LaidOutNode[]; edges: LaidOutEdge[] } | null>(null)
  let graphError = $state<string | null>(null)

  async function renderGraph(spec: GraphSpec): Promise<void> {
    graphLayout = null
    graphError = null
    try {
      const { default: ELK } = await import('elkjs/lib/elk.bundled.js')
      const elk = new ELK()
      const elkInput = {
        id: 'root',
        layoutOptions: {
          'elk.algorithm': spec.layout === 'tree' ? 'mrtree' : spec.layout === 'force' ? 'force' : 'layered',
          'elk.direction': 'RIGHT',
          'elk.spacing.nodeNode': '40',
          'elk.layered.spacing.nodeNodeBetweenLayers': '60',
        },
        children: spec.nodes.map((n) => ({
          id: n.id,
          width: Math.max(120, n.label.length * 8 + 20),
          height: 40,
        })),
        edges: spec.edges.map((e, i) => ({
          id: `edge-${i}`,
          sources: [e.source],
          targets: [e.target],
        })),
      }
      const result = await elk.layout(elkInput)
      const labelById = new Map(spec.nodes.map((n) => [n.id, n.label]))
      const nodes: LaidOutNode[] = (result.children ?? []).map((c) => ({
        id: c.id,
        label: labelById.get(c.id) ?? c.id,
        x: c.x ?? 0,
        y: c.y ?? 0,
        width: c.width ?? 120,
        height: c.height ?? 40,
      }))
      const edges: LaidOutEdge[] = spec.edges.map((e, i) => ({
        id: `edge-${i}`,
        source: e.source,
        target: e.target,
        label: e.label,
      }))
      graphLayout = { nodes, edges }
    } catch (err) {
      graphError = err instanceof Error ? err.message : String(err)
    }
  }

  $effect(() => {
    if (props.kind === 'sequence') {
      renderSequence(props)
    } else if (props.kind === 'graph') {
      renderGraph(props)
    }
  })

  let GraphView = $state<typeof import('./DiagramGraph.svelte').default | null>(null)
  $effect(() => {
    if (props.kind === 'graph' && !GraphView) {
      import('./DiagramGraph.svelte').then((m) => {
        GraphView = m.default
      })
    }
  })
</script>

<div class="flex min-w-0 flex-col gap-1">
  {#if props.title}
    <div class="text-xs font-medium text-zinc-400">{props.title}</div>
  {/if}
  {#if props.kind === 'sequence'}
    {#if mermaidError}
      <div class="rounded border border-red-800/50 bg-red-950/30 p-3 text-xs text-red-300">
        Diagram render failed: {mermaidError}
      </div>
    {:else if mermaidSvg}
      <div class="rounded border border-zinc-800 bg-zinc-900 p-2">
        {@html mermaidSvg}
      </div>
    {:else}
      <div class="rounded border border-zinc-800 bg-zinc-900 p-3 text-xs text-zinc-500">
        Rendering sequence diagram…
      </div>
    {/if}
  {:else if props.kind === 'graph'}
    {#if graphError}
      <div class="rounded border border-red-800/50 bg-red-950/30 p-3 text-xs text-red-300">
        Diagram render failed: {graphError}
      </div>
    {:else if graphLayout && GraphView}
      <GraphView nodes={graphLayout.nodes} edges={graphLayout.edges} />
    {:else}
      <div class="rounded border border-zinc-800 bg-zinc-900 p-3 text-xs text-zinc-500">
        Rendering graph…
      </div>
    {/if}
  {/if}
</div>
