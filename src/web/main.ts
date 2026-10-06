import './app.css'
import { mount } from 'svelte'
import { checkKeyWithServer, installRemoteApi } from './api-shim'
import { attachParams, loadRememberedProject } from './lib/project'
import { resolveKey, settleUrlKey } from './lib/remote-key'
import { initScreenPrsListeners, screenPrsStore } from '../renderer/stores/screenprs.svelte'
import PocketApp from './PocketApp.svelte'
import { trackVisualViewport } from './lib/visual-viewport.svelte'

// Installed before anything mounts, so a component can call `window.api` in
// its initialiser exactly as it does in the desktop renderer. Every connect
// names the project this device remembers (`lib/project.ts`).
const keys = resolveKey(window.location.search)
const connection = installRemoteApi({
  key: keys.key,
  attachParams: () => attachParams(loadRememberedProject()),
})
// Only one key is current at a time, so a candidate the Mac confirms means the
// stored key is already dead: switching to it costs no working connection.
if (keys.candidate) void settleUrlKey(keys.candidate, checkKeyWithServer, (key) => connection.setKey(key))

// Subscribed for the life of the page, not of the PRs tab: cards stream in for
// minutes, and a board that only listened while you were looking at it would
// lose whatever landed while you were reading a session.
initScreenPrsListeners()
// Review drafts, the filter and Screen PRs runs are shared with the desktop, and
// a broadcast sent while the socket was down (or switching project) never
// arrives — so every (re)connect reloads them.
connection.onIdentity(() => {
  void screenPrsStore.loadDrafts()
  void screenPrsStore.loadFilter()
  void screenPrsStore.loadState()
})

trackVisualViewport()

const app = mount(PocketApp, {
  target: document.getElementById('app')!,
  props: { connection },
})

export default app
