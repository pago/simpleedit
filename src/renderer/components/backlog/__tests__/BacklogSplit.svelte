<!-- The list and the view mounted apart, as when the list sits in the sidebar. -->
<script lang="ts">
  import BacklogList from '../BacklogList.svelte'
  import BacklogView from '../BacklogView.svelte'
</script>

<BacklogList />
<BacklogView list={false} />
