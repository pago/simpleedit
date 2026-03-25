import * as monaco from 'monaco-editor'
import type {
  Hover,
  Location,
  CompletionList,
  CompletionItem,
  SignatureHelp,
  PublishDiagnosticsParams,
  ServerCapabilities,
  DocumentHighlight,
} from 'vscode-languageserver-protocol'
import type { LspConnection } from './connection'

// ── Coordinate conversion ─────────────────────────────────

function toPosition(pos: monaco.Position): { line: number; character: number } {
  return { line: pos.lineNumber - 1, character: pos.column - 1 }
}

function lspRangeToMonaco(r: { start: { line: number; character: number }; end: { line: number; character: number } }): monaco.IRange {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  }
}

function modelUri(model: monaco.editor.ITextModel): string {
  return model.uri.toString()
}

// ── Diagnostics ───────────────────────────────────────────

const LSP_SEVERITY_MAP: Record<number, monaco.MarkerSeverity> = {
  1: monaco.MarkerSeverity.Error,
  2: monaco.MarkerSeverity.Warning,
  3: monaco.MarkerSeverity.Info,
  4: monaco.MarkerSeverity.Hint,
}

function setupDiagnostics(connection: LspConnection): () => void {
  return connection.onNotification('textDocument/publishDiagnostics', (params) => {
    const { uri, diagnostics } = params as PublishDiagnosticsParams
    // uri from LSP is file:// — find the matching Monaco model
    const monacoUri = monaco.Uri.parse(uri)
    const model = monaco.editor.getModel(monacoUri)
    if (!model) return

    const markers: monaco.editor.IMarkerData[] = diagnostics.map((d) => ({
      startLineNumber: d.range.start.line + 1,
      startColumn: d.range.start.character + 1,
      endLineNumber: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
      message: d.message,
      severity: LSP_SEVERITY_MAP[d.severity ?? 1] ?? monaco.MarkerSeverity.Error,
      source: d.source,
      code: d.code != null ? String(d.code) : undefined,
    }))

    monaco.editor.setModelMarkers(model, 'lsp', markers)
  })
}

// ── Hover ─────────────────────────────────────────────────

function registerHover(
  languageId: string,
  connection: LspConnection
): monaco.IDisposable {
  return monaco.languages.registerHoverProvider(languageId, {
    async provideHover(model, position) {
      try {
        const result = await connection.sendRequest<Hover | null>('textDocument/hover', {
          textDocument: { uri: modelUri(model) },
          position: toPosition(position),
        })
        if (!result) return null

        const contents = Array.isArray(result.contents)
          ? result.contents
          : [result.contents]

        const value = contents
          .map((c) => (typeof c === 'string' ? c : c.value))
          .join('\n\n')

        return {
          contents: [{ value, isTrusted: false }],
          range: result.range ? lspRangeToMonaco(result.range) : undefined,
        }
      } catch {
        return null
      }
    },
  })
}

// ── Go to definition ──────────────────────────────────────

function registerDefinition(
  languageId: string,
  connection: LspConnection
): monaco.IDisposable {
  return monaco.languages.registerDefinitionProvider(languageId, {
    async provideDefinition(model, position) {
      try {
        const result = await connection.sendRequest<Location | Location[] | null>(
          'textDocument/definition',
          {
            textDocument: { uri: modelUri(model) },
            position: toPosition(position),
          }
        )
        if (!result) return []

        const locations = Array.isArray(result) ? result : [result]
        return locations.map((loc) => ({
          uri: monaco.Uri.parse(loc.uri),
          range: lspRangeToMonaco(loc.range),
        }))
      } catch {
        return []
      }
    },
  })
}

// ── Completion ────────────────────────────────────────────

function lspCompletionKindToMonaco(kind: number | undefined): monaco.languages.CompletionItemKind {
  const map: Record<number, monaco.languages.CompletionItemKind> = {
    1: monaco.languages.CompletionItemKind.Text,
    2: monaco.languages.CompletionItemKind.Method,
    3: monaco.languages.CompletionItemKind.Function,
    4: monaco.languages.CompletionItemKind.Constructor,
    5: monaco.languages.CompletionItemKind.Field,
    6: monaco.languages.CompletionItemKind.Variable,
    7: monaco.languages.CompletionItemKind.Class,
    8: monaco.languages.CompletionItemKind.Interface,
    9: monaco.languages.CompletionItemKind.Module,
    10: monaco.languages.CompletionItemKind.Property,
    11: monaco.languages.CompletionItemKind.Unit,
    12: monaco.languages.CompletionItemKind.Value,
    13: monaco.languages.CompletionItemKind.Enum,
    14: monaco.languages.CompletionItemKind.Keyword,
    15: monaco.languages.CompletionItemKind.Snippet,
    16: monaco.languages.CompletionItemKind.Color,
    17: monaco.languages.CompletionItemKind.File,
    18: monaco.languages.CompletionItemKind.Reference,
    19: monaco.languages.CompletionItemKind.Folder,
    20: monaco.languages.CompletionItemKind.EnumMember,
    21: monaco.languages.CompletionItemKind.Constant,
    22: monaco.languages.CompletionItemKind.Struct,
    23: monaco.languages.CompletionItemKind.Event,
    24: monaco.languages.CompletionItemKind.Operator,
    25: monaco.languages.CompletionItemKind.TypeParameter,
  }
  return map[kind ?? 0] ?? monaco.languages.CompletionItemKind.Text
}

function lspItemToMonaco(item: CompletionItem, defaultRange: monaco.IRange): monaco.languages.CompletionItem {
  const label = typeof item.label === 'string' ? item.label : item.label.label
  return {
    label,
    kind: lspCompletionKindToMonaco(item.kind),
    detail: item.detail,
    documentation: item.documentation
      ? typeof item.documentation === 'string'
        ? item.documentation
        : { value: item.documentation.value, isTrusted: false }
      : undefined,
    insertText: item.insertText ?? label,
    range: item.textEdit && 'range' in item.textEdit
      ? lspRangeToMonaco(item.textEdit.range)
      : defaultRange,
    sortText: item.sortText,
    filterText: item.filterText,
  }
}

function registerCompletion(
  languageId: string,
  connection: LspConnection,
  triggerChars: string[]
): monaco.IDisposable {
  return monaco.languages.registerCompletionItemProvider(languageId, {
    triggerCharacters: triggerChars,
    async provideCompletionItems(model, position) {
      try {
        const result = await connection.sendRequest<CompletionList | CompletionItem[] | null>(
          'textDocument/completion',
          {
            textDocument: { uri: modelUri(model) },
            position: toPosition(position),
          }
        )
        if (!result) return { suggestions: [] }

        const items: CompletionItem[] = Array.isArray(result) ? result : result.items
        const word = model.getWordUntilPosition(position)
        const defaultRange: monaco.IRange = {
          startLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        }

        return {
          suggestions: items.map((item) => lspItemToMonaco(item, defaultRange)),
          incomplete: !Array.isArray(result) && result.isIncomplete,
        }
      } catch {
        return { suggestions: [] }
      }
    },
  })
}

// ── Signature help ────────────────────────────────────────

function registerSignatureHelp(
  languageId: string,
  connection: LspConnection,
  triggerChars: string[]
): monaco.IDisposable {
  return monaco.languages.registerSignatureHelpProvider(languageId, {
    signatureHelpTriggerCharacters: triggerChars,
    async provideSignatureHelp(model, position) {
      try {
        const result = await connection.sendRequest<SignatureHelp | null>(
          'textDocument/signatureHelp',
          {
            textDocument: { uri: modelUri(model) },
            position: toPosition(position),
          }
        )
        if (!result || result.signatures.length === 0) return null

        return {
          value: {
            signatures: result.signatures.map((sig) => ({
              label: sig.label,
              documentation: sig.documentation
                ? typeof sig.documentation === 'string'
                  ? { value: sig.documentation }
                  : sig.documentation
                : undefined,
              parameters: (sig.parameters ?? []).map((p) => ({
                label: p.label,
                documentation: p.documentation
                  ? typeof p.documentation === 'string'
                    ? { value: p.documentation }
                    : p.documentation
                  : undefined,
              })),
            })),
            activeSignature: result.activeSignature ?? 0,
            activeParameter: result.activeParameter ?? 0,
          },
          dispose() {},
        }
      } catch {
        return null
      }
    },
  })
}

// ── References ────────────────────────────────────────────

function registerReferences(
  languageId: string,
  connection: LspConnection
): monaco.IDisposable {
  return monaco.languages.registerReferenceProvider(languageId, {
    async provideReferences(model, position, context) {
      try {
        const result = await connection.sendRequest<Location[] | null>(
          'textDocument/references',
          {
            textDocument: { uri: modelUri(model) },
            position: toPosition(position),
            context: { includeDeclaration: context.includeDeclaration },
          }
        )
        if (!result) return []
        return result.map((loc) => ({
          uri: monaco.Uri.parse(loc.uri),
          range: lspRangeToMonaco(loc.range),
        }))
      } catch {
        return []
      }
    },
  })
}

// ── Document highlight ────────────────────────────────────

const HIGHLIGHT_KIND_MAP: Record<number, monaco.languages.DocumentHighlightKind> = {
  1: monaco.languages.DocumentHighlightKind.Text,
  2: monaco.languages.DocumentHighlightKind.Read,
  3: monaco.languages.DocumentHighlightKind.Write,
}

function registerDocumentHighlight(
  languageId: string,
  connection: LspConnection
): monaco.IDisposable {
  return monaco.languages.registerDocumentHighlightProvider(languageId, {
    async provideDocumentHighlights(model, position) {
      try {
        const result = await connection.sendRequest<DocumentHighlight[] | null>(
          'textDocument/documentHighlight',
          {
            textDocument: { uri: modelUri(model) },
            position: toPosition(position),
          }
        )
        if (!result) return []
        return result.map((h) => ({
          range: lspRangeToMonaco(h.range),
          kind: HIGHLIGHT_KIND_MAP[h.kind ?? 1],
        }))
      } catch {
        return []
      }
    },
  })
}

// ── Suppress Monaco built-in TS validation ────────────────

/**
 * When the TypeScript/JavaScript LSP is connected, turn off Monaco's built-in
 * semantic checker. Its browser-side TypeScript worker has no access to
 * node_modules, so it produces false "cannot find module" errors on every
 * import. Syntax validation is kept on so basic parse errors still highlight
 * before the LSP responds.
 */
function suppressBuiltInTsValidation(): void {
  const opts = { noSemanticValidation: true, noSyntaxValidation: false }
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(opts)
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(opts)
}

// ── Public API ────────────────────────────────────────────

const DEFAULT_COMPLETION_TRIGGERS = ['.', '"', "'", '`', '/', '@', '<', '#']
const DEFAULT_SIGNATURE_TRIGGERS = ['(', ',', '<']

const TS_LANGUAGES = new Set(['typescript', 'javascript'])

/**
 * Register Monaco language providers backed by the given LSP connection.
 * Returns a cleanup function that disposes all providers and diagnostics.
 *
 * Only registers providers for capabilities the server has declared.
 */
export function registerProviders(
  languageId: string,
  connection: LspConnection,
  capabilities: ServerCapabilities
): () => void {
  const disposables: Array<{ dispose(): void } | (() => void)> = []

  // For TS/JS, disable Monaco's built-in semantic checker so LSP diagnostics
  // are the single source of truth.
  if (TS_LANGUAGES.has(languageId)) {
    suppressBuiltInTsValidation()
  }

  // Diagnostics are always subscribed to (servers push them regardless of capability)
  disposables.push(setupDiagnostics(connection))

  if (capabilities.hoverProvider) {
    disposables.push(registerHover(languageId, connection))
  }

  if (capabilities.definitionProvider) {
    disposables.push(registerDefinition(languageId, connection))
  }

  if (capabilities.referencesProvider) {
    disposables.push(registerReferences(languageId, connection))
  }

  if (capabilities.documentHighlightProvider) {
    disposables.push(registerDocumentHighlight(languageId, connection))
  }

  if (capabilities.completionProvider) {
    const triggers =
      capabilities.completionProvider.triggerCharacters ?? DEFAULT_COMPLETION_TRIGGERS
    disposables.push(registerCompletion(languageId, connection, triggers))
  }

  if (capabilities.signatureHelpProvider) {
    const triggers =
      capabilities.signatureHelpProvider.triggerCharacters ?? DEFAULT_SIGNATURE_TRIGGERS
    disposables.push(registerSignatureHelp(languageId, connection, triggers))
  }

  return () => {
    for (const d of disposables) {
      if (typeof d === 'function') d()
      else d.dispose()
    }
  }
}
