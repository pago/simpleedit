import type { PaletteAction } from '../lib/command-palette/types'

let _isOpen = $state(false)
let _pendingAction = $state<PaletteAction | null>(null)

export function isPaletteOpen(): boolean {
  return _isOpen
}

export function openPalette(): void {
  _isOpen = true
}

export function closePalette(): void {
  _isOpen = false
}

export function togglePalette(): void {
  _isOpen = !_isOpen
}

export function dispatchPaletteAction(action: PaletteAction): void {
  _pendingAction = action
}

export function consumePaletteAction(): PaletteAction | null {
  const action = _pendingAction
  _pendingAction = null
  return action
}

export function pendingPaletteAction(): PaletteAction | null {
  return _pendingAction
}
