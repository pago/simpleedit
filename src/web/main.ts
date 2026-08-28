import './app.css'
import { mount } from 'svelte'
import { installRemoteApi } from './api-shim'
import { initScreenPrsListeners } from '../renderer/stores/screenprs.svelte'
import PocketApp from './PocketApp.svelte'

// Installed before anything mounts, so a component can call `window.api` in
// its initialiser exactly as it does in the desktop renderer.
const connection = installRemoteApi()

// Subscribed for the life of the page, not of the PRs tab: cards stream in for
// minutes, and a board that only listened while you were looking at it would
// lose whatever landed while you were reading a session.
initScreenPrsListeners()

const app = mount(PocketApp, {
  target: document.getElementById('app')!,
  props: { connection },
})

export default app
