/** Lines kept above and below a thread's snippet, for re-anchoring it after edits. */
const CONTEXT_LINES = 3

/** The anchored code and its surroundings, read from the editor model at the moment of commenting. */
export interface AnchorLines {
  startLine: number
  endLine: number
  snippet: string
  before: string
  after: string
}

interface LineSource {
  getLineCount(): number
  getLineContent(line: number): string
}

function joinLines(model: LineSource, from: number, to: number): string {
  const out: string[] = []
  for (let l = from; l <= to; l++) out.push(model.getLineContent(l))
  return out.join('\n')
}

/**
 * Whole lines for a selection. A selection that ends at the start of a line
 * (a triple-click, or dragging to the next line) doesn't include that line.
 */
export function anchorLines(
  model: LineSource,
  selection: { startLineNumber: number; endLineNumber: number; endColumn: number },
): AnchorLines {
  const count = model.getLineCount()
  const startLine = Math.min(Math.max(selection.startLineNumber, 1), count)
  let endLine = Math.min(Math.max(selection.endLineNumber, startLine), count)
  if (endLine > startLine && selection.endColumn === 1) endLine--
  return {
    startLine,
    endLine,
    snippet: joinLines(model, startLine, endLine),
    before: joinLines(model, Math.max(1, startLine - CONTEXT_LINES), startLine - 1),
    after: joinLines(model, endLine + 1, Math.min(count, endLine + CONTEXT_LINES)),
  }
}
