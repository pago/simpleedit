import type { ReviewFinding } from '../../shared/ipc-types'

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
  | {
      kind: 'finding'
      finding: ReviewFinding
      commitHash: string | null
    }
  /**
   * A block of an agent-composed panel. No file/line anchor on purpose — a
   * Diagram or DiffBlock can span many files, so an anchor would be false
   * precision. The block's content travels instead: Discuss may spawn a new
   * session that never saw the panel, and a bare block id would be meaningless
   * to it.
   */
  | {
      kind: 'block'
      blockId: string
      blockType: string
      content: string
      selectedText: string
    }

export function buildAgentMessage(ctx: AgentContext, userMessage: string): string {
  const parts: string[] = []

  if (ctx.kind === 'editor') {
    parts.push(`[File: ${ctx.filePath}, lines ${ctx.lineRange[0]}-${ctx.lineRange[1]}]`)
    if (ctx.selectedText.trim()) {
      parts.push('', '```', ctx.selectedText, '```')
    }
  } else if (ctx.kind === 'diff') {
    const ref = ctx.commitHash ? `commit ${ctx.commitHash.slice(0, 7)}` : 'uncommitted changes'
    parts.push(`[Diff: ${ref} — ${ctx.filePath} (${ctx.side}), lines ${ctx.lineRange[0]}-${ctx.lineRange[1]}]`)
    if (ctx.selectedText.trim()) {
      parts.push('', '```', ctx.selectedText, '```')
    }
  } else if (ctx.kind === 'block') {
    parts.push(`[Panel block: ${ctx.blockType} "${ctx.blockId}"]`)
    const selected = ctx.selectedText.trim()
    const content = ctx.content.trim()
    if (selected) {
      parts.push('', 'Selected:', '```', ctx.selectedText, '```')
    }
    if (content && content !== selected) {
      parts.push('', 'Block content:', ctx.content)
    }
  } else {
    const ref = ctx.commitHash ? `commit ${ctx.commitHash.slice(0, 7)}` : 'uncommitted changes'
    const dec = ctx.finding.decoration ? ` (${ctx.finding.decoration})` : ''
    parts.push(
      `[Review finding: ${ctx.finding.label}${dec} — ${ctx.finding.file}, lines ${ctx.finding.lineRange[0]}-${ctx.finding.lineRange[1]}, ${ref}]`,
      '',
      `**${ctx.finding.title}**`,
      '',
      ctx.finding.body,
    )
  }

  if (userMessage.trim()) {
    parts.push('', userMessage.trim())
  }

  return parts.join('\n')
}
