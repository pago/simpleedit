import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const BRIDGE_PORT = process.env.SIMPLEEDIT_BRIDGE_PORT
const BRIDGE_TOKEN = process.env.SIMPLEEDIT_BRIDGE_TOKEN
const TERMINAL_ID = process.env.SIMPLEEDIT_TERMINAL_ID

const server = new McpServer(
  { name: 'simpleedit', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

async function postToBridge(tool, args) {
  if (!BRIDGE_PORT || !BRIDGE_TOKEN || !TERMINAL_ID) {
    return {
      ok: false,
      error:
        'SimpleEdit bridge environment variables are not set. This tool must be run inside a SimpleEdit terminal.',
    }
  }

  const url = `http://127.0.0.1:${BRIDGE_PORT}/${BRIDGE_TOKEN}/tool-call`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, args, terminalId: TERMINAL_ID }),
    })

    if (!res.ok) {
      const body = await res.text()
      return { ok: false, error: `Bridge returned ${res.status}: ${body}` }
    }

    return { ok: true }
  } catch (err) {
    return { ok: false, error: `Failed to connect to SimpleEdit bridge at 127.0.0.1:${BRIDGE_PORT}: ${err.message}` }
  }
}

function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true }
}

function okResult(text) {
  return { content: [{ type: 'text', text }] }
}

server.registerTool(
  'complete_task',
  {
    description:
      'After completing any code changes, ALWAYS call this tool to create a guided review tour. ' +
      'The user reviews your work through SimpleEdit\'s Tour panel — do not just describe what you changed in terminal text. ' +
      'You have full context on *why* you made each change, so the tour you produce here is richer and cheaper than one generated later from the diff alone. ' +
      'Group segments by intent (not by file): a single topic may span multiple files, and a file may appear under multiple topics. ' +
      'Use lineRange values from the post-change version of each file. ' +
      'Pass `commitHash` only if you already committed the work — otherwise omit it and the tour will attach to the current staging changes. ' +
      'Use `openQuestions` for decisions deferred to the user or things they should watch out for; leave empty when there is nothing requiring their attention.',
    inputSchema: {
      worktreePath: z.string().describe('Absolute path to the git worktree these changes belong to'),
      commitHash: z
        .string()
        .optional()
        .describe(
          'Optional commit hash the tour describes. Omit when the work is uncommitted — the tour will attach to staging.'
        ),
      tour: z.object({
        overview: z.string().describe('2–4 sentence narrative of the entire changeset — what was done and why'),
        topics: z.array(
          z.object({
            title: z.string().describe('Short descriptive title for this logical group of changes (max 80 chars)'),
            summary: z.string().describe('Prose paragraph explaining what this group of changes does and why'),
            segments: z.array(
              z.object({
                prose: z.string().describe('Explanation of this specific code change — what it does and why it matters'),
                file: z.string().describe('File path relative to the worktree (e.g. "src/main/foo.ts")'),
                lineRange: z
                  .tuple([z.number(), z.number()])
                  .describe('[startLine, endLine] — 1-based line numbers in the post-change version'),
              })
            ).min(1).describe('Segments within this topic, each focused on one concept'),
          })
        ).min(1).describe('Ordered list of topics. Foundational changes first, then features that build on them.'),
      }).describe('The tour data to display'),
      openQuestions: z
        .array(z.string())
        .optional()
        .describe(
          'Questions for the user to answer, decisions deferred, or things to watch out for. Omit or pass [] if none.'
        ),
    },
  },
  async ({ worktreePath, commitHash, tour, openQuestions }) => {
    const result = await postToBridge('complete_task', {
      worktreePath,
      commitHash,
      tour,
      openQuestions,
    })
    if (!result.ok) return errorResult(`Error: ${result.error}`)
    return okResult(
      'Tour delivered to SimpleEdit. The user can now review your changes through the Tour panel.'
    )
  }
)

// ── show_panel: agent-composed UI ──────────────────────────────────────────

const ActionRefSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('send_to_agent'), text: z.string().min(1) }),
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
  z.object({ type: z.literal('dismiss_panel') }),
  z.object({ type: z.literal('set_state'), key: z.string().min(1), value: z.unknown() }),
])

server.registerTool(
  'show_panel',
  {
    description: [
      'Display an interactive UI panel composed from a constrained catalog of primitives.',
      'The user is working in SimpleEdit\'s IDE and reads agent output through interactive panels — never serialise the panel content as terminal text.',
      '',
      'Use this tool when:',
      '- Pausing on an ambiguous decision and asking the user to pick (compose ProseBlock + DecisionCard).',
      '- Summarising structured output like a test run (compose KeyValueSummary + FileList).',
      '- Offering several variants of code to pick from (compose CodeSnippets in a Row, each with an ActionButton).',
      '- Surfacing change-impact, semantic bookmarks, or any structured signal the user should review and act on.',
      '',
      'Catalog of primitives (12; reference each by name in spec.elements[*].type):',
      '- ProseBlock { content }: markdown narrative.',
      '- FileList { items[{path,status?,detail?,action?}], title? }: clickable file rows; status ∈ added|modified|deleted|renamed|error|ok.',
      '- CodeSnippet { language, code, annotation?, lineNumbers?, maxLines? }: read-only code with optional commentary.',
      '- DecisionCard { question, context?, options[{label,variant?,action}] }: 2–5 options, each option dispatches an action.',
      '- StatusIndicator { kind, label, detail? }: kind ∈ running|ok|warn|error|pending.',
      '- KeyValueSummary { items[{label,value,status?}] }: label→value pairs.',
      '- Section { title, defaultOpen? } [children]: collapsible group; children belong via spec.elements[id].children.',
      '- ActionButton { label, variant?, action }: standalone action button.',
      '- TextInput { bind, placeholder?, submitAction? }: bind = JSON Pointer state path.',
      '- Textarea: same shape as TextInput, multi-line.',
      '- Callout { variant, title?, body }: variant ∈ info|warn|error|success.',
      '- Row { gap?, wrap? } [children]: horizontal flex; default flow is vertical.',
      '- Diagram { kind: "graph"|"sequence", ... }: discriminated.',
      '    graph    { nodes:[{id,label,kind?}], edges:[{source,target,label?}], layout?: "layered"|"force"|"tree" }',
      '             — every edge.source and edge.target must reference an id present in nodes.',
      '    sequence { actors:[{id,label}], messages:[{from,to,label,kind?:"sync"|"async"|"return"}] }',
      '             — every message.from and message.to must reference an id present in actors.',
      '',
      'Action set (referenced inside DecisionCard.options[].action, ActionButton.action, FileList.items[].action, TextInput/Textarea.submitAction):',
      '- { type: "send_to_agent", text }: sends text to your terminal as if the user typed it. Rate-limited.',
      '- { type: "open_file", path, line? }: opens a file tab; path is validated against the active worktree.',
      '- { type: "show_diff", commitHash, file? }: opens a diff tab; commit must be reachable.',
      '- { type: "dismiss_panel" }: closes this panel.',
      '- { type: "set_state", key, value }: mutates the panel\'s local $bindState scope.',
      '',
      'Spec format — flat tree:',
      '  spec = { root: "elementId", elements: { elementId: { type, props, children?, visible? } } }',
      'children is an array of element ids that point into the same elements map. Use this for Section/Row contents.',
      '',
      'Example — checkpoint:',
      '  {',
      '    "title": "Approach?",',
      '    "spec": {',
      '      "root": "card",',
      '      "elements": {',
      '        "ctx": { "type": "ProseBlock", "props": { "content": "Two ways to handle the cache invalidation…" } },',
      '        "card": { "type": "DecisionCard", "props": {',
      '          "question": "Which approach?",',
      '          "options": [',
      '            { "label": "Refresh on write", "variant": "primary", "action": { "type": "send_to_agent", "text": "use refresh-on-write" } },',
      '            { "label": "TTL-based", "action": { "type": "send_to_agent", "text": "use TTL" } }',
      '          ]',
      '        }, "children": ["ctx"] }',
      '      }',
      '    }',
      '  }',
      '',
      'Example — passive test summary:',
      '  spec.elements = {',
      '    "root": { "type": "Section", "props": { "title": "Test run" }, "children": ["counts", "files"] },',
      '    "counts": { "type": "KeyValueSummary", "props": { "items": [',
      '      {"label":"Passed","value":"42","status":"ok"},',
      '      {"label":"Failed","value":"3","status":"error"}',
      '    ] } },',
      '    "files": { "type": "FileList", "props": { "title": "Failures", "items": [',
      '      {"path":"src/foo.test.ts","status":"error","detail":"timeout"}',
      '    ] } }',
      '  }, root: "root"',
      '',
      'Example — architecture diagram:',
      '  spec.elements = {',
      '    "root": { "type": "Diagram", "props": {',
      '      "kind": "graph",',
      '      "nodes": [{"id":"client","label":"Web"},{"id":"api","label":"API"},{"id":"db","label":"Database"}],',
      '      "edges": [{"source":"client","target":"api"},{"source":"api","target":"db"}],',
      '      "layout": "layered"',
      '    } }',
      '  }, root: "root"',
      '',
      'After dispatching the panel, the user\'s reaction returns through your terminal as plain text (when an action sends_to_agent) — read it and continue.',
    ].join('\n'),
    inputSchema: {
      worktreePath: z.string().describe('Absolute path to the git worktree this panel applies to'),
      title: z.string().optional().describe('Tab title shown in SimpleEdit. Defaults to "Agent panel".'),
      spec: z
        .object({
          root: z.string(),
          elements: z.record(
            z.string(),
            z.object({
              type: z.string(),
              props: z.record(z.string(), z.unknown()).optional(),
              children: z.array(z.string()).optional(),
              visible: z.unknown().optional(),
            }),
          ),
        })
        .describe(
          'Flat-tree spec. spec.root is the entry element id; spec.elements maps every element id to {type, props, children?}. ' +
            'Per-element props are validated against the catalog schema main-side; invalid specs are returned to you with a list of issues so you can self-correct.',
        ),
      _actionRefShape: ActionRefSchema.optional().describe(
        'Reference for the ActionRef shape used inside element props (FYI; not a parameter). Type-discriminated by `type`.',
      ),
    },
  },
  async ({ worktreePath, title, spec }) => {
    const result = await postToBridge('show_panel', { worktreePath, title, spec })
    if (!result.ok) return errorResult(`Error: ${result.error}`)
    return okResult(
      'Panel displayed in SimpleEdit. Wait for the user\'s response — interactive actions will arrive in your terminal.',
    )
  },
)

// ── open_worktree: repoint the session's workspace ─────────────────────────

server.registerTool(
  'open_worktree',
  {
    description:
      'Point the user\'s SimpleEdit workspace (file tree, git log, diff targets) at a git worktree. ' +
      'Use this when you start working in — or want the user to look at — a specific worktree, ' +
      'so the UI follows you there instead of staying on whatever was last open. ' +
      'Identify the worktree by its absolute path OR its branch name (provide one). ' +
      'The target is validated against the repo\'s actual worktree list; an invalid target returns the available worktrees so you can retry.',
    inputSchema: {
      worktreePath: z
        .string()
        .optional()
        .describe('Absolute path to the worktree to open. Provide this or `branch`.'),
      branch: z
        .string()
        .optional()
        .describe('Branch name of the worktree to open. Provide this or `worktreePath`.'),
    },
  },
  async ({ worktreePath, branch }) => {
    const result = await postToBridge('open_worktree', { worktreePath, branch })
    if (!result.ok) return errorResult(`Error: ${result.error}`)
    return okResult('Workspace repointed in SimpleEdit.')
  },
)

// ── show_diff: open a diff tab in the session's workspace ───────────────────

server.registerTool(
  'show_diff',
  {
    description:
      'Open a diff in the user\'s SimpleEdit workspace so they can review changes interactively — ' +
      'do not paste diffs as terminal text. ' +
      'Use after making or committing changes, or whenever you want the user to look at a specific diff. ' +
      'commitHash selects what to diff: omit it (or "staging") for uncommitted/working-tree changes, ' +
      '"branch" for everything this branch added vs. its base, or a commit SHA for that commit. ' +
      'worktreePath defaults to the session\'s current workspace worktree.',
    inputSchema: {
      commitHash: z
        .string()
        .optional()
        .describe('"staging" or omit = uncommitted changes; "branch" = branch vs. base; otherwise a commit SHA.'),
      worktreePath: z
        .string()
        .optional()
        .describe('Absolute path to the worktree to diff. Defaults to the session\'s current workspace worktree.'),
    },
  },
  async ({ commitHash, worktreePath }) => {
    const result = await postToBridge('show_diff', { commitHash, worktreePath })
    if (!result.ok) return errorResult(`Error: ${result.error}`)
    return okResult('Diff opened in SimpleEdit. The user can now review the changes.')
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
