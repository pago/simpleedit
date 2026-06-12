---
"simpleedit": patch
---

fix: upgrade @electron/rebuild so node-gyp can find Visual Studio 2026

The Windows release build failed at install with "Could not find any Visual Studio
installation to use". GitHub migrated the `windows-latest` runner to Visual Studio 2026,
which node-gyp only learned to detect in v12.1.0. The pinned `@electron/rebuild@4.0.3`
pulled in node-gyp 11.x transitively. Bumping to `@electron/rebuild@^4.0.4` resolves
node-gyp ^12.2.0, restoring native rebuilds of node-pty on Windows.
