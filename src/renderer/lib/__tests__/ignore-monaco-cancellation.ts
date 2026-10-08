/**
 * Disposing a Monaco editor that was focused, typed in or diffed cancels its
 * pending delayers, which reject with a cancellation nobody awaits. Monaco
 * itself ignores those; importing this makes a test file ignore them too, and
 * only them: Monaco's `CancellationError` is the one error whose name and
 * message are both exactly "Canceled". The listener stays for the whole file:
 * the last test's rejection lands after its hooks have run.
 */
export function isMonacoCancellation(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'Canceled' && reason.message === 'Canceled'
}

window.addEventListener('unhandledrejection', (e) => {
  if (isMonacoCancellation(e.reason)) e.preventDefault()
})
