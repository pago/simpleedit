/**
 * Which global surface fills the main area. Sessions render through
 * WorkspaceManager; Screen PRs (org-wide) and the backlog (the project's
 * prepared sessions) temporarily take over the main area — neither is a
 * session. Selecting a session returns to 'workspace'.
 */
export type UiView = 'workspace' | 'screenprs' | 'backlog'

let _view = $state<UiView>('workspace')

export const uiView = {
  current(): UiView {
    return _view
  },
  show(view: UiView): void {
    _view = view
  },
}
