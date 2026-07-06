/**
 * Persisted model preferences. Mirrors recent-repos.ts: a single JSON blob
 * under userData/config, try/catch reads returning defaults.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { ModelConfig } from '../../shared/ipc-types'

function defaults(): ModelConfig {
  return { defaults: {}, submenuAllowlist: [] }
}

function configDir(): string {
  const dir = join(app.getPath('userData'), 'config')
  mkdirSync(dir, { recursive: true })
  return dir
}

function filePath(): string {
  return join(configDir(), 'models.json')
}

export function getModelConfig(): ModelConfig {
  try {
    const raw = readFileSync(filePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ModelConfig>
    return {
      defaults: parsed.defaults ?? {},
      submenuAllowlist: parsed.submenuAllowlist ?? [],
      lastUsed: parsed.lastUsed,
    }
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
  }
  writeFileSync(filePath(), JSON.stringify(next, null, 2), 'utf-8')
  return next
}
