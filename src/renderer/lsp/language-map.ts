/**
 * Monaco language IDs that have a language server configured.
 * Maps monaco languageId → LSP server language key (used in lsp:start).
 */
export const LSP_SUPPORTED_LANGUAGES: ReadonlySet<string> = new Set([
  'typescript',
  'javascript',
  'rust',
  'python',
  'go',
  'css',
  'scss',
  'less',
  'json',
])

/** Client capabilities we advertise to all language servers. */
export const CLIENT_CAPABILITIES = {
  textDocument: {
    hover: {
      contentFormat: ['markdown', 'plaintext'],
    },
    definition: {
      linkSupport: false,
    },
    completion: {
      completionItem: {
        snippetSupport: false,
        documentationFormat: ['markdown', 'plaintext'],
      },
    },
    signatureHelp: {
      signatureInformation: {
        documentationFormat: ['markdown', 'plaintext'],
      },
    },
    publishDiagnostics: {
      relatedInformation: false,
    },
    synchronization: {
      // Full sync: we send the entire document on every change
      didSave: false,
      willSave: false,
    },
  },
  workspace: {
    applyEdit: false,
  },
}
