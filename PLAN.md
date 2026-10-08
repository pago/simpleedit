# Plan: run CI on the Node that Electron bundles

> **Plan doc, not for the PR.** `main` already tracks a stale `PLAN.md` (the
> agent-first pivot plan, last touched in #127). This file overwrites it in this
> worktree only. Decided (Decision 3): the PR's **final commit deletes `PLAN.md`**.
> That removes both the stale `main` copy and this plan, so neither ships.

## Goal

Unit tests, browser tests, typecheck and build in CI should run on the same Node
that the shipped Electron uses at runtime. One file in the repo holds the Node
version. A CI check fails when that file drifts from the Electron version in the
lockfile.

## Facts established

| What | Value | Source |
|---|---|---|
| Electron (locked) | **42.5.0** (`^42.5.0` in package.json) | `pnpm-lock.yaml` |
| Node bundled in Electron 42.5.0 | **24.17.0**, `NODE_MODULE_VERSION` 146, V8 14.8 | `ELECTRON_RUN_AS_NODE=1 electron -p process.versions` on the installed binary |
| CI Node today | `22` (ci.yml, release.yml, version.yml) | workflows |
| Local Node today | 24.21.0 (parent-folder `.tool-versions`, outside git) | `asdf list nodejs` |
| asdf has 24.17.0 available | yes (`asdf list all nodejs 24.17`) but **not installed** | asdf |
| pnpm | 10.33.0 locally. CI uses `pnpm/action-setup@v5` with `version: 10` | |

So the repo is already developed on Node 24 locally. CI on Node 22 is the outlier.
The move mostly makes CI match how the app and local dev already run.

### Where host Node actually matters (native code / runtime)

- **node-pty**: the only native addon we ship. It uses `node-addon-api` (N-API),
  and `postinstall` rebuilds it against **Electron's** headers
  (`electron-rebuild -f -w node-pty` → `bin/darwin-arm64-146/`). The host Node
  version does not affect what ships. The only unit test that touches it
  (`src/main/__tests__/pty-ownership.test.ts`) does `vi.mock('node-pty')`, so no
  test loads the addon under host Node.
- **Other `.node` binaries** (rollup, lightningcss, tailwind oxide, fsevents,
  `@electron-internal/extract-zip`) are N-API prebuilds used only by build
  tooling. They are ABI-independent and fine on Node 24.
- **Unit tests** (`vitest --project unit`, `environment: 'node'`) run main-process
  code on host Node. **This is the gap the change closes**: today that is Node 22,
  while the code runs on Node 24.17 inside Electron.
- **Browser tests** run in Playwright Chromium. Host Node only runs the vitest
  runner and Vite, so this is low impact.
- **E2E** launches the real Electron binary, so it already runs on Electron's Node.
- **MCP server** (`out/mcp-server/index.mjs`, esbuild `target: 'node20'`) is
  **not** run by Electron. `src/main/agents/{claude,codex,opencode}.ts` launch it
  with `command: 'node'`, i.e. the *end user's* system Node.
  It is out of scope here: keep `target: 'node20'` as a floor for users' machines.
  `pnpm test:integration` runs it on host Node, which is fine.
  (Possible follow-up, not in this PR: launch it with `process.execPath` +
  `ELECTRON_RUN_AS_NODE=1` so it, too, runs on Electron's Node and users no
  longer need Node installed. That changes runtime behaviour and needs its own PR.)

### Dependency engines on Node 24.17

I scanned every package in `node_modules/.pnpm` for an `engines.node` range that
excludes 24.x. **None found** (the regex hits were all open-ended `>=` ranges).
The floors that matter:

- `@electron/rebuild` `>=22.12.0`
- `electron` `>= 22.12.0`
- `vite` / `electron-vite` `^20.19.0 || >=22.12.0`
- `vitest` `^20 || ^22 || >=24`

All are satisfied.

## Decisions (all confirmed by the user, 2026-10-08)

1. **Single source of truth = repo-root `.tool-versions`** containing
   `nodejs 24.17.0`, an **exact** pin.
   - asdf reads it natively. Because it is closer than the parent-folder file, it
     overrides `simpleedit/.tool-versions` in every worktree created after this
     lands. Worktrees on older branches keep the parent's 24.21.0.
   - `actions/setup-node@v6` reads it via `node-version-file: .tool-versions`
     (it parses the `nodejs` line).
   - Why not `.nvmrc`: asdf only honours it with `legacy_version_file = yes`, so
     we would need two files or a config change.
   - **Confirmed:** the exact pin also governs local dev. Install 24.17.0 + pnpm
     under it (see Verification). A CI-only `.nvmrc` was rejected because local
     dev drifting from the runtime's Node defeats half the point.
2. **`packageManager: "pnpm@10.33.0"`** in package.json, and drop `version: 10`
   from every `pnpm/action-setup@v5` step. action-setup errors when both are
   set and disagree. pnpm 10 also self-switches to this version locally
   (`manage-package-manager-versions`, on by default).
3. **Confirmed: delete the stale tracked `PLAN.md`.** Do it as the PR's final
   commit (`git rm PLAN.md`). That one commit also keeps this plan doc out of the
   PR, so no restore step is needed.
4. **`engines.node: "^24.17.0"`**: a range, not the exact pin. It documents
   the floor. pnpm checks the root project's `engines.node` on install, so a dev on
   Node 22 gets a clear error instead of subtle test drift. The exact pin stays in
   `.tool-versions`. (Verify during implementation whether pnpm 10 errors or only
   warns for the root package without `engine-strict`. Either is acceptable.)
5. **Drift guard in CI.** Add a step in ci.yml that compares host
   `process.versions.node` with the installed Electron's
   `ELECTRON_RUN_AS_NODE=1 pnpm exec electron -p process.versions.node` and fails
   with a message naming the version to put in `.tool-versions`. This turns
   "remember to bump Node with Electron" into a red CI on the Electron-bump PR.
   - Executing the binary is the most truthful source, and CI already downloads it.
     Querying `releases.electronjs.org/releases.json` would add a network dependency.
   - On Linux the binary dynamically links libnss3/libgbm/etc. even in
     run-as-node mode. **Move the existing "Install Electron system dependencies"
     apt step up** to before the guard (it is currently just before E2E).
   - Compare the exact version. Electron patch releases bump Node patch versions,
     so every Electron patch bump means a one-line `.tool-versions` edit. That is
     the price of "same Node" and the guard makes it mechanical.
6. **Confirmed: pin `@types/node` explicitly**:
   `"@types/node": "~24.17.0"` (or the nearest published 24.x) as a devDependency.
   Today the hoisted copy is 24.13.2 (via electron's own dependency), but the
   lockfile also holds `@types/node@26.0.0` (44 references, via vite/vitest
   peers). With `shamefully-hoist=true` the hoisted pick isn't guaranteed. A lockfile
   churn could flip typecheck onto Node 26 types and allow APIs Electron's Node
   doesn't have.
7. **Out of scope:** `homebrew.yml` and the `release` job in `release.yml` use the
   runner's default Node only for `node -p`/`render-cask.mjs`. Leave them alone.

## Files to change

| File | Change |
|---|---|
| `.tool-versions` (new) | `nodejs 24.17.0` |
| `package.json` | add `"packageManager": "pnpm@10.33.0"`, `"engines": { "node": "^24.17.0" }`, `@types/node` devDep (Decision 6) |
| `pnpm-lock.yaml` | from `pnpm add -D @types/node@~24.17.0` (or nearest published 24.x) |
| `.github/workflows/ci.yml` | action-setup: remove `with: version: 10`. setup-node: `node-version` → `node-version-file: .tool-versions`. Move the apt "Install Electron system dependencies" step up to right after "Install Electron binary". Add the "Node matches Electron" guard step after it, before typecheck. |
| `.github/workflows/release.yml` | `build` job: same action-setup + setup-node edits. Keep `NODE_OPTIONS --max-old-space-size=4096`. |
| `.github/workflows/version.yml` | same action-setup + setup-node edits |
| `PLAN.md` (tracked, stale) | **deleted** in the PR's final commit (Decision 3) |
| `CLAUDE.md` | one Conventions bullet: Node is pinned in `.tool-versions` to the Node bundled by the shipped Electron, bumped with every Electron bump, enforced by the CI guard. The MCP server is the exception: it runs on the user's system Node, `target: node20`. |

No changeset: there is no user-facing change.

Sketch of the guard step (inline in ci.yml; a script file isn't warranted):

```yaml
- name: Node matches Electron's bundled Node
  run: |
    host=$(node -p process.versions.node)
    bundled=$(ELECTRON_RUN_AS_NODE=1 pnpm exec electron -p process.versions.node)
    if [ "$host" != "$bundled" ]; then
      echo "::error file=.tool-versions::CI Node $host != Electron's Node $bundled. Set 'nodejs $bundled' in .tool-versions."
      exit 1
    fi
```

## Risks

| Risk | Assessment / mitigation |
|---|---|
| Node 22 → 24 behaviour changes in unit tests (undici 7 `fetch`, `require(esm)`, stricter URL/TLS, deprecations) | Low. Local dev already runs every gate on 24.21, so only CI-specific Linux differences remain. The CI run on the PR is the test. |
| Vite 7 / electron-vite 5 on Node 24 | Supported (`>=22.12.0`). The Vite 8 ceiling is about electron-vite's vite peer cap and Rolldown+Svelte, not Node, so it is unaffected. |
| `pnpm/action-setup@v5` with both `version:` and `packageManager` | It errors on a conflict, so remove `version:` in all three workflows in the same commit. |
| `setup-node` `cache: pnpm` ordering | Unchanged: action-setup still runs first, so `pnpm` is on PATH for the cache-dir lookup. |
| Guard step fails on Linux because of missing shared libs | Mitigated by moving the apt step before the guard (Decision 5). |
| Release builds (mac/win/linux) on Node 24: `@electron/rebuild` + node-gyp on the Windows runner, electron-builder | Low (`@electron/rebuild` already requires ≥22.12 and bundles its own node-gyp). Release only runs on a version tag, and `action-gh-release` creates a **draft**, so a broken build publishes nothing. Do **not** `workflow_dispatch` release.yml from the branch: its `release` job would write to the current version's draft/tag. |
| Local: 24.17.0 + pnpm not installed under asdf | One-time setup (see Verification). Worktrees on older branches keep using the parent 24.21.0. |
| Electron patch bump without a `.tool-versions` bump | CI guard fails with the exact fix. Intended. |
| `engines` blocks someone on Node 22 | Intended. |

## Verification

**Local one-time setup**:
1. `asdf install nodejs 24.17.0`
2. In the worktree: `node -v` → `v24.17.0`.
3. Get pnpm under that Node: `corepack enable pnpm && asdf reshim nodejs`
   (corepack honours `packageManager`), then `pnpm -v` → `10.33.0`.

**Local gate** (never run E2E locally):
1. `pnpm install`. postinstall rebuilds node-pty for Electron; check there is no
   `engines` warning.
2. Run the guard command from the step above by hand. It should print nothing
   and exit 0.
3. `pnpm typecheck`
4. `pnpm test:unit`
5. `pnpm test:browser` (headless is already configured in `vitest.config.ts`)
6. `pnpm build`
7. Confirm `node_modules/@types/node/package.json` is the pinned 24.x.

**CI (on the draft PR)**:
- setup-node log resolves `.tool-versions` → 24.17.0. action-setup installs pnpm 10.33.0.
- The guard step passes. Typecheck, unit, browser, build and **E2E** are all green.
- Optional negative check: a throwaway commit setting `nodejs 24.16.0` should
  make the guard fail with the annotated message. Drop the commit afterwards.
- `version.yml` / `release.yml` are first exercised on the next merge to `main` /
  next release. Check the release build jobs on all three OSes then.
