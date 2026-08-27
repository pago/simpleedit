import './app.css'
import { mount } from 'svelte'
import { installRemoteApi } from './api-shim'
import RemoteProbe from './RemoteProbe.svelte'

// Installed before anything mounts, so a component can call `window.api` in
// its initialiser exactly as it does in the desktop renderer.
const connection = installRemoteApi()

const app = mount(RemoteProbe, {
  target: document.getElementById('app')!,
  props: { connection },
})

export default app
