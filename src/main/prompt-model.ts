/**
 * A rough model of an agent TUI's prompt, fed by the keys the user sends, so
 * thread delivery can tell an empty prompt from a draft without reading the
 * screen.
 *
 * It only has to be right in one direction: whenever it says `empty`, the
 * prompt must really be empty and no picker may be up, because a submit then
 * goes straight in. Anything it can't follow (a recalled history entry, a moved
 * cursor, an Enter that may have opened a picker) is a draft until something
 * certain clears it: a submitted prompt, Ctrl+C, or the user vouching for it.
 */

/**
 * - `text`: something typed; `typed` counts it while each key is known to have
 *   appended, so backspacing it away empties the prompt again.
 * - `command`: a line starting with `/`, or holding an `@`, whose Enter may open
 *   a picker or accept a completion instead of submitting.
 * - `unknown`: the prompt holds something we can't follow.
 * - `picker`: an Enter on a command, or Esc-Esc, may have left a picker up; a
 *   further Enter (a choice) or Esc (a cancel) closes it.
 */
export type PromptState = 'empty' | 'text' | 'command' | 'unknown' | 'picker'

export interface PromptModel {
  state: PromptState
  typed: number | null
  /** Consecutive bare Escs: two on an empty prompt open Claude's rewind picker. */
  escs: number
}

export const EMPTY_PROMPT: PromptModel = { state: 'empty', typed: 0, escs: 0 }

export function isDraft(m: PromptModel): boolean {
  return m.state !== 'empty'
}

const TOKEN =
  /\x1b\[200~[\s\S]*?(?:\x1b\[201~|$)|\x1b\[M[\s\S]{0,3}|\x1b\[[\d;?<>=]*[ -/]*[@-~]|\x1bO[\s\S]|\x1b[\s\S]|\x1b|[\s\S]/g

export function applyKeys(model: PromptModel, data: string): PromptModel {
  let m = model
  for (const [token] of data.matchAll(TOKEN)) m = applyToken(m, token)
  return m
}

function applyToken(m: PromptModel, key: string): PromptModel {
  if (key === '\x1b') {
    const escs = m.escs + 1
    if (m.state === 'picker') return { ...EMPTY_PROMPT }
    if (m.state === 'empty' && escs >= 2) return { state: 'picker', typed: null, escs: 0 }
    return { ...m, escs }
  }
  const next = { ...m, escs: 0 }

  if (key.startsWith('\x1b[200~')) return typedUnknown(next)
  // Alt+Enter is a newline in the prompt.
  if (key === '\x1b\r') return typedUnknown(next)
  if (key.startsWith('\x1b[') || key.startsWith('\x1bO')) {
    const final = key.at(-1)
    // A mouse report, a function key, Shift+Tab and the like leave the text alone.
    if (key.startsWith('\x1b[M') || key.startsWith('\x1b[<')) return next
    if (final === 'B' && next.state === 'empty') return next
    // Up and Down recall history, which may be a command.
    if ((final === 'A' || final === 'B') && next.state !== 'picker') return { ...next, state: 'unknown', typed: null }
    if ('ABCDHF~'.includes(final ?? '') && next.state !== 'picker') return { ...next, typed: null }
    return next
  }
  // Any other Alt+key: a word motion or deletion at most.
  if (key.startsWith('\x1b')) return next.state === 'empty' || next.state === 'picker' ? next : { ...next, typed: null }

  if (key === '\r') {
    if (next.state === 'text' || next.state === 'empty' || next.state === 'picker') return { ...EMPTY_PROMPT }
    return { state: 'picker', typed: null, escs: 0 }
  }
  if (key === '\x03') return { ...EMPTY_PROMPT }
  if (key === '\x7f' || key === '\b') {
    if (next.state === 'picker' || next.typed === null) return next
    return next.typed <= 1 ? { ...EMPTY_PROMPT } : { ...next, typed: next.typed - 1 }
  }
  if (key === '\t') return next.state === 'empty' || next.state === 'picker' ? next : { ...next, typed: null }
  if (key === '\n') return typedUnknown(next)
  if (key < ' ') {
    // Ctrl+R (history search) and other control keys may open a view of their own.
    return next.state === 'empty' ? { state: 'picker', typed: null, escs: 0 } : { ...next, typed: null }
  }

  if (next.state === 'picker') return next
  if (next.state === 'empty') return { state: key === '/' || key === '@' ? 'command' : 'text', typed: 1, escs: 0 }
  // An `@` opens file completion, whose Enter picks a file instead of submitting.
  const state = key === '@' && next.state === 'text' ? 'command' : next.state
  return { ...next, state, typed: next.typed === null ? null : next.typed + 1 }
}

function typedUnknown(m: PromptModel): PromptModel {
  if (m.state === 'picker') return m
  return { ...m, state: m.state === 'empty' ? 'unknown' : m.state, typed: null }
}
