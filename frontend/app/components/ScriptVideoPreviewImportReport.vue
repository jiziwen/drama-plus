<template>
  <section class="sv-import-report" :class="{ compact }" :aria-label="title">
    <div class="sv-report-intro" role="status">
      <strong>{{ title }}</strong
      ><span>{{ summary }}</span>
    </div>
    <details v-if="details.length" class="sv-report-detail">
      <summary>
        查看明细 <span>{{ details.length }} 项</span>
      </summary>
      <ul>
        <li v-for="(detail, index) in details.slice(0, limit)" :key="index">
          {{ detail }}
        </li>
      </ul>
      <p v-if="details.length > limit">
        另有 {{ details.length - limit }} 项未显示
      </p>
    </details>
    <details v-if="errors.length" class="sv-report-detail sv-report-errors">
      <summary>
        查看未导入或错误 <span>{{ errors.length }} 项</span>
      </summary>
      <ul>
        <li v-for="(error, index) in errors.slice(0, limit)" :key="index">
          {{ error }}
        </li>
      </ul>
      <p v-if="errors.length > limit">
        另有 {{ errors.length - limit }} 项未显示
      </p>
    </details>
  </section>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string;
    summary: string;
    details: string[];
    errors?: string[];
    compact?: boolean;
  }>(),
  { errors: () => [], compact: false },
);
const limit = 100;
</script>

<style scoped>
.sv-import-report {
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface-input, var(--bg-input));
  color: var(--text-1);
  font-size: 12px;
}
.sv-import-report.compact {
  padding: 9px 11px;
  font-size: 11px;
}
.sv-report-intro {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 5px 10px;
  line-height: 1.55;
}
.sv-report-intro strong {
  color: var(--text-0);
  font-weight: 650;
}
.sv-report-intro span {
  color: var(--text-2);
}
.sv-report-detail {
  margin-top: 9px;
  color: var(--text-2);
}
.sv-report-detail summary {
  cursor: pointer;
  color: var(--accent-text, var(--accent));
  font-weight: 600;
}
.sv-report-detail summary span {
  margin-left: 4px;
  color: var(--text-3);
  font-weight: 400;
}
.sv-report-detail summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
  border-radius: 3px;
}
.sv-report-detail ul {
  max-height: 200px;
  overflow: auto;
  margin: 8px 0 0;
  padding: 0 0 0 18px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.sv-report-detail p {
  margin: 7px 0 0;
  color: var(--text-3);
}
.sv-report-errors summary {
  color: var(--warning, #b77429);
}
</style>
