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
    /**
     * Worktree the path is relative to / validated against. Optional: when
     * absent the panel-level worktree is used. A tour legitimately spans
     * repos, so an action can name its own scope — but it must be a worktree
     * the window has registered.
     */
    worktree: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('show_diff'),
    commitHash: z.string().min(1),
    file: z.string().optional(),
    /** Worktree the commit must be reachable in. See `open_file.worktree`. */
    worktree: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('dismiss_panel'),
  }),
  z.object({
    type: z.literal('set_state'),
    key: z.string().min(1),
    value: z.unknown(),
  }),
  z.object({
    type: z.literal('focus_block'),
    /**
     * Key of another element in the same `spec.elements`. The only
     * panel-local action: it never crosses the MCP bridge or the IPC
     * boundary, it just moves the reader inside the panel they are already
     * looking at. Validated against the elements map, so a dead link is a
     * spec error rather than a click that does nothing.
     */
    blockId: z.string().min(1),
  }),
])
export type ActionRef = z.infer<typeof ActionRefSchema>

// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------

const FileListItemSchema = z.object({
  path: z.string().min(1),
  status: z.enum(['added', 'modified', 'deleted', 'renamed', 'error', 'ok']).optional(),
  /**
   * Why this file is in the list. Rendered below the path and wrapped in full,
   * so a sentence-length clause survives — it is not a truncated chip.
   */
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

/**
 * A diff shown inline in a panel. It carries the diff *content*, not a repo
 * reference: the agent already holds the text (`git diff` / `gh pr diff`), so
 * the block renders with zero repo access and works for PRs that were never
 * checked out.
 */
export const DiffBlockProps = z.object({
  /** Unified diff text (`diff --git` blocks, as `git diff`/`gh pr diff` emit). */
  diff: z.string().min(1),
  title: z.string().optional(),
  /**
   * Highlighting language for every file in the diff, overriding the
   * per-extension guess. Exists for embedded DSLs — a shell script inside a
   * `.ts` template literal is not TypeScript.
   */
  language: z.string().optional(),
  /**
   * Optional "jump to the file in context" links, matched to a diff file by
   * its path. Each carries its own ActionRef, so a link can name a worktree.
   */
  fileActions: z
    .array(
      z.object({
        path: z.string().min(1),
        label: z.string().optional(),
        action: ActionRefSchema,
      }),
    )
    .optional(),
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
    /** Heading drawn above the diagram, so naming one costs no extra block. */
    title: z.string().optional(),
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
    /** Heading drawn above the diagram. See `GraphDiagramSchema.title`. */
    title: z.string().optional(),
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
        'Clickable list of files with optional status chips and a wrapping `detail` clause per row. ' +
        'Use for tour topics, test results, change-impact views, handoff state.',
    },
    CodeSnippet: {
      props: CodeSnippetProps,
      slots: [],
      description:
        'Syntax-highlighted, read-only code block with an optional annotation. Use for inline references, variant previews, or excerpts. Use DiffBlock for before/after.',
    },
    DiffBlock: {
      props: DiffBlockProps,
      slots: [],
      description:
        'Unified diff rendered inline, expanded, with per-line +/- gutters. You supply the diff TEXT ' +
        '(from `git diff` or `gh pr diff`) — the block needs no repo access, so it works for changes that ' +
        'are not checked out. Use it for code tours and change walkthroughs. Optional `language` overrides ' +
        'per-extension highlighting; optional `fileActions` add a jump-to-file link per diff file.',
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
        'Highlighted info/warn/error/success banner with optional title. The body is markdown, so a callout ' +
        'can carry several paragraphs or a list. Use for warnings or out-of-flow emphasis.',
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
        'Architecture / flowchart / sequence diagram, with an optional `title` heading. Discriminated by kind: ' +
        '"graph" {nodes,edges,layout?} renders via Svelte Flow + ELK; ' +
        '"sequence" {actors,messages} renders via mermaid (compiled from your typed JSON — you never write mermaid DSL).',
    },
  },
  actions: {
    send_to_agent: {
      params: z.object({ text: z.string() }),
      description:
        "Write text + '\\r' to the source terminal's PTY. Rate-limited.",
    },
    open_file: {
      params: z.object({
        path: z.string(),
        line: z.number().int().positive().optional(),
        worktree: z.string().optional(),
      }),
      description:
        'Open a file tab in the active pane. Path is validated against `worktree` when given ' +
        '(which must be a worktree this window knows), otherwise against the panel-level worktree.',
    },
    show_diff: {
      params: z.object({
        commitHash: z.string(),
        file: z.string().optional(),
        worktree: z.string().optional(),
      }),
      description:
        'Open or focus a diff tab. Commit hash is validated as reachable in `worktree` when given, ' +
        'otherwise in the panel-level worktree.',
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
    focus_block: {
      params: z.object({
        blockId: z.string(),
      }),
      description:
        'Scroll another block of this same panel into view and flash it, expanding any collapsed ' +
        'Section it sits in. Resolved entirely inside the rendered panel — no file system, no repo.',
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
