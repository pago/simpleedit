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

server.registerTool(
  'show_plan',
  {
    description:
      'Present an implementation plan in SimpleEdit\'s interactive Plan Mode UI. ' +
      'Use this tool when the user asks you to create an implementation plan, design a solution, or plan out work. ' +
      'The plan will be displayed in a structured, interactive view where the user can review individual tasks, ' +
      'provide feedback, approve or reject steps, and start working on tasks. ' +
      'After showing the plan, the user may provide feedback through the Plan Mode UI which will appear as input ' +
      'in your terminal. Revise the plan based on their feedback and call show_plan again with the updated plan.',
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
    if (!BRIDGE_PORT || !BRIDGE_TOKEN || !TERMINAL_ID) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: SimpleEdit bridge environment variables are not set. This tool must be run inside a SimpleEdit terminal.'
          }
        ],
        isError: true
      }
    }

    const url = `http://127.0.0.1:${BRIDGE_PORT}/${BRIDGE_TOKEN}/tool-call`

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: 'show_plan',
          args: { plan, worktreePath },
          terminalId: TERMINAL_ID
        })
      })

      if (!res.ok) {
        const body = await res.text()
        return {
          content: [{ type: 'text', text: `Error from SimpleEdit bridge (${res.status}): ${body}` }],
          isError: true
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: 'Plan displayed in SimpleEdit Plan Mode. The user can now review and provide feedback.'
          }
        ]
      }
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Failed to connect to SimpleEdit bridge at 127.0.0.1:${BRIDGE_PORT}: ${err.message}`
          }
        ],
        isError: true
      }
    }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
