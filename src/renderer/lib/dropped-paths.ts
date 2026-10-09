/**
 * The filesystem path of a dropped file. Data with no path behind it (an image
 * dragged out of a browser) is saved to a temp file first, so every drop ends
 * as a path an agent can read.
 */
export async function resolveDropPath(file: File): Promise<string> {
  const path = window.api.getPathForFile(file)
  if (path) return path
  const bytes = new Uint8Array(await file.arrayBuffer())
  return window.api.invoke('app:save-dropped-blob', file.name || 'paste', bytes)
}
