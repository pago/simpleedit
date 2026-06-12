<script lang="ts">
  import SessionList from './SessionList.svelte'
</script>

<!-- Sessions are the only sidebar entity. Worktree management lives in each
     workspace's worktree popover (SessionWorkspace header). -->
<div class="h-full overflow-y-auto px-3 pb-2">
  <SessionList />
</div>
