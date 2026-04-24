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
  'show_plan',
  {
    description:
      'ALWAYS use this tool to present implementation plans to the user. ' +
      'The user is working in SimpleEdit\'s IDE and expects plans to appear in the interactive Plan Mode UI — ' +
      'never print plan content as terminal text. ' +
      'Call this tool whenever you have a multi-step implementation approach to communicate: ' +
      'when the user asks you to create a plan, design a solution, or plan out work, ' +
      'or whenever you would otherwise write out an enumerated list of steps before coding. ' +
      'After showing the plan, the user may react to or comment on individual tasks through the Plan Mode UI — ' +
      'their feedback will arrive in your terminal as plain text. Revise and call show_plan again with the updated plan.',
    inputSchema: {
      plan: z.object({
        overview: z.string().describe('High-level summary of the implementation plan'),
        tasks: z.array(
          z.object({
            title: z.string().describe('Short title for this task'),
            description: z.string().describe('Detailed description of what this task involves'),
            affectedFiles: z.array(z.string()).optional().describe('File paths that will be created or modified'),
            status: z
              .enum(['todo', 'in-progress', 'done', 'rejected'])
              .default('todo')
              .describe('Current status of this task')
          })
        ).describe('Ordered list of tasks that make up the plan')
      }).describe('The implementation plan to display'),
      worktreePath: z.string().describe('Absolute path to the git worktree this plan applies to')
    }
  },
  async ({ plan, worktreePath }) => {
    const result = await postToBridge('show_plan', { plan, worktreePath })
    if (!result.ok) return errorResult(`Error: ${result.error}`)
    return okResult('Plan displayed in SimpleEdit Plan Mode. The user can now review and provide feedback.')
  }
)

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

const transport = new StdioServerTransport()
await server.connect(transport)
