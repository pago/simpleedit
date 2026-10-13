/**
 * Read-only preview of which model Screen PRs triage and deep review run on,
 * for the header and the "Triaging now" cards. Settings has no change event,
 * so callers refresh it on mount and whenever screening starts.
 */
let _label = $state('…')
/** The queue and the view both refresh on mount; they share one load. */
let _loading: Promise<void> | null = null

async function load(): Promise<void> {
  try {
    const [cfg, claude] = await Promise.all([window.api.invoke('models:config-get'), window.api.invoke('models:claude')])
    const m = cfg.defaults.screenPrs
    if (!m) _label = 'Haiku · default'
    else if (m.provider === 'ollama') _label = `${m.model} · local`
    // An `openai` ref may carry no model at all — that means "Codex's own default".
    else _label = claude.find((c) => c.model === m.model)?.displayName ?? m.model ?? 'Codex · default'
  } catch {
    _label = 'Haiku · default'
  }
}

export const triageModel = {
  get label(): string {
    return _label
  },
  refresh(): Promise<void> {
    _loading ??= load().finally(() => (_loading = null))
    return _loading
  },
}
