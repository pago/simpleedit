import { test as base, expect, chromium, _electron as electron } from '@playwright/test'
import type { Browser, ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { execFileSync } from 'child_process'
import {
  MAIN,
  launchEnv,
  createTempRepo,
  removeTempRepo,
  spawnTerminalSession,
  type TempRepo,
} from './fixtures'
import type { RemoteAccessStatus, SttStatus } from '../src/shared/ipc-types'

/**
 * The whole dictation pipeline, in a real browser against a real app.
 *
 * Mic permission → `MediaRecorder` capture → WAV conversion in the page →
 * transcription on the Mac → transcript in the composer → an edit → send →
 * the reply appearing in the terminal. `http://127.0.0.1` is a secure context,
 * so `getUserMedia` opens here exactly as it does over Tailscale HTTPS on a
 * phone; only the TLS in front differs.
 *
 * Chromium's fake capture device plays a WAV file into `getUserMedia`, so the
 * audio is deterministic. macOS `say` supplies the speech, which means the
 * assertion is on a phrase that was genuinely spoken, encoded, uploaded and
 * transcribed rather than on a fixture that skipped a step.
 *
 * Skipped unless whisper.cpp and a model are actually present — this is the
 * one test that cannot be faked without testing nothing, and the feature is
 * explicitly designed to degrade rather than fail when they are absent.
 */

const SANDBOX_ARGS = process.env.CI ? ['--no-sandbox'] : []

const SPOKEN = 'Rebase once more before you merge'

/** Homebrew's `whisper-cpp` formula installs the first; older builds the second. */
const WHISPER_BINARIES = ['whisper-cli', 'whisper-cpp']

function onPath(binary: string): boolean {
  try {
    execFileSync('/bin/sh', ['-c', `command -v ${binary}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * The model this MACHINE has, not the one someone remembered to export.
 *
 * The app already knows: the model file is a setting, and the settings pane
 * writes it to the remote-access config. An env var that has to be set by hand
 * is not a gate, it is an opt-in — and one nobody opts into, so the test
 * silently never runs.
 */
function configuredModel(): string {
  const override = process.env.SIMPLEEDIT_WHISPER_MODEL
  if (override) return override
  // The app's own userData directory. Two names, because a packaged build and
  // one launched from source do not agree on it.
  for (const name of ['simpleedit', 'Electron']) {
    const config = path.join(os.homedir(), 'Library', 'Application Support', name, 'config', 'remote.json')
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(config, 'utf8'))
      const stored = (parsed as { sttModelPath?: unknown }).sttModelPath
      if (typeof stored === 'string' && stored) return stored
    } catch {
      /* no config, or not readable — try the next */
    }
  }
  return ''
}

/**
 * Everything this test needs, checked rather than assumed.
 *
 * Missing pieces produce a skip that names them. Previously an absent `ffmpeg`
 * threw out of the fixture with nothing to explain it, and an unset env var
 * short-circuited before whisper was even looked for — so an installed whisper
 * made no difference at all.
 */
function requirements(): { ok: boolean; model: string; reason: string } {
  const model = configuredModel()
  const missing: string[] = []
  // `say` is the speech source, so this is a macOS test whatever else is here.
  if (process.platform !== 'darwin') missing.push('macOS (for `say`)')
  if (!WHISPER_BINARIES.some(onPath)) missing.push('`brew install whisper-cpp`')
  if (!onPath('ffmpeg')) missing.push('`brew install ffmpeg`')
  if (!model) missing.push('a whisper model — pick one in Settings › Remote access › Dictation')
  else if (!fs.existsSync(model)) missing.push(`a readable model at ${model}`)
  return {
    ok: missing.length === 0,
    model,
    reason: `Dictation E2E needs: ${missing.join('; ')}`,
  }
}

const REQUIRED = requirements()

/** A WAV of `SPOKEN`, synthesised once per run. Chromium loops it as the mic. */
function speechFixture(): string {
  const wav = path.join(os.tmpdir(), `simpleedit-speech-${process.pid}.wav`)
  if (fs.existsSync(wav)) return wav
  const aiff = wav.replace(/\.wav$/, '.aiff')
  execFileSync('say', ['-o', aiff, SPOKEN])
  // Chromium's fake capture reads 16-bit PCM WAV; `say` emits AIFF.
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', wav])
  fs.rmSync(aiff, { force: true })
  return wav
}

type Fixtures = {
  repo: TempRepo
  remoteConfig: string
  app: ElectronApplication
  window: Page
  browser: Browser
}

const test = base.extend<Fixtures>({
  repo: async ({}, use) => {
    const repo = createTempRepo('simpleedit-voice-')
    await use(repo)
    removeTempRepo(repo)
  },
  remoteConfig: async ({}, use) => {
    const file = path.join(os.tmpdir(), `simpleedit-voice-remote-${process.pid}.json`)
    // The model is a setting, so it is set the way the settings pane sets it.
    fs.writeFileSync(
      file,
      JSON.stringify({ enabled: false, host: '127.0.0.1', port: 0, sttModelPath: REQUIRED.model }),
    )
    await use(file)
    fs.rmSync(file, { force: true })
  },
  app: async ({ repo, remoteConfig }, use) => {
    const app = await electron.launch({
      args: [MAIN, ...SANDBOX_ARGS],
      env: launchEnv({
        SIMPLEEDIT_REPO: repo.bareRepoPath,
        SIMPLEEDIT_E2E_REMOTE_CONFIG: remoteConfig,
      }),
    })
    await use(app)
    await app.close()
  },
  window: async ({ app }, use) => {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await use(page)
  },
  browser: async ({}, use) => {
    const browser = await chromium.launch({
      // The full Chromium build, not the default headless shell: the shell has
      // no media capture at all, so `getUserMedia` rejects with
      // `NotSupportedError` before any of this feature is reached.
      channel: 'chromium',
      args: [
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${speechFixture()}`,
      ],
    })
    await use(browser)
    await browser.close()
  },
})

type Api = {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  on: (channel: string, cb: (data: unknown) => void) => () => void
}

test.skip(!REQUIRED.ok, REQUIRED.reason)

// The suite-wide 30 s covers fixture setup too — an Electron launch, a temp
// repo, a Chromium launch, and synthesising the speech — before 2.6 s of
// recording and a whisper run have even started.
test.describe.configure({ mode: 'serial', timeout: 180_000 })

test('speaks a reply, reviews it, sends it, and sees it in the terminal', async ({ window, browser }) => {
  const terminalId = await spawnTerminalSession(window)

  // Main agrees dictation is possible before anything is recorded.
  const stt = (await window.evaluate(() =>
    (window as unknown as { api: Api }).api.invoke('stt:status'),
  )) as SttStatus
  expect(stt).toMatchObject({ installed: true, modelReady: true, ready: true, hint: null })

  const status = (await window.evaluate(() =>
    (window as unknown as { api: Api }).api.invoke('remote:set-enabled', true),
  )) as RemoteAccessStatus
  const url = new URL(status.url!)
  url.hostname = 'localhost'

  // The permission gate is real: without this grant `getUserMedia` rejects and
  // the composer says so instead of recording silence.
  const context = await browser.newContext({ permissions: ['microphone'] })
  const page = await context.newPage()
  await page.goto(url.toString())

  await page.locator(`[data-testid="session-row"][data-session-id="${terminalId}"]`).click()
  await expect(page.getByTestId('mobile-terminal')).toBeVisible()

  // ── capture ───────────────────────────────────────────────
  await page.getByTestId('mic-start').click()
  await expect(page.getByTestId('mic-stop')).toBeVisible()
  // Long enough for the whole phrase; the fake device loops, so not much more.
  await page.waitForTimeout(2600)
  await page.getByTestId('mic-stop').click()

  // ── upload + transcribe ───────────────────────────────────
  await expect(page.getByTestId('transcribing')).toBeVisible({ timeout: 5_000 })
  await expect(page.getByTestId('transcribing')).toHaveCount(0, { timeout: 60_000 })
  await expect(page.getByTestId('composer-error')).toHaveCount(0)

  // ── review ────────────────────────────────────────────────
  // The transcript lands in the field and nowhere else. Nothing has reached the
  // PTY at this point, which is the guarantee this step exists for.
  const field = page.getByTestId('composer-text')
  await expect(field).toHaveValue(/rebase/i, { timeout: 5_000 })
  await expect(page.locator('.xterm-rows')).not.toContainText('Rebase once more')

  // ── edit, then send ───────────────────────────────────────
  const transcript = (await field.inputValue()).trim()
  await field.fill(`echo ${JSON.stringify(transcript)}`)
  await page.getByTestId('composer-send').click()

  // ── the reply appears in the terminal ─────────────────────
  await expect(page.locator('.xterm-rows')).toContainText(/rebase once more before you merge/i, {
    timeout: 20_000,
  })
  await expect(field).toHaveValue('')

  await context.close()
  await window.evaluate(() => (window as unknown as { api: Api }).api.invoke('remote:set-enabled', false))
})

// Back is a swipe on a phone. Mid-sentence, it must ask rather than silently
// throw the recording away — and a confirmed discard must destroy the audio,
// not upload it for a screen nobody is on any more.
test('Back mid-recording asks first, and a confirmed discard transcribes nothing', async ({ window, browser }) => {
  const terminalId = await spawnTerminalSession(window)
  const status = (await window.evaluate(() =>
    (window as unknown as { api: Api }).api.invoke('remote:set-enabled', true),
  )) as RemoteAccessStatus
  const url = new URL(status.url!)
  url.hostname = 'localhost'

  const context = await browser.newContext({ permissions: ['microphone'] })
  const page = await context.newPage()
  const transcribes: string[] = []
  page.on('websocket', (ws) =>
    ws.on('framesent', (frame) => {
      if (typeof frame.payload === 'string' && frame.payload.includes('stt:transcribe')) transcribes.push(frame.payload)
    }),
  )
  await page.goto(url.toString())
  await page.locator(`[data-testid="session-row"][data-session-id="${terminalId}"]`).click()
  await expect(page.getByTestId('mobile-terminal')).toBeVisible()

  await page.getByTestId('mic-start').click()
  await expect(page.getByTestId('mic-stop')).toBeVisible()

  await page.goBack()
  await expect(page.getByTestId('recording-discard-confirm')).toBeVisible()
  // Kept: still on the session, still recording.
  await page.getByRole('button', { name: 'Keep' }).click()
  await expect(page.getByTestId('mic-stop')).toBeVisible()
  // Long enough that there IS audio to leak. A recorder stopped within its
  // first second can hand over nothing, and the assertion below would then
  // pass with the discard wired to the keeping path.
  await page.waitForTimeout(1500)

  await page.goBack()
  await page.getByTestId('recording-discard-confirmed').click()
  await expect(page.getByTestId('screen-title')).toHaveText('Sessions')
  await page.waitForTimeout(4000)
  expect(transcribes).toEqual([])

  await context.close()
  await window.evaluate(() => (window as unknown as { api: Api }).api.invoke('remote:set-enabled', false))
})
