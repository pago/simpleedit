import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmpRoot = mkdtempSync(join(tmpdir(), 'se-prompts-test-'))
vi.mock('electron', () => ({ app: { getPath: () => tmpRoot } }))
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

const { resolveInstructions, parseOverride, promptStatus, listPrompts, readPrompt, customizePrompt, savePrompt, resetPrompt, promptPath } =
  await import('../overrides')
const { promptDefinition, PROMPTS } = await import('../registry')
const { TRIAGE_INSTRUCTIONS } = await import('../../tasks/triage-task')

const dir = join(tmpRoot, 'config', 'prompts')

function writeOverride(id: string, content: string): void {
  const path = join(dir, `${id}.md`)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

beforeEach(() => rmSync(dir, { recursive: true, force: true }))

describe('parseOverride', () => {
  it('splits frontmatter from the body', () => {
    expect(parseOverride('---\nbased-on: triage@1\nnote: mine\n---\n\nDo the thing.\n')).toEqual({
      frontmatter: [['based-on', 'triage@1'], ['note', 'mine']],
      body: 'Do the thing.',
    })
  })
  it('treats a file without frontmatter as all body', () => {
    expect(parseOverride('Just instructions.\n')).toEqual({ frontmatter: [], body: 'Just instructions.' })
  })
  it('handles CRLF line endings', () => {
    expect(parseOverride('---\r\nbased-on: triage@2\r\n---\r\nBody\r\n').body).toBe('Body')
  })
  it('does not mistake an unclosed fence for frontmatter', () => {
    expect(parseOverride('---\nno close here').frontmatter).toEqual([])
  })
})

describe('resolveInstructions', () => {
  it('uses the default when no override exists', () => {
    expect(resolveInstructions('triage')).toEqual({ text: TRIAGE_INSTRUCTIONS, source: 'default' })
  })

  it('uses the override body, without frontmatter', () => {
    writeOverride('triage', '---\nbased-on: triage@1\n---\n\nFlag only billing changes.\n')
    expect(resolveInstructions('triage')).toEqual({ text: 'Flag only billing changes.', source: 'custom', basedOn: 1 })
  })

  it('reads nested lens ids', () => {
    writeOverride('deep-review/soundness', 'Look for races only.')
    expect(resolveInstructions('deep-review/soundness')).toMatchObject({ text: 'Look for races only.', source: 'custom' })
  })

  it('falls back to the default with an error when the override is empty', () => {
    writeOverride('triage', '---\nbased-on: triage@1\n---\n\n   \n')
    const r = resolveInstructions('triage')
    expect(r.text).toBe(TRIAGE_INSTRUCTIONS)
    expect(r.source).toBe('default')
    expect(r.error).toMatch(/empty/)
  })

  it('falls back to the default with an error when the override is unreadable', () => {
    mkdirSync(join(dir, 'triage.md'), { recursive: true }) // a directory: EISDIR on read
    const r = resolveInstructions('triage')
    expect(r.text).toBe(TRIAGE_INSTRUCTIONS)
    expect(r.error).toMatch(/Couldn't read/)
  })

  it('rejects ids outside the registry', () => {
    expect(() => resolveInstructions('../models' as 'triage')).toThrow(/Unknown prompt/)
  })
})

describe('promptStatus', () => {
  it('is outdated only when customized from an older default', () => {
    expect(promptStatus({ text: 'x', source: 'custom', basedOn: 1 }, 2)).toBe('outdated')
    expect(promptStatus({ text: 'x', source: 'custom', basedOn: 2 }, 2)).toBe('custom')
    expect(promptStatus({ text: 'x', source: 'custom' }, 2)).toBe('custom')
    expect(promptStatus({ text: 'x', source: 'default' }, 2)).toBe('default')
    expect(promptStatus({ text: 'x', source: 'default', error: 'empty' }, 2)).toBe('error')
  })
})

describe('listPrompts', () => {
  it('lists every registered prompt with its status', () => {
    writeOverride('deep-review/synthesis', '---\nbased-on: deep-review/synthesis@0\n---\nMine.')
    const list = listPrompts()
    expect(list.map((p) => p.id)).toEqual(PROMPTS.map((p) => p.id))
    expect(list.find((p) => p.id === 'triage')?.status).toBe('default')
    expect(list.find((p) => p.id === 'deep-review/synthesis')).toMatchObject({ status: 'outdated', basedOn: 0 })
  })
})

describe('customize / save / reset', () => {
  it('customize seeds the default with based-on frontmatter, once', () => {
    const path = customizePrompt('triage')
    expect(path).toBe(promptPath('triage'))
    expect(readFileSync(path, 'utf-8')).toBe(`---\nbased-on: triage@${promptDefinition('triage').defaultVersion}\n---\n\n${TRIAGE_INSTRUCTIONS}\n`)
    savePrompt('triage', 'Edited.')
    customizePrompt('triage')
    expect(readPrompt('triage').text).toBe('Edited.')
  })

  it('save keeps the existing frontmatter', () => {
    writeOverride('triage', '---\nbased-on: triage@0\nowner: me\n---\nOld.')
    savePrompt('triage', 'New.')
    expect(readFileSync(promptPath('triage'), 'utf-8')).toBe('---\nbased-on: triage@0\nowner: me\n---\n\nNew.\n')
  })

  it('save seeds based-on when the file has none', () => {
    savePrompt('deep-review/tests', 'Only snapshot tests.')
    expect(resolveInstructions('deep-review/tests')).toMatchObject({ text: 'Only snapshot tests.', basedOn: 1 })
  })

  it('read returns the default when nothing is customized', () => {
    expect(readPrompt('triage')).toEqual({ text: TRIAGE_INSTRUCTIONS, defaultText: TRIAGE_INSTRUCTIONS })
  })

  it('reset removes the override, and tolerates a missing one', () => {
    customizePrompt('triage')
    resetPrompt('triage')
    expect(existsSync(promptPath('triage'))).toBe(false)
    expect(() => resetPrompt('triage')).not.toThrow()
  })
})
