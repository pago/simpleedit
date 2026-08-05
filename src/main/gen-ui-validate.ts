/**
 * Main-process validation for `show_panel` specs (#62).
 *
 * Two layers of validation:
 * 1. Schema — every spec element's props validate against the catalog's Zod
 *    schema. Reject elements whose `type` references the unimplemented
 *    `Diagram` primitive (Phase 3 will replace this gate).
 * 2. Capability — every embedded ActionRef whose target is filesystem- or
 *    git-bound is verified against the active worktree before the panel
 *    opens. Out-of-worktree paths and unreachable commit hashes are
 *    rejected so the agent can self-correct, not silently route to
 *    something destructive.
 */

import { resolve, normalize, sep } from 'path'
import simpleGit, { type SimpleGit } from 'simple-git'
import { z } from 'zod'
import {
  catalog,
  ActionRefSchema,
  type ActionRef,
  type Spec,
} from '../shared/gen-ui-catalog'

export interface ValidationIssue {
  /** JSON Pointer-ish path identifying where the issue is. */
  path: string
  message: string
}

export type ValidationResult =
  | { ok: true; spec: Spec }
  | { ok: false; issues: ValidationIssue[] }

/**
 * Top-level Spec shape — root key + flat element record. We do this pre-check
 * before the catalog's full validate() so we can produce focused error
 * messages for Diagram (reserved) and missing-root before falling into the
 * deeper per-prop schema checks.
 */
const SpecShape = z.object({
  root: z.string().min(1),
  elements: z.record(
    z.string(),
    z.object({
      type: z.string().min(1),
      props: z.record(z.string(), z.unknown()).default({}),
      children: z.array(z.string()).optional(),
      visible: z.unknown().optional(),
    }),
  ),
})

/**
 * Validate a candidate spec. On success, return a parsed `Spec`. On failure,
 * return an issue list the agent can read and self-correct against.
 *
 * Caller must additionally run `validateSpecActions` for path/commit gating.
 */
export function validateSpec(input: unknown): ValidationResult {
  const shape = SpecShape.safeParse(input)
  if (!shape.success) {
    return {
      ok: false,
      issues: shape.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    }
  }
  const spec = shape.data

  if (!(spec.root in spec.elements)) {
    return {
      ok: false,
      issues: [{ path: 'root', message: `root element "${spec.root}" missing from elements map` }],
    }
  }

  const componentNames = new Set(catalog.componentNames)
  const earlyIssues: ValidationIssue[] = []

  for (const [key, el] of Object.entries(spec.elements)) {
    const at = `elements.${key}`

    if (!componentNames.has(el.type)) {
      earlyIssues.push({
        path: `${at}.type`,
        message: `unknown component type "${el.type}"`,
      })
    }

    if (el.children) {
      for (const childKey of el.children) {
        if (!(childKey in spec.elements)) {
          earlyIssues.push({
            path: `${at}.children`,
            message: `child element "${childKey}" missing from elements map`,
          })
        }
      }
    }
  }

  // Per-element prop validation. The catalog's auto-built Zod schema treats
  // `props` as opaque (because `propsOf` collapses to `record<string, unknown>`
  // when more than one component exists), so we walk the components map
  // ourselves and run each props schema against the matching element.
  const componentSchemas = catalog.data.components as unknown as Record<
    string,
    { props: z.ZodTypeAny }
  >
  const propIssues: ValidationIssue[] = []
  for (const [key, el] of Object.entries(spec.elements)) {
    const def = componentSchemas[el.type]
    if (!def) continue // unknown type already reported in earlyIssues
    const result = def.props.safeParse(el.props)
    if (!result.success) {
      for (const issue of result.error.issues) {
        propIssues.push({
          path: `elements.${key}.props.${issue.path.join('.')}`,
          message: issue.message,
        })
      }
    }
  }

  if (earlyIssues.length > 0 || propIssues.length > 0) {
    return { ok: false, issues: [...earlyIssues, ...propIssues] }
  }

  return { ok: true, spec: spec as Spec }
}

/**
 * Walk a spec's elements and yield every ActionRef embedded in their props.
 * Searches the typed surfaces we know about (FileList items, DecisionCard
 * options, ActionButton, TextInput.submitAction, etc.) generically rather
 * than hard-coding per-component knowledge — anything matching the
 * `ActionRefSchema` shape gets surfaced.
 */
function* iterateActions(spec: Spec): Generator<{ action: ActionRef; at: string }> {
  for (const [key, el] of Object.entries(spec.elements)) {
    yield* findActionsIn(el.props, `elements.${key}.props`)
  }
}

function* findActionsIn(value: unknown, at: string): Generator<{ action: ActionRef; at: string }> {
  if (value === null || typeof value !== 'object') return

  // Try to parse as an ActionRef. If it succeeds, surface it and stop
  // recursing — actions don't nest.
  const direct = ActionRefSchema.safeParse(value)
  if (direct.success) {
    yield { action: direct.data, at }
    return
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      yield* findActionsIn(value[i], `${at}.${i}`)
    }
    return
  }

  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    yield* findActionsIn(v, `${at}.${k}`)
  }
}

/**
 * Verify every ActionRef in a spec is safe to expose:
 *  - `open_file` paths must resolve inside their worktree (no `..` escape).
 *  - `show_diff` commit hashes must be reachable in their worktree's history.
 *
 * An action may name its own `worktree` — a single tour legitimately spans
 * repos, and the panel-level `worktreePath` is really just the default
 * validation scope. A named worktree must be one of `allowedWorktrees` (the
 * window's registered-repo union, the trust boundary); without that check an
 * agent could make the UI open arbitrary files outside the user's repos. When
 * the caller passes no union (unit tests, no resolver wired) membership is not
 * enforced, matching how the bridge treats an empty worktree list elsewhere.
 *
 * Other action kinds (`send_to_agent`, `dismiss_panel`, `set_state`) carry
 * no filesystem/git capability and are not gated here.
 */
export async function validateSpecActions(
  spec: Spec,
  worktreePath: string,
  allowedWorktrees: readonly string[] = [],
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = []
  const panelRoot = resolve(worktreePath)
  const allowed = new Set(allowedWorktrees.map((p) => resolve(p)))
  /** worktree root → commit hashes that must be reachable there. */
  const commitsByWorktree = new Map<string, Set<string>>()

  for (const { action, at } of iterateActions(spec)) {
    if (action.type !== 'open_file' && action.type !== 'show_diff') continue

    let root = panelRoot
    if (action.worktree) {
      root = resolve(action.worktree)
      if (allowed.size > 0 && !allowed.has(root)) {
        issues.push({
          path: `${at}.worktree`,
          message:
            `worktree "${action.worktree}" is not a worktree this window has registered ` +
            `(known: ${[...allowed].join(', ')})`,
        })
        continue
      }
    }

    if (action.type === 'open_file') {
      if (!isInsideWorktree(action.path, root)) {
        issues.push({
          path: at,
          message: action.worktree
            ? `open_file path "${action.path}" resolves outside worktree "${action.worktree}"`
            : `open_file path "${action.path}" resolves outside the active worktree`,
        })
      }
    } else {
      const hashes = commitsByWorktree.get(root) ?? new Set<string>()
      hashes.add(action.commitHash)
      commitsByWorktree.set(root, hashes)
    }
  }

  for (const [root, hashes] of commitsByWorktree) {
    // simple-git throws on construction for a missing baseDir; a spec must not
    // be able to take the panel down, so treat that as "not reachable".
    let git: SimpleGit | null = null
    try {
      git = simpleGit(root)
    } catch {
      git = null
    }
    for (const hash of hashes) {
      const reachable = await (git
        ?.raw(['cat-file', '-e', `${hash}^{commit}`])
        .then(() => true)
        .catch(() => false) ?? Promise.resolve(false))
      if (!reachable) {
        issues.push({
          path: 'action.commitHash',
          message:
            root === panelRoot
              ? `show_diff commit "${hash}" is not reachable in this worktree`
              : `show_diff commit "${hash}" is not reachable in worktree "${root}"`,
        })
      }
    }
  }

  return issues
}

function isInsideWorktree(path: string, worktreeRoot: string): boolean {
  const candidate = resolve(worktreeRoot, path)
  const root = normalize(worktreeRoot)
  // Ensure the resolved candidate is the root or a descendant. We compare
  // with a trailing separator so `/foo/bar` doesn't match `/foo/barbaz`.
  return candidate === root || candidate.startsWith(root + sep)
}
