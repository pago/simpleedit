#!/usr/bin/env node
/**
 * What the real Claude CLI would send SimpleEdit's bridge, for e2e/bin/claude
 * acting as a review companion (SIMPLEEDIT_FAKE_CLAUDE_COMPANION=1).
 *
 *   fake-claude-bridge.mjs stop   <settings> <mcp-config> <session-id>
 *     The turn the launch prompt started ended: a `Stop` hook.
 *   fake-claude-bridge.mjs answer <settings> <mcp-config> <session-id> <thread-id> <prompt>
 *     A typed review-thread prompt arrived: `UserPromptSubmit` carrying it,
 *     `reply_to_thread` over the MCP tool route, then `Stop`.
 *   fake-claude-bridge.mjs request <settings> <mcp-config> <session-id> <pr-url> <prompt>
 *     The author asks for a review: `UserPromptSubmit`, `request_review` with
 *     a briefing, then `Stop`.
 *   fake-claude-bridge.mjs handback <settings> <mcp-config> <session-id> <review-id> <prompt>
 *     The submitted review came back: `UserPromptSubmit` carrying it,
 *     `get_review` (its answer written to SIMPLEEDIT_FAKE_CLAUDE_GET_REVIEW_OUT),
 *     then `Stop`.
 *
 * The URLs and credentials are the ones SimpleEdit wrote into the session's
 * `--settings` hooks and `--mcp-config` env, so this exercises the same
 * routes the CLI and the MCP server use. Prints one status line, which lands
 * in the PTY's backlog for debugging.
 */
import fs from 'fs'

const [mode, settingsPath, mcpConfigPath, sessionId, threadId, prompt] = process.argv.slice(2)

const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
const hookUrl = settings.hooks?.Stop?.[0]?.hooks?.[0]?.url
const env = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8')).mcpServers?.simpleedit?.env ?? {}
const toolUrl = `http://127.0.0.1:${env.SIMPLEEDIT_BRIDGE_PORT}/${env.SIMPLEEDIT_BRIDGE_TOKEN}/tool-call`

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${text}`)
  return text
}

const hook = (event, extra = {}) =>
  post(hookUrl, { hook_event_name: event, session_id: sessionId, cwd: process.cwd(), ...extra })

async function main() {
  if (!hookUrl) throw new Error('no hook URL in the settings file')
  if (mode === 'stop') {
    await hook('Stop', { stop_hook_active: false, last_assistant_message: 'Ready. Waiting for your instructions.' })
    return 'stopped'
  }
  if (mode === 'answer') {
    await hook('UserPromptSubmit', { prompt })
    await post(toolUrl, {
      tool: 'reply_to_thread',
      terminalId: env.SIMPLEEDIT_TERMINAL_ID,
      args: { thread_id: threadId, body: `Fake companion answer for ${threadId}.` },
    })
    await hook('Stop', { stop_hook_active: false, last_assistant_message: `Answered ${threadId}.` })
    return `answered ${threadId}`
  }
  if (mode === 'request') {
    const url = threadId
    await hook('UserPromptSubmit', { prompt })
    const answer = await post(toolUrl, {
      tool: 'request_review',
      terminalId: env.SIMPLEEDIT_TERMINAL_ID,
      args: {
        pr: url,
        focus: 'the clamp',
        briefing: {
          what: 'Adds clamp() over a named LIMIT.',
          why: 'Callers passed raw numbers.',
          evidence: [{ command: 'pnpm test', output_excerpt: '3 passed', exit_code: 0 }],
          open_questions: [{ text: 'Is 10 the right limit?', path: 'src/stack.ts', line: 1 }],
        },
      },
    })
    await hook('Stop', { stop_hook_active: false, last_assistant_message: 'Asked for a review.' })
    return `requested ${JSON.parse(answer).review_id}`
  }
  if (mode === 'handback') {
    const reviewId = threadId
    await hook('UserPromptSubmit', { prompt })
    const review = await post(toolUrl, { tool: 'get_review', terminalId: env.SIMPLEEDIT_TERMINAL_ID, args: { review_id: reviewId } })
    if (process.env.SIMPLEEDIT_FAKE_CLAUDE_GET_REVIEW_OUT) fs.writeFileSync(process.env.SIMPLEEDIT_FAKE_CLAUDE_GET_REVIEW_OUT, review)
    await hook('Stop', { stop_hook_active: false, last_assistant_message: 'Read the review.' })
    return `read ${reviewId}`
  }
  throw new Error(`unknown mode ${mode}`)
}

main().then(
  (what) => process.stdout.write(`fake companion: ${what}\r\n`),
  (err) => {
    process.stdout.write(`fake companion: ${mode} failed: ${err instanceof Error ? err.message : err}\r\n`)
    process.exitCode = 1
  }
)
