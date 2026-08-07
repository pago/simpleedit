/**
 * Env applied to EVERY way SimpleEdit invokes the `opencode` binary — the
 * interactive TUI, the bounded read-only runner, and the model-catalog fetch.
 *
 * Lives here rather than in the provider so the runner and the catalog can use
 * it without importing `agents/opencode.ts`, which pulls in `electron`.
 */

/**
 * `OPENCODE_DISABLE_AUTOUPDATE` — measured on 1.18.15, a default launch takes
 * 0.99s–5.58s and the spread is the update check reaching the network; with it
 * off, 0.63–0.76s consistently. The stability half matters more: this
 * integration is pinned to a captured event stream from a known version, and
 * OpenCode upgraded itself from 1.17.13 to 1.18.15 midway through the work. A
 * catalog fetch or a lens run must not be the thing that swaps the binary out
 * from under the interactive provider.
 *
 * `OPENCODE_SERVER_PASSWORD` — cleared. The control channel talks to the
 * session's own server unauthenticated, and OpenCode nags users to set this
 * ("server is unsecured"); the login shell that launches the TUI sources the
 * profile that would set it, at which point `/api/health` and `/event` both 401
 * and the session shows a dead 'initializing' for 60s while the TUI runs fine.
 * The server is bound to loopback and exists only for this session, so the
 * password protects nothing we need.
 */
export function openCodeBaseEnv(): Record<string, string> {
  return {
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_SERVER_PASSWORD: '',
  }
}
