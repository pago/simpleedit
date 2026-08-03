import type { ElectronApplication } from '@playwright/test'
import { test, expect } from './fixtures'

/**
 * The update banner renders above the title bar, where the macOS traffic lights
 * float over the web content, and it is the only surface reporting updater
 * failures — a "Restart & Update" button that can't restart must say so rather
 * than look dead.
 */

async function sendUpdateEvent(
  app: ElectronApplication,
  channel: string,
  payload: unknown
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, { channel, payload }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(channel, payload)
      }
    },
    { channel, payload }
  )
}

test('update banner sits above the title bar, clear of the traffic lights', async ({
  app,
  window
}) => {
  await sendUpdateEvent(app, 'update:downloaded', { version: '9.9.9' })

  const banner = window.getByText('Version 9.9.9 is ready to install.')
  await expect(banner).toBeVisible()

  // The banner is above the title bar, so it — not the title bar — is what the
  // traffic lights overlap, and they occupy the first ~78px of the window.
  const bannerBox = await banner.boundingBox()
  const titleBarBox = await window.locator('.drag-region').first().boundingBox()
  expect(bannerBox).not.toBeNull()
  expect(titleBarBox).not.toBeNull()
  expect(bannerBox!.y).toBeLessThan(titleBarBox!.y)
  expect(bannerBox!.x).toBeGreaterThanOrEqual(78)
})

test('the dev-build guard reports why it cannot install', async ({ app, window }) => {
  await sendUpdateEvent(app, 'update:downloaded', { version: '9.9.9' })
  await expect(window.getByRole('button', { name: 'Restart & Update' })).toBeVisible()

  // Playwright launches out/main/index.js under the dev Electron binary, so
  // app.isPackaged is false and the install handler must refuse, with a reason.
  await window.getByRole('button', { name: 'Restart & Update' }).click()

  await expect(window.getByText(/only be installed from a packaged build/)).toBeVisible()
  await expect(window.getByRole('button', { name: 'Download manually' })).toBeVisible()
})

// A Homebrew copy cannot be replaced by Squirrel, so the banner offers the
// detached-helper path instead of a restart that could never work.
test('a Homebrew install is offered the brew upgrade instead of a restart', async ({
  app,
  window
}) => {
  await sendUpdateEvent(app, 'update:available', { version: '9.9.9', managedByHomebrew: true })

  await expect(window.getByText(/Version 9\.9\.9 is available via Homebrew/)).toBeVisible()
  await expect(window.getByRole('button', { name: 'Update & Restart' })).toBeVisible()
  await expect(window.getByRole('button', { name: 'Copy command' })).toBeVisible()
  await expect(window.getByRole('button', { name: 'Restart & Update' })).toHaveCount(0)
})

// The helper runs while the app is closed, so this is the only chance to tell the
// user it went wrong — and it has to raise the banner with no update event first.
test('a background upgrade failure surfaces on the next launch', async ({ app, window }) => {
  await sendUpdateEvent(app, 'update:homebrew-failed', {
    version: '9.9.9',
    message: 'brew exited with status 17'
  })

  await expect(window.getByText(/could not be installed: brew exited with status 17/)).toBeVisible()
  await expect(window.getByRole('button', { name: 'Show log' })).toBeVisible()
  // The command stays available as the manual fallback.
  await expect(window.getByText('brew upgrade --cask pago/simpleedit/simpleedit')).toBeVisible()
})

test('a staging failure replaces the dead restart button', async ({ app, window }) => {
  await sendUpdateEvent(app, 'update:downloaded', { version: '9.9.9' })
  await expect(window.getByRole('button', { name: 'Restart & Update' })).toBeVisible()

  await sendUpdateEvent(app, 'update:error', {
    message: 'code failed to satisfy specified code requirement(s)',
    phase: 'prepare'
  })

  await expect(window.getByText(/code requirement/)).toBeVisible()
  await expect(window.getByRole('button', { name: 'Restart & Update' })).toHaveCount(0)
  await expect(window.getByRole('button', { name: 'Retry restart' })).toBeVisible()
})
