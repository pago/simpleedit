/**
 * User overrides of prompt instructions, one markdown file per prompt under
 * `userData/config/prompts/<id>.md`. Read on every run (like `getModelConfig`),
 * so an edit applies to the next screening without a restart.
 *
 * An override replaces only the instruction text; there are no placeholders.
 * A bad override never fails a run: a missing, empty or unreadable file resolves
 * to the default, and the reason is surfaced in Settings instead.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { createHash } from 'crypto'
import type { PromptId, PromptInfo, PromptStatus } from '../../shared/ipc-types'
import { configDir } from '../config-dir'
import { PROMPTS, promptDefinition, type PromptDefinition } from './registry'

export interface ResolvedInstructions {
  text: string
  source: 'default' | 'custom'
  basedOn?: number
  error?: string
}

export interface ParsedOverride {
  /** Frontmatter keys in file order. */
  frontmatter: Array<[key: string, value: string]>
  body: string
}

const BASED_ON = 'based-on'

export function promptsDir(): string {
  return configDir('prompts')
}

export function promptPath(id: PromptId): string {
  return join(promptsDir(), `${promptDefinition(id).id}.md`)
}

/** Split an override file into its `---`-fenced frontmatter and the instruction body. */
export function parseOverride(raw: string): ParsedOverride {
  const text = raw.replace(/\r\n/g, '\n')
  const close = text.startsWith('---\n') ? text.indexOf('\n---', 3) : -1
  const afterClose = close === -1 ? -1 : close + 4
  // The closing fence must sit on its own line; otherwise there is no frontmatter.
  if (close === -1 || (afterClose < text.length && text[afterClose] !== '\n')) {
    return { frontmatter: [], body: text.trim() }
  }
  const frontmatter: Array<[string, string]> = []
  for (const line of text.slice(4, close).split('\n')) {
    const colon = line.indexOf(':')
    if (colon > 0) frontmatter.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()])
  }
  return { frontmatter, body: text.slice(afterClose).trim() }
}

/** The default version recorded by `based-on: <id>@<version>`, if any. */
export function basedOnVersion(parsed: ParsedOverride): number | undefined {
  const value = parsed.frontmatter.find(([key]) => key === BASED_ON)?.[1]
  const match = value?.match(/@(\d+)$/)
  return match ? Number(match[1]) : undefined
}

function serialize(frontmatter: Array<[string, string]>, body: string): string {
  const head = frontmatter.map(([key, value]) => `${key}: ${value}`).join('\n')
  return `---\n${head}\n---\n\n${body.trim()}\n`
}

type ReadResult = { kind: 'missing' } | { kind: 'error'; error: string } | { kind: 'ok'; parsed: ParsedOverride }

function readOverride(def: PromptDefinition): ReadResult {
  try {
    return { kind: 'ok', parsed: parseOverride(readFileSync(promptPath(def.id), 'utf-8')) }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'error', error: `Couldn't read the override (${code ?? String(err)}) — using the default.` }
  }
}

/** The instruction text a run should use for `id`, and where it came from. */
export function resolveInstructions(id: PromptId): ResolvedInstructions {
  const def = promptDefinition(id)
  const read = readOverride(def)
  if (read.kind === 'missing') return { text: def.defaultInstructions, source: 'default' }
  if (read.kind === 'error') return { text: def.defaultInstructions, source: 'default', error: read.error }
  const basedOn = basedOnVersion(read.parsed)
  if (!read.parsed.body) {
    return { text: def.defaultInstructions, source: 'default', basedOn, error: 'The override is empty — using the default.' }
  }
  return { text: read.parsed.body, source: 'custom', basedOn }
}

/** Fingerprint component: any change to the effective text invalidates cached results. */
export function instructionsHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function promptStatus(resolved: ResolvedInstructions, defaultVersion: number): PromptStatus {
  if (resolved.error) return 'error'
  if (resolved.source === 'default') return 'default'
  return resolved.basedOn !== undefined && resolved.basedOn < defaultVersion ? 'outdated' : 'custom'
}

export function listPrompts(): PromptInfo[] {
  return PROMPTS.map((def) => {
    const resolved = resolveInstructions(def.id)
    return {
      id: def.id,
      title: def.title,
      description: def.description,
      group: def.group,
      status: promptStatus(resolved, def.defaultVersion),
      ...(resolved.error ? { error: resolved.error } : {}),
      path: promptPath(def.id),
      defaultVersion: def.defaultVersion,
      ...(resolved.basedOn !== undefined ? { basedOn: resolved.basedOn } : {}),
    }
  })
}

export function readPrompt(id: PromptId): { text: string; defaultText: string } {
  const def = promptDefinition(id)
  const read = readOverride(def)
  return { text: read.kind === 'ok' ? read.parsed.body : def.defaultInstructions, defaultText: def.defaultInstructions }
}

function write(id: PromptId, content: string): void {
  const path = promptPath(id)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf-8')
}

export function customizePrompt(id: PromptId): string {
  const def = promptDefinition(id)
  if (!existsSync(promptPath(id))) {
    write(id, serialize([[BASED_ON, `${def.id}@${def.defaultVersion}`]], def.defaultInstructions))
  }
  return promptPath(id)
}

/** Replace the instruction body, keeping the file's frontmatter (seeding `based-on` if absent). */
export function savePrompt(id: PromptId, text: string): void {
  const def = promptDefinition(id)
  if (typeof text !== 'string') throw new Error('Prompt text must be a string')
  const read = readOverride(def)
  const frontmatter = read.kind === 'ok' ? read.parsed.frontmatter : []
  const withBase: Array<[string, string]> = frontmatter.some(([key]) => key === BASED_ON)
    ? frontmatter
    : [...frontmatter, [BASED_ON, `${def.id}@${def.defaultVersion}`]]
  write(id, serialize(withBase, text))
}

export function resetPrompt(id: PromptId): void {
  rmSync(promptPath(id), { force: true })
}

/** What Reveal in Finder should select: the override, or the folder it would go in. */
export function revealTarget(id: PromptId): { path: string; exists: boolean } {
  const path = promptPath(id)
  if (existsSync(path)) return { path, exists: true }
  mkdirSync(dirname(path), { recursive: true })
  return { path: dirname(path), exists: false }
}
