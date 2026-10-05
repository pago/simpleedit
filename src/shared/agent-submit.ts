const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/**
 * The one PTY write that puts `text` into an agent's prompt and submits it.
 *
 * Sent bare, a reply plus Enter is read as a paste, and Claude Code and Codex
 * absorb the trailing CR into it, leaving the reply in the prompt. Splitting it
 * into two writes only helps while the agent reads them separately, which a
 * busy event loop does not. Bracketed-paste markers end the paste explicitly,
 * so the CR after them is a keypress however the bytes are read. Claude Code,
 * Codex and OpenCode all enable bracketed paste (`ESC[?2004h`); a plain shell
 * may not, so this is for agent sessions only.
 *
 * Newlines inside the markers are pasted, not submitted. Markers inside the
 * text are dropped so it cannot end the paste early.
 */
export function agentSubmitWrite(text: string): string {
  const body = text.split(PASTE_START).join('').split(PASTE_END).join('').replace(/\r\n?/g, '\n')
  return `${PASTE_START}${body}${PASTE_END}\r`
}
