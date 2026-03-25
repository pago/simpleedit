import * as monaco from 'monaco-editor'
import { StandaloneServices } from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js'
import { ITextModelService } from 'monaco-editor/esm/vs/editor/common/services/resolverService.js'

/**
 * Patches Monaco's `ITextModelService.createModelReference` so that file://
 * URIs with no existing model are loaded from disk via IPC.
 *
 * The default standalone implementation rejects with "Model not found" when no
 * model exists for a URI. This means the peek/reference widget shows blank
 * content for any file the user hasn't opened in the main editor.
 *
 * This patch intercepts the rejection, reads the file via `editor:open`, creates
 * a model with the loaded content, and returns a valid model reference. Existing
 * models (files already open) are returned unchanged by the original method.
 *
 * Call once, before mounting the Svelte app.
 */
export function initModelAutoLoader(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const textModelService = StandaloneServices.get(ITextModelService) as any
  const original = textModelService.createModelReference.bind(textModelService)

  textModelService.createModelReference = async function (resource: monaco.Uri) {
    try {
      return await original(resource)
    } catch {
      // Model doesn't exist — load the file if it's a file:// URI
      if (resource.scheme !== 'file') throw new Error(`Model not found: ${resource}`)

      const filePath = resource.fsPath
      const content = await window.api.invoke('editor:open', filePath)
      const lang = guessLanguage(filePath)
      monaco.editor.createModel(content, lang, resource)

      // The model now exists — the original method will find it
      return original(resource)
    }
  }
}

function guessLanguage(filePath: string): string | undefined {
  const ext = filePath.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescriptreact',
    js: 'javascript', jsx: 'javascriptreact',
    json: 'json', css: 'css', scss: 'scss',
    html: 'html', md: 'markdown', yaml: 'yaml', yml: 'yaml',
    svelte: 'html',
  }
  return ext ? map[ext] : undefined
}
