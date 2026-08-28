import './app.css'
import { mount } from 'svelte'
import { installRemoteApi } from './api-shim'
import PocketApp from './PocketApp.svelte'

// Installed before anything mounts, so a component can call `window.api` in
// its initialiser exactly as it does in the desktop renderer.
const connection = installRemoteApi()

const app = mount(PocketApp, {
  target: document.getElementById('app')!,
  props: { connection },
})

export default app
