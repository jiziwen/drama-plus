<template>
  <div class="asset-prompt-summary" :title="text || placeholder">
    <span class="asset-prompt-label">{{ label }}</span>
    <p class="asset-prompt-copy" :class="{ 'is-empty': !text }">{{ text || placeholder }}</p>
  </div>
</template>

<script setup lang="ts">
defineProps<{ label: string; text?: string; placeholder: string }>()
</script>

<style scoped>
.asset-prompt-summary {
  min-width: 0;
  height: 68px;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-muted);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.asset-prompt-label { font-size: 10px; line-height: 12px; font-weight: 600; color: var(--text-2); }
.asset-prompt-copy {
  margin: 0;
  font-size: 11px;
  line-height: 15px;
  color: var(--text-1);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.asset-prompt-copy.is-empty { color: var(--text-3); }
</style>
