/**
 * Compile a Zod-validated sequence-diagram schema to mermaid source.
 *
 * The agent never produces mermaid DSL — it produces typed JSON that's
 * validated at the IPC boundary. This compiler is the only place that
 * speaks mermaid syntax, so a malformed agent output can never reach
 * mermaid's parser.
 */

import type { DiagramSpec } from '../../../shared/gen-ui-catalog'

type SequenceDiagram = Extract<DiagramSpec, { kind: 'sequence' }>

const ARROWS: Record<NonNullable<SequenceDiagram['messages'][number]['kind']>, string> = {
  sync: '->>',
  async: '-->>',
  return: '-->>',
}

/**
 * mermaid sequence-diagram identifiers must be a single word; labels can be
 * arbitrary text. We'd otherwise have to escape every label, so we declare
 * actors explicitly with `participant <id> as <label>` and use the id in
 * message edges.
 */
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_') || 'a'
}

function escapeLabel(label: string): string {
  return label.replace(/[\r\n]+/g, ' ').replace(/[#"`]/g, ' ')
}

export function compileSequenceDiagram(spec: SequenceDiagram): string {
  const lines: string[] = ['sequenceDiagram']

  for (const actor of spec.actors) {
    const id = safeId(actor.id)
    lines.push(`  participant ${id} as ${escapeLabel(actor.label)}`)
  }

  for (const msg of spec.messages) {
    const arrow = ARROWS[msg.kind ?? 'sync']
    const from = safeId(msg.from)
    const to = safeId(msg.to)
    lines.push(`  ${from}${arrow}${to}: ${escapeLabel(msg.label)}`)
  }

  return lines.join('\n')
}
