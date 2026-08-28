/**
 * A spoken brief, and the two things every surface has to derive from it.
 *
 * Shared because both ends need the same answers and must not disagree: main
 * derives the session's label when it applies the brief, and the phone shows
 * the user what that label will be before they commit to it. A second copy of
 * `labelFromBrief` in the web bundle would let the preview drift from the
 * name that actually appears in the list.
 */

/** Longest label we will mint. Past this the sidebar truncates anyway. */
const LABEL_MAX = 42

/**
 * Below this many words a brief tends to come back as a clarifying question,
 * which is the failure this whole surface exists to avoid: a session created
 * blocked has filled a parallel slot with nothing.
 *
 * Calibrated on the shape of a usable brief — what to change, where, and how
 * you would know it worked — which does not fit in fewer.
 */
const THIN_BRIEF_WORDS = 15

/**
 * Where a first clause ends.
 *
 * Punctuation only counts when whitespace or the end follows it, so the dots
 * and colons inside `src/main/pty.ts:308` — which is exactly the kind of thing
 * a brief names — do not cut the label in half.
 */
const CLAUSE_BREAK = /[.!?;:](?=\s|$)|\n|,\s|\s[—–-]\s/

export function wordCount(brief: string): number {
  const words = brief.trim().split(/\s+/).filter(Boolean)
  return words.length
}

/**
 * The sidebar name for a session started from a brief: its first clause.
 *
 * Returns null when there is nothing worth naming, so the caller falls back to
 * whatever it would have used with no label at all rather than pinning the
 * session to an empty string. Short-lived either way — the agent's OSC title
 * replaces it as soon as the conversation has one.
 */
export function labelFromBrief(brief: string): string | null {
  const flat = brief.replace(/\s+/g, ' ').trim()
  if (!flat) return null

  const [clause] = flat.split(CLAUSE_BREAK)
  let label = (clause ?? flat).trim()
  if (!label) label = flat

  if (label.length > LABEL_MAX) {
    const cut = label.slice(0, LABEL_MAX)
    // Prefer a word boundary, but only when one is late enough that the label
    // still says something — otherwise take the hard cut.
    const lastSpace = cut.lastIndexOf(' ')
    label = `${(lastSpace > LABEL_MAX / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
  }
  return label || null
}

/**
 * A nudge toward a brief the agent can act on, or null when it looks complete.
 *
 * A nudge, never a gate. The user is on a treadmill and knows what they meant;
 * refusing to start on a word count would be the surface deciding it knows
 * better, and a wrong refusal costs more than a thin brief does.
 */
export function briefNudge(brief: string): string | null {
  const words = wordCount(brief)
  if (words === 0 || words >= THIN_BRIEF_WORDS) return null
  return 'Thin brief — the agent will probably come back with a question instead of work. Say which area to change, what should change, and how you would know it worked.'
}
