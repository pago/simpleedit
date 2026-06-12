import { test, expect } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { MAIN, launchEnv, spawnTerminalSession, clearSavedSessionFile, createTempRepo, removeTempRepo } from './fixtures'

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []
const repoPath = process.env.SIMPLEEDIT_TEST_REPO

test.describe('Terminal drag-and-drop', () => {
  test.skip(!repoPath, 'Set SIMPLEEDIT_TEST_REPO to run terminal-drop tests')

  let app: ElectronApplication
  let window: Page

  let repo: ReturnType<typeof createTempRepo>
  test.beforeAll(() => {
    repo = createTempRepo('simpleedit-e2e-')
  })
  test.afterAll(() => {
    removeTempRepo(repo)
  })

  test.beforeEach(async () => {
    clearSavedSessionFile(repo.bareRepoPath)
    app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: launchEnv({ SIMPLEEDIT_REPO: repo.bareRepoPath })
    })
    window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
  })

  test.afterEach(async () => {
    await app.close()
  })

  test('writes the dropped file path into the PTY', async () => {
    // The agent-first UI has no auto-spawned terminal — create one first.
    await spawnTerminalSession(window)
    await window.waitForSelector('[data-testid="terminal-drop-target"]')
    // Let the PTY spawn settle so the shell prompt is rendered.
    await window.waitForTimeout(1500)

    // Capture all pty:data so we can assert the path is echoed by the shell.
    // contextBridge freezes window.api, so we observe instead of spy.
    await window.evaluate(() => {
      ;(window as unknown as { __ptyData: string }).__ptyData = ''
      window.api.on('pty:data', (payload) => {
        ;(window as unknown as { __ptyData: string }).__ptyData += payload.data
      })
    })

    // Dispatch a synthetic drop. Synthesized File has no filesystem path, so
    // the handler falls back to app:save-dropped-blob → temp path → pty:write.
    // Chromium ignores `dataTransfer` passed to DragEvent's constructor, so we
    // attach it via defineProperty after construction.
    await window.evaluate(() => {
      const pngHeader = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
      const file = new File([pngHeader], 'screenshot.png', { type: 'image/png' })
      const dt = new DataTransfer()
      dt.items.add(file)
      const target = document.querySelector('[data-testid="terminal-drop-target"]')!
      const event = new Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: dt })
      target.dispatchEvent(event)
    })

    await window.waitForFunction(
      () => /simpleedit-drops.*screenshot.*\.png/.test(
        (window as unknown as { __ptyData: string }).__ptyData
      ),
      undefined,
      { timeout: 5000 }
    )
  })
})
