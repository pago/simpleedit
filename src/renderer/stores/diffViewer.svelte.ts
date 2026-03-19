/**
 * State for viewing commit diffs.
 * When a commit is selected in GitLog, the diff content is stored here
 * and the MainPanel switches from the code editor to the diff viewer.
 */

export interface DiffViewState {
  commitHash: string
  commitMessage: string
  diffContent: string
}

let _diffView = $state<DiffViewState | null>(null)

export const diffView = {
  get value(): DiffViewState | null {
    return _diffView
  }
}

export function showDiff(state: DiffViewState): void {
  _diffView = state
}

export function closeDiff(): void {
  _diffView = null
}
