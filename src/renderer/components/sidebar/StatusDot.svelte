<script lang="ts">
  import type { AttentionLevel } from '../../lib/sessionsAttention'

  let { level }: { level: AttentionLevel } = $props()

  const CLASSES: Record<AttentionLevel, string> = {
    error: 'bg-red-500',
    waiting: 'bg-amber-400',
    unseen: 'bg-blue-400',
    running: 'bg-emerald-400 animate-pulse',
    none: 'bg-zinc-600',
  }
</script>

<span class="h-2 w-2 rounded-full {CLASSES[level]}" data-level={level}></span>
