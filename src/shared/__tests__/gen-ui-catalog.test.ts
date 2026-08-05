import { describe, it, expect } from 'vitest'
import {
  ActionRefSchema,
  ProseBlockProps,
  FileListProps,
  CodeSnippetProps,
  DecisionCardProps,
  StatusIndicatorProps,
  KeyValueSummaryProps,
  SectionProps,
  ActionButtonProps,
  TextInputProps,
  CalloutProps,
  RowProps,
  DiagramProps,
} from '../gen-ui-catalog'

describe('ActionRefSchema', () => {
  it('accepts each enumerated capability with correct payload', () => {
    expect(ActionRefSchema.safeParse({ type: 'send_to_agent', text: 'hi' }).success).toBe(true)
    expect(ActionRefSchema.safeParse({ type: 'open_file', path: 'src/x.ts' }).success).toBe(true)
    expect(ActionRefSchema.safeParse({ type: 'open_file', path: 'a.ts', line: 12 }).success).toBe(true)
    expect(ActionRefSchema.safeParse({ type: 'show_diff', commitHash: 'abc' }).success).toBe(true)
    expect(ActionRefSchema.safeParse({ type: 'dismiss_panel' }).success).toBe(true)
    expect(ActionRefSchema.safeParse({ type: 'set_state', key: 'k', value: 1 }).success).toBe(true)
    expect(ActionRefSchema.safeParse({ type: 'focus_block', blockId: 'diff' }).success).toBe(true)
  })

  it('rejects unknown action types and missing required fields', () => {
    expect(ActionRefSchema.safeParse({ type: 'shell', cmd: 'rm -rf /' }).success).toBe(false)
    expect(ActionRefSchema.safeParse({ type: 'send_to_agent' }).success).toBe(false)
    expect(ActionRefSchema.safeParse({ type: 'send_to_agent', text: '' }).success).toBe(false)
    expect(ActionRefSchema.safeParse({ type: 'open_file', path: '', line: 1 }).success).toBe(false)
    expect(ActionRefSchema.safeParse({ type: 'open_file', path: 'a.ts', line: 0 }).success).toBe(false)
    expect(ActionRefSchema.safeParse({ type: 'show_diff' }).success).toBe(false)
    expect(ActionRefSchema.safeParse({ type: 'focus_block' }).success).toBe(false)
    expect(ActionRefSchema.safeParse({ type: 'focus_block', blockId: '' }).success).toBe(false)
  })
})

describe('primitive prop schemas — happy paths', () => {
  it('accepts ProseBlock content', () => {
    expect(ProseBlockProps.safeParse({ content: '# Heading' }).success).toBe(true)
  })

  it('accepts FileList with at least one item', () => {
    expect(
      FileListProps.safeParse({
        title: 'Failed tests',
        items: [{ path: 'src/foo.ts', status: 'error', detail: '2 failures' }],
      }).success,
    ).toBe(true)
  })

  it('accepts CodeSnippet with optional decorations', () => {
    expect(
      CodeSnippetProps.safeParse({
        language: 'ts',
        code: 'const x = 1',
        annotation: 'Setup',
        lineNumbers: true,
        maxLines: 30,
      }).success,
    ).toBe(true)
  })

  it('accepts DecisionCard with 2–5 options', () => {
    expect(
      DecisionCardProps.safeParse({
        question: 'Which approach?',
        options: [
          { label: 'A', action: { type: 'send_to_agent', text: 'a' } },
          { label: 'B', variant: 'primary', action: { type: 'send_to_agent', text: 'b' } },
        ],
      }).success,
    ).toBe(true)
  })

  it('accepts StatusIndicator/KeyValueSummary/Section/Callout/Row baselines', () => {
    expect(StatusIndicatorProps.safeParse({ kind: 'ok', label: 'Passed' }).success).toBe(true)
    expect(
      KeyValueSummaryProps.safeParse({ items: [{ label: 'Pass', value: '12', status: 'ok' }] }).success,
    ).toBe(true)
    expect(SectionProps.safeParse({ title: 'Details', defaultOpen: false }).success).toBe(true)
    expect(CalloutProps.safeParse({ variant: 'warn', body: 'be careful' }).success).toBe(true)
    expect(RowProps.safeParse({ gap: 'md', wrap: true }).success).toBe(true)
  })

  it('accepts ActionButton + TextInput shapes', () => {
    expect(
      ActionButtonProps.safeParse({
        label: 'Confirm',
        variant: 'primary',
        action: { type: 'dismiss_panel' },
      }).success,
    ).toBe(true)
    expect(
      TextInputProps.safeParse({
        bind: '/feedback',
        placeholder: 'Tell me…',
        submitAction: { type: 'send_to_agent', text: 'submit' },
      }).success,
    ).toBe(true)
  })
})

describe('primitive prop schemas — rejections', () => {
  it('rejects DecisionCard with fewer than 2 or more than 5 options', () => {
    const optA = { label: 'A', action: { type: 'dismiss_panel' as const } }
    expect(DecisionCardProps.safeParse({ question: 'Q', options: [optA] }).success).toBe(false)
    expect(
      DecisionCardProps.safeParse({
        question: 'Q',
        options: [optA, optA, optA, optA, optA, optA],
      }).success,
    ).toBe(false)
  })

  it('rejects FileList with no items', () => {
    expect(FileListProps.safeParse({ items: [] }).success).toBe(false)
  })

  it('rejects KeyValueSummary with empty items', () => {
    expect(KeyValueSummaryProps.safeParse({ items: [] }).success).toBe(false)
  })

  it('rejects unknown variants on Callout / StatusIndicator / ActionButton', () => {
    expect(CalloutProps.safeParse({ variant: 'rainbow', body: 'x' }).success).toBe(false)
    expect(StatusIndicatorProps.safeParse({ kind: 'cosmic', label: 'x' }).success).toBe(false)
    expect(
      ActionButtonProps.safeParse({
        label: 'x',
        variant: 'sparkle',
        action: { type: 'dismiss_panel' },
      }).success,
    ).toBe(false)
  })

  it('accepts Diagram graph with valid node/edge cross-references', () => {
    expect(
      DiagramProps.safeParse({
        kind: 'graph',
        nodes: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
        edges: [{ source: 'a', target: 'b' }],
      }).success,
    ).toBe(true)
  })

  it('accepts Diagram sequence with valid actor cross-references', () => {
    expect(
      DiagramProps.safeParse({
        kind: 'sequence',
        actors: [
          { id: 'u', label: 'User' },
          { id: 's', label: 'Server' },
        ],
        messages: [{ from: 'u', to: 's', label: 'request', kind: 'sync' }],
      }).success,
    ).toBe(true)
  })

  it('accepts an optional title on either Diagram variant', () => {
    expect(
      DiagramProps.safeParse({
        kind: 'graph',
        title: 'Request path',
        nodes: [{ id: 'a', label: 'A' }],
        edges: [],
      }).success,
    ).toBe(true)
    expect(
      DiagramProps.safeParse({
        kind: 'sequence',
        title: 'Handshake',
        actors: [{ id: 'u', label: 'User' }],
        messages: [{ from: 'u', to: 'u', label: 'self' }],
      }).success,
    ).toBe(true)
  })

  it('rejects Diagram with no nodes / no actors / unknown discriminator', () => {
    // graph requires at least one node
    expect(DiagramProps.safeParse({ kind: 'graph', nodes: [], edges: [] }).success).toBe(false)
    // sequence requires at least one actor and one message
    expect(
      DiagramProps.safeParse({ kind: 'sequence', actors: [], messages: [] }).success,
    ).toBe(false)
    // unknown discriminator
    expect(DiagramProps.safeParse({ kind: 'tornado' }).success).toBe(false)
  })
})
