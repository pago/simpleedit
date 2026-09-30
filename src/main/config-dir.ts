import { mkdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

/** `userData/config[/…sub]`, created on demand. Where every persisted preference lives. */
export function configDir(...sub: string[]): string {
  const dir = join(app.getPath('userData'), 'config', ...sub)
  mkdirSync(dir, { recursive: true })
  return dir
}
