import { test, expect } from './fixtures'

/**
 * `models:claude` is answered by asking the Claude CLI (`initialize` control
 * request). The CLI is resolved through a login shell, so this runs against the
 * e2e fake in CI and may reach a real install locally — the assertions hold for
 * both: a non-empty catalog of `--model` values, without the CLI's `default`
 * entry, served well inside the discovery timeout.
 */
test('models:claude returns the CLI-discovered catalog', async ({ window }) => {
  const started = Date.now()
  const models = await window.evaluate(async () => {
    const api = (window as unknown as { api: { invoke: (channel: string) => Promise<unknown> } }).api
    return api.invoke('models:claude') as Promise<{ provider: string; model: string; displayName: string }[]>
  })

  expect(Date.now() - started).toBeLessThan(8_000)
  expect(models.length).toBeGreaterThan(0)
  for (const m of models) {
    expect(m.provider).toBe('anthropic')
    expect(m.model).toBeTruthy()
    expect(m.displayName).toBeTruthy()
  }
  expect(models.map((m) => m.model)).not.toContain('default')
})
