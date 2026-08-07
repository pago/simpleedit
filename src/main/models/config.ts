/**
 * Persisted model preferences. Mirrors recent-repos.ts: a single JSON blob
 * under userData/config, try/catch reads returning defaults.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { ModelConfig, ModelRef } from '../../shared/ipc-types'

/**
 * Deep-review defaults: mostly-local. Intent/tests/soundness on by default and
 * inherit the screenPrs model (unset) — so they run local when triage is local;
 * types/architecture off by default (opt in for risky PRs). Escalate a lens to
 * cloud by setting its `model` in Settings.
 */
function defaultDeepReview(): NonNullable<ModelConfig['deepReview']> {
  return {
    lenses: {
      soundness: { enabled: true },
      intent: { enabled: true },
      tests: { enabled: true },
      types: { enabled: false },
      architecture: { enabled: false },
    },
  }
}

function defaults(): ModelConfig {
  return { defaults: {}, submenuAllowlist: [], deepReview: defaultDeepReview() }
}

function configDir(): string {
  const dir = join(app.getPath('userData'), 'config')
  mkdirSync(dir, { recursive: true })
  return dir
}

function filePath(): string {
  if (process.env.SIMPLEEDIT_E2E_MODEL_CONFIG) return process.env.SIMPLEEDIT_E2E_MODEL_CONFIG
  return join(configDir(), 'models.json')
}

/**
 * Model ids dropped from CLAUDE_MODELS, mapped to their successor. A stored ref
 * to a model no longer in the catalog keeps driving `--model` while the Settings
 * picker renders blank (no matching `<option>`), so retiring an id means
 * rewriting the refs that point at it. Read-time and idempotent; it lands on
 * disk with the next write.
 */
const SUCCEEDED_MODELS: Record<string, string> = {
  'claude-opus-4-8': 'claude-opus-5',
}

function succeed(model: string): string {
  return SUCCEEDED_MODELS[model] ?? model
}

function succeedRef<T extends ModelRef | undefined>(ref: T): T {
  if (!ref || ref.provider !== 'anthropic') return ref
  const model = succeed(ref.model)
  return (model === ref.model ? ref : { ...ref, model }) as T
}

function migrateRetiredModels(config: ModelConfig): ModelConfig {
  const lenses = Object.fromEntries(
    Object.entries(config.deepReview?.lenses ?? {}).map(([id, lens]) => [
      id,
      lens?.model ? { ...lens, model: succeedRef(lens.model) } : lens,
    ])
  )
  return {
    defaults: Object.fromEntries(
      Object.entries(config.defaults).map(([feature, ref]) => [feature, succeedRef(ref)])
    ),
    submenuAllowlist: config.submenuAllowlist.map(succeed),
    lastUsed: succeedRef(config.lastUsed),
    deepReview: config.deepReview && {
      ...config.deepReview,
      lenses,
      synthesisModel: succeedRef(config.deepReview.synthesisModel),
    },
  }
}

export function getModelConfig(): ModelConfig {
  try {
    const raw = readFileSync(filePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ModelConfig>
    return migrateRetiredModels({
      defaults: parsed.defaults ?? {},
      submenuAllowlist: parsed.submenuAllowlist ?? [],
      lastUsed: parsed.lastUsed,
      deepReview: parsed.deepReview ?? defaultDeepReview(),
    })
  } catch {
    return defaults()
  }
}

/** Merge a partial update over the current config and persist the result. */
export function setModelConfig(partial: Partial<ModelConfig>): ModelConfig {
  const current = getModelConfig()
  const next: ModelConfig = {
    defaults: partial.defaults ?? current.defaults,
    submenuAllowlist: partial.submenuAllowlist ?? current.submenuAllowlist,
    // Distinguish "not provided" from an explicit clear to null/undefined.
    lastUsed: 'lastUsed' in partial ? partial.lastUsed : current.lastUsed,
    deepReview: partial.deepReview ?? current.deepReview,
  }
  writeFileSync(filePath(), JSON.stringify(next, null, 2), 'utf-8')
  return next
}
