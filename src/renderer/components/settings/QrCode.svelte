<script lang="ts">
  import { qrMatrix } from '../../../shared/qr'

  interface Props {
    /**
     * Encoded verbatim. This carries a live bearer token, so it is never
     * logged, never put in a `title`, and never copied anywhere but the
     * clipboard the user asked for.
     */
    value: string
    /** Rendered edge length in CSS pixels. */
    size?: number
    /** Announced to screen readers in place of the code. */
    label: string
  }

  let { value, size = 240, label }: Props = $props()

  // A URL long enough to exceed every QR version is possible in principle;
  // showing nothing beats showing a code that scans to nothing.
  const matrix = $derived.by(() => {
    try {
      return qrMatrix(value)
    } catch {
      return null
    }
  })
</script>

{#if matrix}
  <!--
    Black on white regardless of the app's theme. The pane is dark, but a
    scanner wants maximum contrast and expects dark modules on a light quiet
    zone; inverting it is the classic reason a code will not read.
  -->
  <svg
    viewBox="0 0 {matrix.size} {matrix.size}"
    width={size}
    height={size}
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
