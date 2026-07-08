/**
 * Which global surface fills the main area. Sessions render through
 * WorkspaceManager; Screen PRs is an org-wide view that temporarily takes over
 * the main area (it isn't a session). Selecting a session returns to 'workspace'.
 */
export type UiView = 'workspace' | 'screenprs'

let _view = $state<UiView>('workspace')

export const uiView = {
  current(): UiView {
    return _view
  },
  show(view: UiView): void {
    _view = view
  },
}
