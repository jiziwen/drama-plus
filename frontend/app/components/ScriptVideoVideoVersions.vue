<template>
  <section class="video-versions" aria-label="成片版本">
    <strong>成片版本 · {{ versions.length }}</strong>
    <ul>
      <li v-for="(version, index) in newestFirst" :key="version.url">
        <div class="video-version-info">
          <span>版本 {{ versions.length - index }}</span>
          <span v-if="version.url === officialUrl" class="video-version-official">正片</span>
          <small v-if="version.modelLabel || version.duration">
            {{ [version.modelLabel, version.duration && `${version.duration} 秒`].filter(Boolean).join(' · ') }}
          </small>
        </div>
        <div class="video-version-actions">
          <button type="button" class="btn btn-sm" @click="$emit('preview', version.url, versions.length - index)">预览</button>
          <a class="btn btn-sm" :href="version.url" :download="filename">下载</a>
          <button
            v-if="version.url !== officialUrl"
            type="button"
            class="btn btn-sm"
            :disabled="!!promoting || generationPending"
            :title="generationPending ? '请等本段生成完成' : undefined"
            @click="$emit('promote', version.url)"
          >
            {{ promoting === version.url ? '正在设置…' : '设为正片' }}
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ScriptVideoVersion } from '~/utils/scriptVideoPreview'

const props = defineProps<{
  versions: readonly ScriptVideoVersion[]
  filename: string
  officialUrl?: string
  promoting?: string
  generationPending?: boolean
}>()
defineEmits<{
  preview: [url: string, version: number]
  promote: [url: string]
}>()
const newestFirst = computed(() => [...props.versions].reverse())
</script>

<style scoped>
.video-versions {
  display: grid;
  gap: 8px;
}
.video-versions ul {
  display: grid;
  gap: 6px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.video-versions li,
.video-version-info,
.video-version-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.video-versions li {
  justify-content: space-between;
  border: 1px solid var(--border, #263d49);
  border-radius: 8px;
  padding: 8px 10px;
}
.video-version-info small {
  opacity: 0.75;
  overflow-wrap: anywhere;
}
.video-version-official {
  color: #a5d7d2;
}
</style>
