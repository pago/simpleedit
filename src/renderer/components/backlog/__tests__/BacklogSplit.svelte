<!-- The list (with its header's + New) and the view mounted apart, as the sidebar and the main area do. -->
<script lang="ts">
  import BacklogList from '../BacklogList.svelte'
  import BacklogNewButton from '../BacklogNewButton.svelte'
  import BacklogView from '../BacklogView.svelte'
</script>

<BacklogNewButton />
<BacklogList />
<BacklogView />
