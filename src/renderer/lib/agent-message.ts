export type AgentContext =
  | {
      kind: 'editor'
      filePath: string
      selectedText: string
      lineRange: [number, number]
    }
  | {
      kind: 'diff'
      filePath: string
      commitHash: string | null
      side: 'original' | 'modified'
      selectedText: string
      lineRange: [number, number]
    }

export function buildAgentMessage(ctx: AgentContext, userMessage: string): string {
  const parts: string[] = []

  if (ctx.kind === 'editor') {
    parts.push(`[File: ${ctx.filePath}, lines ${ctx.lineRange[0]}-${ctx.lineRange[1]}]`)
  } else {
    const ref = ctx.commitHash ? `commit ${ctx.commitHash.slice(0, 7)}` : 'uncommitted changes'
    parts.push(`[Diff: ${ref} — ${ctx.filePath} (${ctx.side}), lines ${ctx.lineRange[0]}-${ctx.lineRange[1]}]`)
  }

  if (ctx.selectedText.trim()) {
    parts.push('', '```', ctx.selectedText, '```')
  }

  if (userMessage.trim()) {
    parts.push('', userMessage.trim())
  }

  return parts.join('\n')
}
