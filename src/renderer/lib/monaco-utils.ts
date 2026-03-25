const extensionToLanguage: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript',
  '.json': 'json', '.html': 'html', '.css': 'css',
  '.scss': 'scss', '.md': 'markdown', '.svelte': 'html',
  '.py': 'python', '.rs': 'rust', '.go': 'go',
  '.sh': 'shell', '.yaml': 'yaml', '.yml': 'yaml',
  '.xml': 'xml', '.sql': 'sql', '.toml': 'ini'
}

export function getLanguage(path: string): string {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return 'plaintext'
  return extensionToLanguage[path.slice(dot).toLowerCase()] ?? 'plaintext'
}
