// electron-builder afterPack hook: ad-hoc sign the fully-assembled macOS bundle.
//
// Without a valid signature, macOS reports a quarantined arm64 app as
// "SimpleEdit is damaged and can't be opened" instead of the bypassable
// "unidentified developer" prompt. An ad-hoc signature (`codesign -s -`,
// no Apple certificate) is enough to avoid the hard "damaged" failure.
//
// This must run in afterPack rather than afterSign: afterPack fires once the
// bundle is fully populated — including the node-pty native modules under
// asarUnpack and the mcp-server extraResources — so `--deep` covers every
// nested Mach-O. electron-builder's own signing is disabled (mac.identity:
// null) so this signature is the last thing to touch the bundle before the
// dmg/zip is built.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  )

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  })

  // Fail the build loudly if the signature didn't take, rather than shipping
  // another "damaged" release.
  execFileSync(
    'codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', appPath],
    { stdio: 'inherit' },
  )
}
