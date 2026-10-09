<script lang="ts">
  import { capabilitiesFor, knownProviders, providerLabel } from '../../stores/agent-capabilities.svelte'
  import { REASONING_EFFORTS, type AgentProviderId } from '../../../shared/ipc-types'
  import type { TargetFields } from '../../lib/session-target'

  interface Props {
    /** The picked agent, or null for "the default" when `allowDefault`. */
    fields: TargetFields | null
    /** Offer "Default" (decided when the session starts) as the first choice. */
    allowDefault?: boolean
    idPrefix: string
  }

  let { fields = $bindable(), allowDefault = false, idPrefix }: Props = $props()

  const caps = $derived(fields ? capabilitiesFor(fields.provider) : undefined)
  const providers = $derived(knownProviders().length > 0 ? knownProviders() : fields ? [fields.provider] : ['claude' as AgentProviderId])

  function pickProvider(value: string): void {
    if (value === '') fields = null
    else fields = { provider: value as AgentProviderId, modelId: '', reasoningEffort: '' }
  }
</script>

<div class="grid grid-cols-3 gap-2">
  <label class="text-xs text-zinc-400" for="{idPrefix}-provider">Provider
    <select
      id="{idPrefix}-provider"
      value={fields?.provider ?? ''}
      onchange={(e) => pickProvider(e.currentTarget.value)}
      class="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-200"
    >
      {#if allowDefault}<option value="">Default</option>{/if}
      {#each providers as id (id)}<option value={id}>{providerLabel(id)}</option>{/each}
    </select>
  </label>
  {#if fields}
    <label class="col-span-2 text-xs text-zinc-400" for="{idPrefix}-model">Model <span class="text-zinc-600">(default when blank)</span>
      <input id="{idPrefix}-model" bind:value={fields.modelId} class="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-200" />
    </label>
    {#if caps?.reasoningEffort}
      <label class="text-xs text-zinc-400" for="{idPrefix}-effort">Reasoning
        <select id="{idPrefix}-effort" bind:value={fields.reasoningEffort} class="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-200">
          <option value="">Model default</option>
          <!-- One list, shared with the launch flags and the spawn_session schema. -->
          {#each REASONING_EFFORTS as effort (effort)}<option value={effort}>{effort}</option>{/each}
        </select>
      </label>
    {/if}
  {/if}
</div>
