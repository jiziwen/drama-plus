<template>
  <details class="sv-style">
    <summary>{{ preset.name }}</summary>
    <p>{{ preset.text }}</p>
  </details>
</template>

<script setup lang="ts">
defineProps<{ preset: { name: string; text: string } }>()
</script>

<style scoped>
.sv-style {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-input, var(--bg-2));
  color: var(--text-2);
  font-size: 12px;
  margin-bottom: 5px;
}
.sv-style summary {
  padding: 9px 13px;
  color: var(--text-1);
  cursor: pointer;
}
.sv-style summary:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 2px;
  border-radius: inherit;
}
.sv-style p {
  max-height: min(34dvh, 260px);
  overflow: auto;
  margin: 0;
  padding: 0 13px 11px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.8;
}
</style>
