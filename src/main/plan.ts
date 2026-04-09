import { spawn } from 'child_process'
import * as readline from 'readline'
import * as crypto from 'crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { WebContents } from 'electron'
import type {
  Plan,
  PlanTask,
  PlanStatus,
} from '../shared/ipc-types'
import { getCommitDiff, getStagingDiff } from './git-operations'
import { findJsonObjectEnd } from './lib/json-scanner'
import { resolveClaudePath } from './lib/shell-path'

const MAX_DIFF_BYTES = 120_000

export function planKey(worktreePath: string, commitHash: string | null): string {
  return `${worktreePath}:${commitHash ?? 'staging'}`
}

const activePlans = new Map<string, { kill: () => void }>()

function send(wc: WebContents, channel: string, data: unknown): void {
  if (!wc.isDestroyed()) wc.send(channel, data)
}

function sendStatus(wc: WebContents, key: string, status: PlanStatus, error?: string): void {
  send(wc, 'plan:status', { key, status, error })
}

function sendOverview(wc: WebContents, key: string, overview: string): void {
  send(wc, 'plan:overview', { key, overview })
}

function sendTask(wc: WebContents, key: string, task: PlanTask): void {
  send(wc, 'plan:task', { key, task })
}

// -- Persistence -----------------------------------------------

function planCacheDir(): string {
  const dir = join(app.getPath('userData'), 'config', 'plans')
  mkdirSync(dir, { recursive: true })
  return dir
}

function planCacheFile(worktreePath: string, commitHash: string | null): string {
  const key = planKey(worktreePath, commitHash)
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)
  return join(planCacheDir(), `${hash}.json`)
}

export function savePlan(worktreePath: string, commitHash: string | null, plan: Plan): void {
  try {
    writeFileSync(planCacheFile(worktreePath, commitHash), JSON.stringify(plan, null, 2), 'utf-8')
  } catch (err) {
    console.error('[plan] save error:', err)
  }
}

export function loadPlan(worktreePath: string, commitHash: string | null): Plan | null {
  try {
    const raw = readFileSync(planCacheFile(worktreePath, commitHash), 'utf-8')
    return JSON.parse(raw) as Plan
  } catch {
    return null
  }
}

// -- Prompt ----------------------------------------------------

function buildPlanPrompt(diff: string, commitMessage?: string): string {
  const body = diff.length > MAX_DIFF_BYTES
    ? diff.slice(0, MAX_DIFF_BYTES) + '\n\n[diff truncated]'
    : diff

  const commitContext = commitMessage
    ? `\nThe commit message is: "${commitMessage}"\n`
    : '\nThese are uncommitted (staged/unstaged) changes.\n'

  return `You are a software planning assistant. Analyze the following git diff and produce an implementation plan — a set of concrete, actionable tasks that an engineer (or AI agent) should complete to ship this changeset cleanly.
${commitContext}
Output your response as NDJSON (newline-delimited JSON — one JSON object per line, no other output).

The FIRST line must be an overview object with exactly this field:
- "overview": a concise 2-4 sentence summary of the plan — what needs to be done and the recommended approach

Each subsequent line must be a task object with exactly these fields:
- "title": short actionable title for this task (max 80 chars, imperative mood e.g. "Add validation to user input")
- "description": detailed explanation of what to do, including specific files, functions, and edge cases to consider
- "affectedFiles": array of file paths from the diff that this task touches (e.g. ["src/main/foo.ts", "src/renderer/Bar.svelte"])

Guidelines:
- Tasks should be ordered by dependency: foundational work first, then features that build on them.
- Each task should be independently actionable — an agent could pick it up and execute it.
- Include testing tasks where appropriate (e.g. "Add unit tests for X").
- Keep tasks focused: one logical unit of work per task.
- Reference specific code: file paths, function names, line ranges.
- If the diff suggests incomplete work, include tasks for what's missing.
- Aim for 3-8 tasks for a typical changeset. Fewer for small changes, more for large ones.

CRITICAL: Output ONLY valid JSON objects, one per line. No markdown, no prose, no explanation, no code fences.

<diff>
${body}
</diff>`
}

function buildRevisionPrompt(currentPlan: Plan, feedback: string, context: string): string {
  const body = context.length > MAX_DIFF_BYTES
    ? context.slice(0, MAX_DIFF_BYTES) + '\n\n[truncated]'
    : context

  const planSummary = currentPlan.tasks.map((t, i) =>
    `${i + 1}. [${t.status}] ${t.title}: ${t.description}`
  ).join('\n')

  return `You are a software planning assistant. The user has reviewed an implementation plan and provided feedback. Revise the plan accordingly.

Current plan overview: ${currentPlan.overview}

Current tasks:
${planSummary}

User feedback: "${feedback}"

Output your response as NDJSON (newline-delimited JSON — one JSON object per line, no other output).

The FIRST line must be an overview object with exactly this field:
- "overview": updated 2-4 sentence summary reflecting the revision

Each subsequent line must be a task object with exactly these fields:
- "title": short actionable title (max 80 chars, imperative mood)
- "description": detailed explanation of what to do
- "affectedFiles": array of file paths this task touches

Apply the user's feedback: add/remove/modify/reorder tasks as needed. Keep tasks that were marked "done" unless the feedback explicitly says to redo them. Tasks the user rejected (status "rejected") should be removed unless the feedback says to reconsider.

CRITICAL: Output ONLY valid JSON objects, one per line. No markdown, no prose, no explanation, no code fences.

<context>
${body}
</context>`
}

// -- Validation ------------------------------------------------

function parseRawTask(obj: unknown): Omit<PlanTask, 'id' | 'status' | 'reactions' | 'discussion'> | null {
  if (typeof obj !== 'object' || obj === null) return null
  const o = obj as Record<string, unknown>

  if (typeof o['title'] !== 'string' || !o['title']) return null
  if (typeof o['description'] !== 'string' || !o['description']) return null

  let affectedFiles: string[] | undefined
  if (Array.isArray(o['affectedFiles'])) {
    affectedFiles = (o['affectedFiles'] as unknown[]).filter(
      (f): f is string => typeof f === 'string'
    )
    if (affectedFiles.length === 0) affectedFiles = undefined
  }

  return {
    title: o['title'],
    description: o['description'],
    affectedFiles,
  }
}

// -- Plan generation -------------------------------------------

async function runPlanGeneration(
  worktreePath: string,
  commitHash: string | null,
  webContents: WebContents,
  prompt: string,
  statusLabel: PlanStatus,
): Promise<void> {
  const key = planKey(worktreePath, commitHash)

  cancelPlan(worktreePath, commitHash)
  sendStatus(webContents, key, statusLabel)

  const claudeBin = await resolveClaudePath()
  const proc = spawn(claudeBin, [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
  ], {
    cwd: worktreePath,
    env: process.env as Record<string, string>,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  proc.stdin.write(prompt, 'utf8')
  proc.stdin.end()

  let taskCounter = 0
  const accumulatedPlan: Plan = { overview: '', tasks: [] }

  activePlans.set(key, {
    kill: () => {
      try { proc.kill() } catch { /* already dead */ }
    },
  })

  let lastSnapshotText = ''
  let scanPos = 0

  function processTextSnapshot(text: string): void {
    if (!text.startsWith(lastSnapshotText)) {
      lastSnapshotText += text
    } else {
      lastSnapshotText = text
    }
    scanForObjects()
  }

  function scanForObjects(): void {
    let pos = scanPos
    while (pos < lastSnapshotText.length) {
      const start = lastSnapshotText.indexOf('{', pos)
      if (start === -1) break
      const end = findJsonObjectEnd(lastSnapshotText, start)
      if (end === -1) break
      const json = lastSnapshotText.slice(start, end + 1)
      try {
        const parsed = JSON.parse(json) as Record<string, unknown>

        if (typeof parsed['overview'] === 'string') {
          accumulatedPlan.overview = parsed['overview']
          sendOverview(webContents, key, parsed['overview'])
        } else {
          const raw = parseRawTask(parsed)
          if (raw) {
            const task: PlanTask = {
              ...raw,
              id: `${key}:${taskCounter++}`,
              status: 'todo',
              reactions: [],
              discussion: [],
            }
            accumulatedPlan.tasks.push(task)
            sendTask(webContents, key, task)
          }
        }
      } catch { /* not valid JSON */ }
      scanPos = end + 1
      pos = scanPos
    }
  }

  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity })

  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) {
      if (trimmed) console.log('[plan] non-JSON stdout:', trimmed.slice(0, 120))
      return
    }
    try {
      const ev = JSON.parse(trimmed) as Record<string, unknown>
      if (ev['type'] === 'stream_event') {
        const inner = ev['event'] as Record<string, unknown> | undefined
        if (inner?.['type'] === 'content_block_delta') {
          const delta = inner['delta'] as Record<string, unknown> | undefined
          if (delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string' && delta['text']) {
            processTextSnapshot(delta['text'] as string)
          }
        }
      }

      if (ev['type'] === 'result' && typeof ev['result'] === 'string') {
        processTextSnapshot(ev['result'] as string)
      }
    } catch (err) {
      console.log('[plan] JSON parse error:', err, '| line preview:', trimmed.slice(0, 80))
    }
  })

  let stderrBuf = ''
  proc.stderr.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString()
  })

  proc.on('close', (code) => {
    rl.close()
    activePlans.delete(key)
    console.log('[plan] process exited with code', code, '| tasks emitted:', taskCounter)
    if (stderrBuf) console.error('[plan] stderr:', stderrBuf.slice(0, 500))

    if (code === 0 && accumulatedPlan.tasks.length > 0) {
      savePlan(worktreePath, commitHash, accumulatedPlan)
    }

    sendStatus(webContents, key, code === 0 ? 'done' : 'error')
  })

  proc.on('error', (err: Error) => {
    rl.close()
    activePlans.delete(key)
    console.error('[plan] spawn error:', err.message)
    sendStatus(webContents, key, 'error', err.message)
  })
}

export async function startPlan(
  worktreePath: string,
  commitHash: string | null,
  webContents: WebContents
): Promise<void> {
  let diff: string
  try {
    diff = commitHash
      ? await getCommitDiff(worktreePath, commitHash)
      : await getStagingDiff(worktreePath)
  } catch (err: unknown) {
    const key = planKey(worktreePath, commitHash)
    sendStatus(webContents, key, 'error', String(err))
    return
  }

  if (!diff.trim()) {
    const key = planKey(worktreePath, commitHash)
    sendStatus(webContents, key, 'done')
    return
  }

  let commitMessage: string | undefined
  if (commitHash) {
    try {
      const { simpleGit } = await import('simple-git')
      const git = simpleGit(worktreePath)
      const logResult = await git.log({ maxCount: 1, from: commitHash, to: commitHash })
      commitMessage = logResult.latest?.message
    } catch { /* no message available */ }
  }

  const prompt = buildPlanPrompt(diff, commitMessage)
  await runPlanGeneration(worktreePath, commitHash, webContents, prompt, 'running')
}

export async function revisePlan(
  worktreePath: string,
  commitHash: string | null,
  feedback: string,
  webContents: WebContents
): Promise<void> {
  const currentPlan = loadPlan(worktreePath, commitHash)
  if (!currentPlan) {
    const key = planKey(worktreePath, commitHash)
    sendStatus(webContents, key, 'error', 'No existing plan to revise')
    return
  }

  // For description-based plans ('user-plan'), use file tree context instead of diff
  const isUserPlan = commitHash === 'user-plan'
  let context: string
  if (isUserPlan) {
    try {
      const { simpleGit } = await import('simple-git')
      const git = simpleGit(worktreePath)
      context = (await git.raw(['ls-files'])).trim()
    } catch {
      context = '(file listing unavailable)'
    }
  } else {
    try {
      context = commitHash
        ? await getCommitDiff(worktreePath, commitHash)
        : await getStagingDiff(worktreePath)
    } catch (err: unknown) {
      const key = planKey(worktreePath, commitHash)
      sendStatus(webContents, key, 'error', String(err))
      return
    }
  }

  const prompt = buildRevisionPrompt(currentPlan, feedback, context)
  await runPlanGeneration(worktreePath, commitHash, webContents, prompt, 'revising')
}

export async function startPlanFromDescription(
  worktreePath: string,
  description: string,
  webContents: WebContents
): Promise<void> {
  // Gather codebase context
  let fileTree = ''
  try {
    const { simpleGit } = await import('simple-git')
    const git = simpleGit(worktreePath)
    const files = await git.raw(['ls-files'])
    fileTree = files.trim()
  } catch {
    fileTree = '(file listing unavailable)'
  }

  let claudeMd = ''
  try {
    claudeMd = readFileSync(join(worktreePath, 'CLAUDE.md'), 'utf-8')
  } catch {
    // No CLAUDE.md present
  }

  const prompt = buildDescriptionPrompt(description, fileTree, claudeMd)
  await runPlanGeneration(worktreePath, 'user-plan', webContents, prompt, 'running')
}

function buildDescriptionPrompt(description: string, fileTree: string, claudeMd: string): string {
  const claudeContext = claudeMd
    ? `\nProject conventions and architecture (from CLAUDE.md):\n${claudeMd}\n`
    : ''

  return `You are a software planning assistant. The user wants to implement the following:

"${description}"
${claudeContext}
File tree:
${fileTree}

Produce an implementation plan as NDJSON (newline-delimited JSON — one JSON object per line, no other output).

The FIRST line must be an overview object with exactly this field:
- "overview": a concise 2-4 sentence summary of the plan — what needs to be done and the recommended approach

Each subsequent line must be a task object with exactly these fields:
- "title": short actionable title for this task (max 80 chars, imperative mood e.g. "Add validation to user input")
- "description": detailed explanation of what to do, including specific files, functions, and edge cases to consider
- "affectedFiles": array of file paths that this task will touch (e.g. ["src/main/foo.ts", "src/renderer/Bar.svelte"])

Guidelines:
- Tasks should be ordered by dependency: foundational work first, then features that build on them.
- Each task should be independently actionable — an agent could pick it up and execute it.
- Include testing tasks where appropriate (e.g. "Add unit tests for X").
- Keep tasks focused: one logical unit of work per task.
- Reference specific code: file paths, function names from the file tree.
- Aim for 3-8 tasks. Fewer for small changes, more for large ones.

CRITICAL: Output ONLY valid JSON objects, one per line. No markdown, no prose, no explanation, no code fences.`
}

export function cancelPlan(worktreePath: string, commitHash: string | null): void {
  const key = planKey(worktreePath, commitHash)
  activePlans.get(key)?.kill()
  activePlans.delete(key)
}

export function cancelAllPlans(): void {
  for (const { kill } of activePlans.values()) kill()
  activePlans.clear()
}
