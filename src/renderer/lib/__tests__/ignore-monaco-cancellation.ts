/**
 * Disposing a Monaco editor that was focused, typed in or diffed cancels its
 * pending delayers, which reject with a cancellation nobody awaits. Monaco
 * itself ignores those; importing this makes a test file ignore them too. The
 * listener stays for the whole file: the last test's rejection lands after
 * its hooks have run.
 */
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason instanceof Error && e.reason.name === 'Canceled') e.preventDefault()
})
