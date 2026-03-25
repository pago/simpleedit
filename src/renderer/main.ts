import './monaco-setup'
import './app.css'
import { initModelAutoLoader } from './lsp/model-loader'
import App from './App.svelte'
import { mount } from 'svelte'

initModelAutoLoader()

const app = mount(App, {
  target: document.getElementById('app')!
})

export default app
