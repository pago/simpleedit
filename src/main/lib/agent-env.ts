/**
 * The environment every process SimpleEdit launches for an agent or a terminal
 * starts from: its own `process.env` minus the variables a Claude Code session
 * puts in its children's environment.
 *
 * Started from inside a Claude Code session, SimpleEdit inherits that session's
 * identity. A `claude` launched with it believes it is that session's child and
 * never writes its own transcript, so a later Resume finds nothing (#204).
 *
 * A denylist, not a `CLAUDE*` prefix strip: the prefix also covers user
 * configuration (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_USE_BEDROCK`, the
 * `CLAUDE_CODE_DISABLE_*` switches) that must reach the agent, while a variable
 * missing from this list only degrades to the old inherit-everything behaviour.
 */
const INHERITED_SESSION_VARS = new Set([
  'AI_AGENT',
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_KIND',
  'CLAUDE_CODE_SESSION_NAME',
  'CLAUDE_CODE_SESSION_ORIGIN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_TOOL_USE_ID',
  'CLAUDE_CODE_SPAWNED_BY_SERVER',
  'CLAUDE_CODE_SPAWN_TIMESTAMP_MS',
])

const INHERITED_SESSION_PREFIXES = ['CLAUDE_CODE_MESSAGING_']

export function isInheritedSessionVar(name: string): boolean {
  return INHERITED_SESSION_VARS.has(name) || INHERITED_SESSION_PREFIXES.some((p) => name.startsWith(p))
}

export function agentEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !isInheritedSessionVar(key)) env[key] = value
  }
  // Claude Code sets `GIT_EDITOR=true` for its own tool calls; inherited, it
  // makes a plain `git commit` in a SimpleEdit terminal abort with an empty
  // message. Only that exact value under a Claude Code parent is dropped, so a
  // user's own GIT_EDITOR survives.
  if (base['CLAUDECODE'] !== undefined && env['GIT_EDITOR'] === 'true') delete env['GIT_EDITOR']
  return env
}
