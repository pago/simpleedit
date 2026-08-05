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

    // The messaging tools need the bridge's payload (peer lists, replies), not
    // just success — the older tools simply ignore `data`.
    const text = await res.text()
    let data = {}
    if (text.trim()) {
      try {
        data = JSON.parse(text)
      } catch {
        /* non-JSON body: treat as a bare success */
      }
    }
    return { ok: true, data }
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
    worktree: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('show_diff'),
    commitHash: z.string().min(1),
    file: z.string().optional(),
    worktree: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal('dismiss_panel') }),
  z.object({ type: z.literal('set_state'), key: z.string().min(1), value: z.unknown() }),
  z.object({ type: z.literal('focus_block'), blockId: z.string().min(1) }),
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
      '- Walking the user through a change as a code tour (compose ProseBlock + DiffBlock per step).',
      '- Surfacing change-impact, semantic bookmarks, or any structured signal the user should review and act on.',
      '',
      'Catalog of primitives (14; reference each by name in spec.elements[*].type):',
      '- ProseBlock { content }: markdown narrative.',
      '- FileList { items[{path,status?,detail?,action?}], title? }: clickable file rows; status ∈ added|modified|deleted|renamed|error|ok.',
      '    detail?     = plain-text clause saying WHY the file is in the list. It wraps below the path in full,',
      '                  so write a sentence ("carries the retry budget now") rather than a two-word chip.',
      '- CodeSnippet { language, code, annotation?, lineNumbers?, maxLines? }: read-only code with optional commentary.',
      '- DiffBlock { diff, title?, language?, fileActions? }: a unified diff, rendered expanded with +/- gutters.',
      '    diff        = the diff TEXT you already have from `git diff` / `gh pr diff` (full `diff --git` blocks).',
      '                  It carries content, not a repo reference — so it works for changes that are NOT checked out.',
      '    language?   = override highlighting for every file (use it when the extension lies, e.g. a shell script',
      '                  embedded in a .ts template literal).',
      '    fileActions? = [{ path, label?, action }] — adds a jump-to-file link on the matching file\'s header.',
      '                  Prefer this over describing paths in prose.',
      '- DecisionCard { question, context?, options[{label,variant?,action}] }: 2–5 options, each option dispatches an action.',
      '- StatusIndicator { kind, label, detail? }: kind ∈ running|ok|warn|error|pending.',
      '- KeyValueSummary { items[{label,value,status?}] }: label→value pairs.',
      '- Section { title, defaultOpen? } [children]: collapsible group; children belong via spec.elements[id].children.',
      '- ActionButton { label, variant?, action }: standalone action button.',
      '- TextInput { bind, placeholder?, submitAction? }: bind = JSON Pointer state path.',
      '- Textarea: same shape as TextInput, multi-line.',
      '- Callout { variant, title?, body }: variant ∈ info|warn|error|success.',
      '    body        = MARKDOWN, rendered like ProseBlock — paragraphs, lists and code spans all survive.',
      '                  You do not have to compress a callout down to one sentence.',
      '- Row { gap?, wrap? } [children]: horizontal flex; default flow is vertical.',
      '- Diagram { kind: "graph"|"sequence", title?, ... }: discriminated.',
      '    title?   = heading drawn on the diagram itself. Use it instead of stacking a ProseBlock above',
      '               a Diagram purely to name it — one block, one idea.',
      '    graph    { nodes:[{id,label,kind?}], edges:[{source,target,label?}], layout?: "layered"|"force"|"tree" }',
      '             — every edge.source and edge.target must reference an id present in nodes.',
      '    sequence { actors:[{id,label}], messages:[{from,to,label,kind?:"sync"|"async"|"return"}] }',
      '             — every message.from and message.to must reference an id present in actors.',
      '',
      'Action set (referenced inside DecisionCard.options[].action, ActionButton.action, FileList.items[].action, TextInput/Textarea.submitAction):',
      '- { type: "send_to_agent", text }: sends text to your terminal as if the user typed it. Rate-limited.',
      '- { type: "open_file", path, line?, worktree? }: opens a file tab.',
      '- { type: "show_diff", commitHash, file?, worktree? }: opens a diff tab; commit must be reachable.',
      '  `worktree?` on either action scopes it to another worktree, so ONE panel can tour several repos.',
      '  It must be a worktree SimpleEdit knows (any repo you have read a file in counts). When omitted, the',
      '  panel-level worktreePath is used. Prefer explicit { worktree, path: <relative> } over a bare absolute',
      '  path — the error message tells you what went wrong when the worktree is unknown.',
      '- { type: "dismiss_panel" }: closes this panel.',
      '- { type: "set_state", key, value }: mutates the panel\'s local $bindState scope.',
      '- { type: "focus_block", blockId }: scrolls to another block OF THIS SAME PANEL and flashes it,',
      '  expanding any collapsed Section on the way. blockId is a key of spec.elements — an unknown one is',
      '  rejected as a dead link. This is the only panel-local action: it needs no repo and no checkout, and',
      '  it keeps the reader inside the panel. Use it for a "Read in this order" FileList at the top of a tour,',
      '  where each row jumps to that file\'s DiffBlock — prefer it over open_file/show_diff for intra-tour',
      '  navigation, and keep open_file for actually editing the file.',
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
      'Example — code tour (diff content, no repo access needed; the index jumps within the panel):',
      '  {',
      '    "title": "Tour: retry handling",',
      '    "panelId": "tour-retry",',
      '    "spec": {',
      '      "root": "root",',
      '      "elements": {',
      '        "root": { "type": "Section", "props": { "title": "Retry handling" }, "children": ["index", "step1"] },',
      '        "index": { "type": "FileList", "props": { "title": "Read in this order", "items": [',
      '          { "path": "src/client.ts", "status": "modified",',
      '            "detail": "Owns the backoff now, so start here — everything else is a consequence.",',
      '            "action": { "type": "focus_block", "blockId": "diff" } }',
      '        ] } },',
      '        "step1": { "type": "Section", "props": { "title": "1. The retry loop moved into the client" }, "children": ["why", "diff"] },',
      '        "why": { "type": "ProseBlock", "props": { "content": "Callers used to own the backoff. Now the client does." } },',
      '        "diff": { "type": "DiffBlock", "props": {',
      '          "diff": "diff --git a/src/client.ts b/src/client.ts\\n@@ -1,3 +1,5 @@\\n context\\n+added line\\n",',
      '          "fileActions": [{ "path": "src/client.ts", "action": { "type": "open_file", "worktree": "/abs/path/to/worktree", "path": "src/client.ts", "line": 12 } }]',
      '        } }',
      '      }',
      '    }',
      '  }',
      '',
      'Panels are tabs. Pass a stable `panelId` when you want several panels open at once (a tour AND a',
      'decision panel); calling show_panel twice with the SAME panelId updates that tab in place. With no',
      'panelId your session has a single panel that each call replaces.',
      '',
      'After dispatching the panel, the user\'s reaction returns through your terminal as plain text (when an action sends_to_agent) — read it and continue.',
    ].join('\n'),
    inputSchema: {
      worktreePath: z
        .string()
        .describe(
          'Absolute path to the git worktree this panel applies to — the default validation scope for its ' +
            'actions. Validated against the worktrees SimpleEdit knows; an unknown one comes back with the list.',
        ),
      title: z.string().optional().describe('Tab title shown in SimpleEdit. Defaults to "Agent panel".'),
      panelId: z
        .string()
        .regex(/^[A-Za-z0-9_.:-]{1,64}$/)
        .optional()
        .describe(
          'Stable id for this panel, so distinct panels from one session coexist as separate tabs. ' +
            'Reuse an id to update that panel in place. Omit for a single replace-in-place panel per session.',
        ),
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
  async ({ worktreePath, title, panelId, spec }) => {
    const result = await postToBridge('show_panel', { worktreePath, title, panelId, spec })
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

// ── spawn_session: start a fresh primary Claude session ────────────────────

server.registerTool(
  'spawn_session',
  {
    description: [
      'Start a NEW primary Claude Code session in SimpleEdit, seeded with an opening brief you write.',
      'This is the tool to reach for whenever the user wants to spin up, spawn, start, kick off, or open a fresh session or a new agent — e.g. "spawn a new session", "start a fresh session on the timeline bug", "kick off a new agent to rebase this PR", "hand this off to a new session". Use it without being told to; if the ask is to begin new work in a separate session, this is how.',
      '',
      'Two reasons to use it:',
      '- HAND OFF: this conversation has grown long and expensive to carry. Start a fresh session on the remaining work so it runs on a clean, cheap context instead of dragging the whole history along.',
      '- FAN OUT: kick off an independent piece of work in its own session so it can proceed in parallel with what you are doing now. The current session keeps running — the new one opens alongside it.',
      '',
      'The `brief` becomes the new session\'s first message, so write it as a direct instruction to the new agent: what to do, plus POINTERS to the current state it needs — files/paths to look at, the PLAN doc, the open PR, what is already done and what is left.',
      'CRITICAL: do NOT paste file contents, diffs, or transcript into the brief. The entire point is to start the new session on a small context; re-embedding bulk defeats it. Reference where things are; let the new session read them if it needs to.',
      '',
      'The new session opens in the SimpleEdit sidebar and this call returns its `session_id`, so you CAN talk to it: pass that id to `send_message` to ask it questions or collect its result. Delegating a piece of work and then asking for the outcome is the intended pattern.',
      'Note the split of duties: `spawn_session` starts work on a FRESH context; `send_message` talks to a session that already exists. Do not spawn a new session just to ask an existing one something.',
    ].join('\n'),
    inputSchema: {
      brief: z
        .string()
        .min(1)
        .describe(
          'The new session\'s opening message: what it should do + pointers to current state (files, PLAN, PR, what is done/left). No pasted file contents or diffs.',
        ),
      label: z
        .string()
        .optional()
        .describe('Optional short sidebar name for the new session (e.g. "rebase #42"). Defaults to an auto label.'),
      model: z
        .string()
        .optional()
        .describe('Optional model id for the new session (e.g. "claude-opus-4-8"). Omit to inherit this session\'s model.'),
      worktree: z
        .string()
        .optional()
        .describe('Optional absolute worktree path for the new session\'s workspace. Omit to use the current workspace worktree.'),
      target: z
        .enum(['new-pane', 'replace'])
        .optional()
        .describe(
          'Where the new session goes. "new-pane" (default) opens it alongside THIS session, which keeps running (fan-out). ' +
            '"replace" hands off: it takes this session\'s place in the sidebar and closes THIS session — use it when you are resetting yourself onto a fresh context and do not intend to keep going here.',
        ),
    },
  },
  async ({ brief, label, model, worktree, target }) => {
    const result = await postToBridge('spawn_session', { brief, label, model, worktree, target })
    if (!result.ok) return errorResult(`Error: ${result.error}`)
    if (target === 'replace') {
      return okResult('New session started in SimpleEdit, replacing this one — this session is being closed.')
    }
    const id = result.data?.session_id
    if (!id) return okResult(result.data?.note ?? 'New session started in SimpleEdit.')
    return okResult(
      `New session started: session_id "${id}" (label "${result.data.label}"). ` +
        `You can now message it with send_message(to: "${id}", …).`,
    )
  },
)

// ── Agent-to-agent messaging ───────────────────────────────────────────────

server.registerTool(
  'list_sessions',
  {
    description: [
      'List the OTHER agent sessions open in SimpleEdit right now, so you can message one.',
      'Returns for each: `session_id` (use this to address it), `label` (what the user sees),',
      '`provider` (e.g. claude, codex), `worktree`, `status` (idle/running/…), and `unread`.',
      '',
      'Use this before send_message when you do not already have a session id — e.g. the user says',
      '"ask the other agent", "check with the session working on the parser", or you want to know',
      'who is available. A session that is `running` can still be messaged: delivery happens when',
      'its current turn ends.',
    ].join('\n'),
    inputSchema: {},
  },
  async () => {
    const result = await postToBridge('list_sessions', {})
    if (!result.ok) return errorResult(`Error: ${result.error}`)
    const sessions = result.data?.sessions ?? []
    if (sessions.length === 0) {
      return okResult('No other agent sessions are open. Use spawn_session to start one.')
    }
    return okResult(JSON.stringify(sessions, null, 2))
  },
)

server.registerTool(
  'send_message',
  {
    description: [
      'Send a message to ANOTHER agent session in SimpleEdit and optionally wait for its answer.',
      'This is real agent-to-agent communication: the recipient may be Claude Code or Codex, in a',
      'different worktree, and it receives your message as input when its current turn ends.',
      '',
      'Reach for this when you want a peer to do or answer something: "ask the other session whether',
      'the migration landed", "tell the reviewer session to look at PR 42", "get the Codex session\'s',
      'opinion on this API shape". Pair it with spawn_session to delegate and then collect a result.',
      '',
      'CRITICAL — send POINTERS, not payloads. Do not paste file contents, diffs, or transcripts.',
      'The recipient pays for every byte in its own context and can read files itself. Reference',
      `paths, PR numbers, commit SHAs, doc names. Messages over ${8000} characters are rejected.`,
      '',
      'With `wait_for_reply: true` this call BLOCKS until the peer answers (it is mid-turn, so this',
      'can take minutes) and returns the reply as your tool result. Without it, the call returns',
      'immediately and any reply arrives on a later turn. If the wait times out, the reply is not',
      'lost — it will be delivered to you later, so do NOT resend.',
    ].join('\n'),
    inputSchema: {
      to: z
        .string()
        .min(1)
        .describe('Target session: its `session_id` from list_sessions, or its exact label if unambiguous.'),
      text: z
        .string()
        .min(1)
        .describe('The message. Written for another agent: what you need, plus pointers to where the state lives.'),
      wait_for_reply: z
        .boolean()
        .optional()
        .describe('Block until the peer answers and return the reply as this tool\'s result. Default false.'),
      timeout_seconds: z
        .number()
        .optional()
        .describe('How long to wait when wait_for_reply is set (10–600, default 300).'),
    },
  },
  async ({ to, text, wait_for_reply, timeout_seconds }) => {
    const result = await postToBridge('send_message', { to, text, wait_for_reply, timeout_seconds })
    if (!result.ok) return errorResult(`Error: ${result.error}`)
    const data = result.data ?? {}
    if (data.reply) {
      return okResult(`Reply from "${data.reply.from_label}" (${data.reply.from}):\n\n${data.reply.text}`)
    }
    if (data.timed_out) {
      return okResult(
        `Message ${data.message_id} delivered to ${data.delivered_to}, but no reply yet. ${data.note} Continue with other work.`,
      )
    }
    return okResult(
      `Message ${data.message_id} queued for ${data.delivered_to}. It is delivered when that session's current turn ends.`,
    )
  },
)

server.registerTool(
  'reply',
  {
    description: [
      'Answer a message another agent session sent you. Use the `message_id` you were given with',
      'that message. If the sender is blocked waiting, your reply is what unblocks it — so reply',
      'promptly and make the answer self-contained.',
      '',
      'You often do NOT need this tool: when you were asked something and simply answer in your',
      'normal response, that final message is relayed back automatically. Use `reply` when you want',
      'to answer explicitly, or to answer one specific message out of several.',
    ].join('\n'),
    inputSchema: {
      to_message_id: z.string().min(1).describe('The `message_id` of the message you are answering.'),
      text: z.string().min(1).describe('Your answer. Self-contained; pointers rather than pasted content.'),
    },
  },
  async ({ to_message_id, text }) => {
    const result = await postToBridge('reply', { to_message_id, text })
    if (!result.ok) return errorResult(`Error: ${result.error}`)
    return okResult(`Reply sent to ${result.data?.delivered_to ?? 'the sender'}.`)
  },
)

server.registerTool(
  'check_inbox',
  {
    description: [
      'Read messages other agent sessions have sent you, and clear them from your inbox.',
      'You normally do not need this: queued messages are delivered to you automatically when your',
      'turn ends. Use it to check explicitly mid-turn — e.g. before a long task, or when the user',
      'asks whether another session has replied yet.',
    ].join('\n'),
    inputSchema: {},
  },
  async () => {
    const result = await postToBridge('check_inbox', {})
    if (!result.ok) return errorResult(`Error: ${result.error}`)
    const data = result.data ?? {}
    if (!data.count) return okResult('Inbox is empty.')
    const rendered = (data.messages ?? [])
      .map(
        (m) =>
          `--- from "${m.from_label}" (${m.from}), message_id ${m.message_id}${m.expects_reply ? ' — SENDER IS WAITING for your reply' : ''} ---\n${m.text}`,
      )
      .join('\n\n')
    return okResult(`${data.count} message(s):\n\n${rendered}`)
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
