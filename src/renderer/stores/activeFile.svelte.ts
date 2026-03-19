export interface OpenFile {
  path: string
  modified: boolean
}

let _openFiles = $state<OpenFile[]>([])
let _activeFilePath = $state<string | null>(null)

export const openFiles = {
  get value(): OpenFile[] {
    return _openFiles
  }
}

export const activeFile = {
  get value(): string | null {
    return _activeFilePath
  }
}

export function openFile(path: string): void {
  const existing = _openFiles.find((f) => f.path === path)
  if (!existing) {
    _openFiles = [..._openFiles, { path, modified: false }]
  }
  _activeFilePath = path
}

export function closeFile(path: string): void {
  const idx = _openFiles.findIndex((f) => f.path === path)
  if (idx === -1) return

  _openFiles = _openFiles.filter((f) => f.path !== path)

  if (_activeFilePath === path) {
    if (_openFiles.length === 0) {
      _activeFilePath = null
    } else {
      // Activate the nearest tab
      const newIdx = Math.min(idx, _openFiles.length - 1)
      _activeFilePath = _openFiles[newIdx].path
    }
  }
}

export function setActiveFile(path: string): void {
  if (_openFiles.some((f) => f.path === path)) {
    _activeFilePath = path
  }
}

export function markModified(path: string, modified: boolean): void {
  _openFiles = _openFiles.map((f) => (f.path === path ? { ...f, modified } : f))
}
