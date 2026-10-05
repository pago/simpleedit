import './app.css'
import { mount } from 'svelte'
import { installRemoteApi } from './api-shim'
import { attachParams, loadRememberedProject } from './lib/project'
import { initScreenPrsListeners, screenPrsStore } from '../renderer/stores/screenprs.svelte'
import PocketApp from './PocketApp.svelte'

// Installed before anything mounts, so a component can call `window.api` in
// its initialiser exactly as it does in the desktop renderer. Every connect
// names the project this device remembers (`lib/project.ts`).
const connection = installRemoteApi({ attachParams: () => attachParams(loadRememberedProject()) })

// Subscribed for the life of the page, not of the PRs tab: cards stream in for
// minutes, and a board that only listened while you were looking at it would
// lose whatever landed while you were reading a session.
initScreenPrsListeners()
// Review drafts are edited from the desktop too, and a broadcast sent while
// the socket was down never arrives — so every (re)connect reloads them.
connection.onIdentity(() => void screenPrsStore.loadDrafts())

const app = mount(PocketApp, {
  target: document.getElementById('app')!,
  props: { connection },
})

export default app
