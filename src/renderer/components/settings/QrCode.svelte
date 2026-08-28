<script lang="ts">
  import { qrMatrix } from '../../../shared/qr'

  interface Props {
    /**
     * Encoded verbatim. This carries a live bearer token, so it is never
     * logged, never put in a `title`, and never copied anywhere but the
     * clipboard the user asked for.
     */
    value: string
    /**
     * Roughly how wide to draw it, in CSS pixels. Rounded to a whole number of
     * pixels per module — a fractional module width leaves every edge
     * straddling a device pixel on a 1× display, which is the difference
     * between a code that reads first time and one that does not.
     */
    targetSize?: number
    /** Announced to screen readers in place of the code. */
    label: string
  }

  let { value, targetSize = 264, label }: Props = $props()

  // A URL long enough to exceed every QR version is possible in principle;
  // showing nothing beats showing a code that scans to nothing.
  const matrix = $derived.by(() => {
    try {
      return qrMatrix(value)
    } catch {
      return null
    }
  })

  const scale = $derived(matrix ? Math.max(1, Math.round(targetSize / matrix.size)) : 1)
</script>

{#if matrix}
  <!--
    Black on white regardless of the app's theme. The pane is dark, but a
    scanner wants maximum contrast and expects dark modules on a light quiet
    zone; inverting it is the classic reason a code will not read.
  -->
  <svg
    viewBox="0 0 {matrix.size} {matrix.size}"
    width={matrix.size * scale}
    height={matrix.size * scale}
    role="img"
    aria-label={label}
    shape-rendering="crispEdges"
    class="flex-none rounded-md bg-white"
    data-testid="pairing-qr"
  >
    <rect width={matrix.size} height={matrix.size} fill="#ffffff" />
    <path d={matrix.path} fill="#000000" />
  </svg>
{:else}
  <p class="text-xs text-amber-400">That address is too long to encode as a QR code.</p>
{/if}
