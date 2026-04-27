/**
 * Generative UI catalog for #62.
 *
 * This file is the contract between the LLM (which emits a `Spec`) and the
 * renderer (which validates + draws it). It's imported by both the main
 * process (for spec validation before IPC) and the renderer (for component
 * binding via @json-render/svelte's `defineRegistry`).
 *
 * Phase 1 ships 12 primitive components. The 13th, `Diagram`, is reserved as
 * a slot here so Phase 3 can plug it in without schema migration.
 *
 * Action handlers are NOT implemented in Phase 1 — only their shapes. Phase 2
 * registers the actual handlers in the renderer's ActionProvider.
 */

import { defineCatalog } from '@json-render/core'
import { schema } from '@json-render/svelte/schema'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Action references (what an option/button/input dispatches)
// ---------------------------------------------------------------------------

/**
 * Enumerated capability set the LLM can invoke from a composed panel.
 * No free-form shell. Adding an action requires a code change.
 */
export const ActionRefSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('send_to_agent'),
    text: z.string().min(1),
  }),
  z.object({
    type: z.literal('open_file'),
    path: z.string().min(1),
    line: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('show_diff'),
    commitHash: z.string().min(1),
    file: z.string().optional(),
  }),
  z.object({
    type: z.literal('dismiss_panel'),
  }),
  z.object({
    type: z.literal('set_state'),
    key: z.string().min(1),
    value: z.unknown(),
  }),
])
export type ActionRef = z.infer<typeof ActionRefSchema>

// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------

const FileListItemSchema = z.object({
  path: z.string().min(1),
  status: z.enum(['added', 'modified', 'deleted', 'renamed', 'error', 'ok']).optional(),
  detail: z.string().optional(),
  action: ActionRefSchema.optional(),
})

const KeyValueItemSchema = z.object({
  label: z.string(),
  value: z.string(),
  status: z.enum(['ok', 'warn', 'error']).optional(),
})

const DecisionOptionSchema = z.object({
  label: z.string().min(1),
  variant: z.enum(['primary', 'danger', 'default']).optional(),
  action: ActionRefSchema,
})

// ---------------------------------------------------------------------------
// Per-primitive prop schemas
// ---------------------------------------------------------------------------

export const ProseBlockProps = z.object({
  content: z.string(),
})

export const FileListProps = z.object({
  title: z.string().optional(),
  items: z.array(FileListItemSchema).min(1),
})

export const CodeSnippetProps = z.object({
  language: z.string(),
  code: z.string(),
  annotation: z.string().optional(),
  lineNumbers: z.boolean().optional(),
  maxLines: z.number().int().positive().optional(),
})

export const DecisionCardProps = z.object({
  question: z.string().min(1),
  context: z.string().optional(),
  options: z.array(DecisionOptionSchema).min(2).max(5),
})

export const StatusIndicatorProps = z.object({
  kind: z.enum(['running', 'ok', 'warn', 'error', 'pending']),
  label: z.string(),
  detail: z.string().optional(),
})

export const KeyValueSummaryProps = z.object({
  items: z.array(KeyValueItemSchema).min(1),
})

export const SectionProps = z.object({
  title: z.string(),
  defaultOpen: z.boolean().optional(),
})

export const ActionButtonProps = z.object({
  label: z.string().min(1),
  variant: z.enum(['primary', 'secondary', 'danger', 'ghost']).optional(),
  action: ActionRefSchema,
})

export const TextInputProps = z.object({
  /** State path (JSON Pointer) the input is bound to via `$bindState`. */
  bind: z.string(),
  placeholder: z.string().optional(),
  submitAction: ActionRefSchema.optional(),
})

export const TextareaProps = TextInputProps

export const CalloutProps = z.object({
  variant: z.enum(['info', 'warn', 'error', 'success']),
  title: z.string().optional(),
  body: z.string(),
})

export const RowProps = z.object({
  gap: z.enum(['sm', 'md', 'lg']).optional(),
  wrap: z.boolean().optional(),
})

/**
 * Diagram primitive — discriminated by `kind`:
 *
 *  - `graph`    rendered via @xyflow/svelte + elkjs. The agent emits typed
 *               nodes + edges; ELK assigns positions; Svelte Flow draws.
 *  - `sequence` compiled by our code into mermaid sequence-diagram source
 *               and rendered via mermaid. The agent never emits mermaid DSL.
 *
 * Both branches lazy-load their backing renderer, so panels that don't
 * include a Diagram pay nothing for it.
 */
const GraphNodeSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  kind: z.string().optional(),
})

const GraphEdgeSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  label: z.string().optional(),
})

const GraphDiagramSchema = z
  .object({
    kind: z.literal('graph'),
    nodes: z.array(GraphNodeSchema).min(1),
    edges: z.array(GraphEdgeSchema),
    layout: z.enum(['layered', 'force', 'tree']).optional(),
  })
  .superRefine((value, ctx) => {
    const ids = new Set(value.nodes.map((n) => n.id))
    value.edges.forEach((e, idx) => {
      if (!ids.has(e.source)) {
        ctx.addIssue({
          code: 'custom',
          path: ['edges', idx, 'source'],
          message: `edge source "${e.source}" does not match any node id`,
        })
      }
      if (!ids.has(e.target)) {
        ctx.addIssue({
          code: 'custom',
          path: ['edges', idx, 'target'],
          message: `edge target "${e.target}" does not match any node id`,
        })
      }
    })
  })

const SequenceActorSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
})

const SequenceMessageSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string(),
  kind: z.enum(['sync', 'async', 'return']).optional(),
})

const SequenceDiagramSchema = z
  .object({
    kind: z.literal('sequence'),
    actors: z.array(SequenceActorSchema).min(1),
    messages: z.array(SequenceMessageSchema).min(1),
  })
  .superRefine((value, ctx) => {
    const ids = new Set(value.actors.map((a) => a.id))
    value.messages.forEach((m, idx) => {
      if (!ids.has(m.from)) {
        ctx.addIssue({
          code: 'custom',
          path: ['messages', idx, 'from'],
          message: `message from "${m.from}" does not match any actor id`,
        })
      }
      if (!ids.has(m.to)) {
        ctx.addIssue({
          code: 'custom',
          path: ['messages', idx, 'to'],
          message: `message to "${m.to}" does not match any actor id`,
        })
      }
    })
  })

export const DiagramProps = z.discriminatedUnion('kind', [GraphDiagramSchema, SequenceDiagramSchema])
export type DiagramSpec = z.infer<typeof DiagramProps>

// ---------------------------------------------------------------------------
// Catalog definition
// ---------------------------------------------------------------------------

export const catalog = defineCatalog(schema, {
  components: {
    ProseBlock: {
      props: ProseBlockProps,
      slots: [],
      description:
        'Markdown prose. Use for narrative context, explanations, summaries. Renders headings, lists, code spans, links.',
    },
    FileList: {
      props: FileListProps,
      slots: [],
      description:
        'Clickable list of files with optional status chips. Use for tour topics, test results, change-impact views, handoff state.',
    },
    CodeSnippet: {
      props: CodeSnippetProps,
      slots: [],
      description:
        'Syntax-highlighted, read-only code block with an optional annotation. Use for inline references, variant previews, or excerpts. Use DiffView for before/after.',
    },
    DecisionCard: {
      props: DecisionCardProps,
      slots: [],
      description:
        'Question + 2–5 options. Each option dispatches an action. Use for structured checkpoints and approval gates.',
    },
    StatusIndicator: {
      props: StatusIndicatorProps,
      slots: [],
      description:
        'Inline status badge with a label. Use for task progress, pass/fail, and small state indicators.',
    },
    KeyValueSummary: {
      props: KeyValueSummaryProps,
      slots: [],
      description:
        'Label → value pairs with optional status coloring. Use for test counts, handoff state, impact stats.',
    },
    Section: {
      props: SectionProps,
      slots: ['default'],
      description:
        'Titled, collapsible container. Use for grouping related primitives under a heading.',
    },
    ActionButton: {
      props: ActionButtonProps,
      slots: [],
      description:
        'Standalone button that dispatches an action. Use for resume, approve, reject, send-feedback, open-file.',
    },
    TextInput: {
      props: TextInputProps,
      slots: [],
      description:
        'Single-line text input bound to a state path via $bindState. Optional submitAction fires on Enter.',
    },
    Textarea: {
      props: TextareaProps,
      slots: [],
      description:
        'Multi-line text input bound to a state path via $bindState. Use for free-form feedback, checkpoint escape hatch.',
    },
    Callout: {
      props: CalloutProps,
      slots: [],
      description:
        'Highlighted info/warn/error/success banner with optional title. Use for warnings or out-of-flow emphasis.',
    },
    Row: {
      props: RowProps,
      slots: ['default'],
      description:
        'Horizontal flex container. Default container flow is vertical; Row is the only horizontal escape hatch. Children render in a row with a configurable gap; optional wrap.',
    },
    Diagram: {
      props: DiagramProps,
      slots: [],
      description:
        'Architecture / flowchart / sequence diagram. Discriminated by kind: ' +
        '"graph" {nodes,edges,layout?} renders via Svelte Flow + ELK; ' +
        '"sequence" {actors,messages} renders via mermaid (compiled from your typed JSON — you never write mermaid DSL).',
    },
  },
  actions: {
    send_to_agent: {
      params: z.object({ text: z.string() }),
      description:
        "Write text + '\\r' to the source terminal's PTY. Generalizes plan-feedback. Rate-limited.",
    },
    open_file: {
      params: z.object({
        path: z.string(),
        line: z.number().int().positive().optional(),
      }),
      description: 'Open a file tab in the active pane. Path is validated against the active worktree.',
    },
    show_diff: {
      params: z.object({
        commitHash: z.string(),
        file: z.string().optional(),
      }),
      description: 'Open or focus a diff tab. Commit hash is validated as reachable.',
    },
    dismiss_panel: {
      params: z.object({}),
      description: 'Close this composed panel.',
    },
    set_state: {
      params: z.object({
        key: z.string(),
        value: z.unknown(),
      }),
      description: 'Mutate the panel local $bindState scope. Local-only; cannot escape the panel.',
    },
  },
})

// ---------------------------------------------------------------------------
// Inferred types for downstream code
// ---------------------------------------------------------------------------

export type Catalog = typeof catalog

/**
 * The validated spec shape — flat tree of `{ root, elements }` per
 * @json-render/svelte's schema. Importable by main process for IPC payload
 * typing and renderer for tab payloads.
 */
export type Spec = {
  root: string
  elements: Record<
    string,
    {
      type: string
      props: Record<string, unknown>
      children?: string[]
      visible?: unknown
    }
  >
}
