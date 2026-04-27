import { app } from 'electron'
import { mkdir, writeFile } from 'fs/promises'
import { extname, basename, join } from 'path'
import { randomUUID } from 'crypto'

const DROP_DIR = 'simpleedit-drops'

function sanitiseName(filename: string): { base: string; ext: string } {
  const safe = filename.replace(/[^\w.-]/g, '_').slice(-80)
  const ext = extname(safe).toLowerCase()
  const base = basename(safe, ext) || 'paste'
  return { base, ext }
}

/**
 * Persist bytes from a drag/drop or clipboard event to a temp file and return
 * the absolute path. Used when the dropped item has no filesystem path (e.g.
 * an image dragged from a browser).
 */
export async function saveDroppedBlob(
  filename: string,
  bytes: Uint8Array
): Promise<string> {
  const dir = join(app.getPath('temp'), DROP_DIR)
  await mkdir(dir, { recursive: true })
  const { base, ext } = sanitiseName(filename)
  const id = randomUUID().slice(0, 8)
  const filePath = join(dir, `${base}-${id}${ext}`)
  await writeFile(filePath, bytes)
  return filePath
}
