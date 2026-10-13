<!-- The backlog as the accordion mounts it: list and view only while uiView is 'backlog'. -->
<script lang="ts">
  import BacklogList from '../BacklogList.svelte'
  import BacklogView from '../BacklogView.svelte'
  import { uiView } from '../../../stores/uiView.svelte'
</script>

{#if uiView.current() === 'backlog'}
  <BacklogList />
  <BacklogView />
{:else}
  <p>Sessions</p>
{/if}
