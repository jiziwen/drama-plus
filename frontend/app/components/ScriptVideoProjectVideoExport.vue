<template>
  <div class="project-export-body">
    <p v-if="loading" class="project-export-message" role="status">正在读取各集成片…</p>
    <p v-else-if="!episodes.length && !error" class="project-export-message">项目暂无分集。</p>
    <template v-else-if="episodes.length">
      <div class="project-export-toolbar">
        <span>共 {{ episodes.length }} 集 · {{ totalClips }} 段可导出</span>
        <div>
          <button type="button" class="btn" :disabled="submitting || selectedCount === totalClips" @click="selectAll(true)">全选</button>
          <button type="button" class="btn" :disabled="submitting || !selectedCount" @click="selectAll(false)">全部取消</button>
        </div>
      </div>
      <section v-for="episode in episodes" :key="episode.id" class="project-export-episode">
        <div class="project-export-episode-head">
          <label>
            <input
              type="checkbox"
              :checked="!!episode.clips.length && countSelected(episode) === episode.clips.length"
              :indeterminate="countSelected(episode) > 0 && countSelected(episode) < episode.clips.length"
              :disabled="submitting || !episode.clips.length"
              @change="selectEpisode(episode, ($event.target as HTMLInputElement).checked)"
            />
            <strong>第{{ episode.number }}集<template v-if="episode.title"> · {{ episode.title }}</template></strong>
          </label>
          <button
            v-if="episode.clips.length"
            type="button"
            class="btn project-export-expand"
            :aria-expanded="expanded.has(episode.id)"
            :aria-label="`${expanded.has(episode.id) ? '收起' : '展开'}第${episode.number}集的成片`"
            @click="toggleExpanded(episode.id)"
          >
            {{ countSelected(episode) }}/{{ episode.clips.length }} 段
            <ChevronDown :size="14" aria-hidden="true" />
          </button>
          <span v-else class="project-export-message">暂无成片</span>
        </div>
        <div v-if="expanded.has(episode.id) && episode.clips.length" class="project-export-clips">
          <label v-for="clip in episode.clips" :key="clip.id" class="project-export-clip">
            <input
              type="checkbox"
              :checked="selected.get(episode.id)?.has(clip.id)"
              :disabled="submitting"
              @change="selectClip(episode, clip.id, ($event.target as HTMLInputElement).checked)"
            />
            <span class="project-export-clip-number">{{ String(clip.index).padStart(2, '0') }}</span>
            <span>{{ clip.title || `片段 ${clip.index}` }}</span>
            <small v-if="clip.kind === 'previous'">上一版成片</small>
          </label>
        </div>
      </section>
    </template>
    <p v-if="error" class="project-export-error" role="alert">{{ error }}</p>
  </div>
  <footer class="project-export-footer">
    <span role="status">{{ started ? '已提交下载' : `已选 ${selected.size} 集 · ${selectedCount} 段` }}</span>
    <button type="button" class="btn btn-primary" :disabled="loading || submitting || !selectedCount" @click="download">
      <LoaderCircle v-if="submitting" :size="14" class="animate-spin" aria-hidden="true" />
      <Download v-else :size="14" aria-hidden="true" />
      {{ submitting ? '准备中…' : '导出所选视频' }}
    </button>
  </footer>
</template>

<script setup lang="ts">
import { ChevronDown, Download, LoaderCircle } from 'lucide-vue-next'
import { scriptVideoRequest } from '~/utils/scriptVideoClient'

type Episode = {
  id: string
  number: number
  title: string
  clips: { id: string; index: number; title: string; kind: 'current' | 'previous' }[]
}

const props = defineProps<{ projectId: string; episodeId?: string }>()
const url = `/projects/${encodeURIComponent(props.projectId)}/video-archive`
const controller = new AbortController()
const episodes = ref<Episode[]>([])
const expanded = ref(new Set<string>())
const selected = ref(new Map<string, Set<string>>())
const loading = ref(true)
const submitting = ref(false)
const started = ref(false)
const error = ref('')
const totalClips = computed(() => episodes.value.reduce((total, episode) => total + episode.clips.length, 0))
const selectedCount = computed(() => [...selected.value.values()].reduce((total, ids) => total + ids.size, 0))
const countSelected = (episode: Episode) => selected.value.get(episode.id)?.size ?? 0

function toggleExpanded(id: string) {
  if (expanded.value.has(id)) expanded.value.delete(id)
  else expanded.value.add(id)
}

function selectAll(checked: boolean) {
  started.value = false
  selected.value = checked
    ? new Map(episodes.value.filter(episode => episode.clips.length)
      .map(episode => [episode.id, new Set(episode.clips.map(clip => clip.id))]))
    : new Map()
}

function selectEpisode(episode: Episode, checked: boolean) {
  started.value = false
  if (checked) selected.value.set(episode.id, new Set(episode.clips.map(clip => clip.id)))
  else selected.value.delete(episode.id)
}

function selectClip(episode: Episode, id: string, checked: boolean) {
  started.value = false
  const ids = selected.value.get(episode.id) ?? new Set<string>()
  if (checked) ids.add(id)
  else ids.delete(id)
  if (ids.size) selected.value.set(episode.id, ids)
  else selected.value.delete(episode.id)
}

onMounted(async () => {
  try {
    const result = await scriptVideoRequest<{ episodes: Episode[] }>(url, 'GET', undefined, controller.signal)
    episodes.value = result.episodes
    selectAll(true)
    const initial = result.episodes.find(episode => episode.id === props.episodeId && episode.clips.length)
      ?? result.episodes.find(episode => episode.clips.length)
    if (initial) expanded.value.add(initial.id)
  } catch (reason) {
    if (!controller.signal.aborted) error.value = reason instanceof Error ? reason.message : '读取成片列表失败'
  } finally {
    loading.value = false
  }
})
onBeforeUnmount(() => controller.abort())

async function download() {
  if (!selectedCount.value || submitting.value) return
  submitting.value = true
  started.value = false
  error.value = ''
  try {
    const selection = [...selected.value].map(([episodeId, ids]) => ({ episodeId, cardIds: [...ids] }))
    const { token } = await scriptVideoRequest<{ token: string }>(url, 'POST', { episodes: selection }, controller.signal)
    if (controller.signal.aborted) return
    const anchor = document.createElement('a')
    anchor.href = `/api/v1/script-video${url}/${encodeURIComponent(token)}`
    anchor.download = ''
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    started.value = true
  } catch (reason) {
    if (!controller.signal.aborted) error.value = reason instanceof Error ? reason.message : '视频导出失败'
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.project-export-body {
  display: grid;
  gap: 10px;
  overflow-y: auto;
  padding: 18px 26px;
}
.project-export-toolbar, .project-export-episode-head, .project-export-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.project-export-toolbar { margin-bottom: 3px; }
.project-export-toolbar > div { display: flex; gap: 8px; }
.project-export-toolbar > span, .project-export-footer > span, .project-export-message, .project-export-clip small {
  color: var(--text-2);
  font-size: 12px;
}
.project-export-episode {
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface);
}
.project-export-episode-head { padding: 8px 11px; }
.project-export-episode-head label, .project-export-clip {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.project-export-episode-head input, .project-export-clip input { accent-color: var(--accent); flex-shrink: 0; }
.project-export-expand { min-height: 30px; white-space: nowrap; }
.project-export-expand[aria-expanded="true"] svg { transform: rotate(180deg); }
.project-export-clips { border-top: 1px solid var(--border); padding: 4px 11px 5px 26px; }
.project-export-clip { padding: 7px 0; }
.project-export-clip + .project-export-clip { border-top: 1px solid var(--border); }
.project-export-clip-number { color: var(--text-2); font-variant-numeric: tabular-nums; }
.project-export-clip small { margin-left: auto; white-space: nowrap; }
.project-export-footer { flex-shrink: 0; border-top: 1px solid var(--border); padding: 13px 26px; }
.project-export-error { color: var(--action-danger); font-size: 13px; }
@media (max-width: 640px) {
  .project-export-body, .project-export-footer { padding-inline: 15px; }
}
</style>
