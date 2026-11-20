<template>
  <section class="release-settings" :aria-labelledby="headingId">
    <header class="settings-head">
      <h2 :id="headingId" class="settings-title">版本更新</h2>
      <p class="settings-desc">发布后，用户可以在顶栏铃铛中看到这次的更新。</p>
    </header>

    <p v-if="checkingAccess" class="settings-desc" role="status">正在检查发布权限…</p>
    <div v-else-if="accessError" class="release-settings-actions">
      <p class="release-error" role="alert">无法检查发布权限。</p>
      <button type="button" class="btn btn-sm" @click="loadAccess">重试</button>
    </div>
    <p v-else-if="!canPublish" class="settings-desc">只有管理员可以发布版本更新。</p>

    <template v-else>
      <form class="card release-form" @submit.prevent="publish">
        <label class="field">
          <span class="field-label">更新标题</span>
          <input v-model="draft.title" class="input" maxlength="100" required :disabled="submitting" />
        </label>
        <label class="field">
          <span class="field-label">更新内容</span>
          <textarea
            v-model="draft.details"
            class="textarea"
            rows="6"
            required
            :aria-describedby="detailsHintId"
            :aria-invalid="!!validationError"
            :disabled="submitting"
          />
          <span :id="detailsHintId" class="release-hint" :class="{ 'release-error': validationError }">
            {{ validationError || '每行写一条更新，最多 20 条，每条不超过 500 个字符。' }}
          </span>
        </label>
        <div class="release-settings-actions">
          <button class="btn btn-primary" type="submit" :disabled="submitting || !title || !changes.length || !!validationError">
            <Send :size="14" aria-hidden="true" />{{ submitting ? '正在发布…' : '发布更新' }}
          </button>
          <p v-if="publishError" class="release-error" role="alert">{{ publishError }}</p>
          <p v-else-if="lastPublished && !title && !changes.length" class="release-success" role="status">
            已发布「{{ lastPublished.title }}」
          </p>
        </div>
      </form>

      <section class="release-history" :aria-labelledby="historyId" :aria-busy="loadingHistory">
        <h3 :id="historyId">最近发布</h3>
        <div v-if="historyError" class="release-settings-actions">
          <p class="release-error" role="alert">无法加载发布记录。</p>
          <button type="button" class="btn btn-sm" @click="loadHistory">重试</button>
        </div>
        <p v-else-if="!recentNotes.length" class="settings-desc" role="status">
          {{ loadingHistory ? '正在加载发布记录…' : '暂无发布记录' }}
        </p>
        <article v-for="note in recentNotes" :key="note.id" class="card release-history-entry">
          <time :datetime="note.publishedAt">{{ formatPublishedAt(note.publishedAt) }}</time>
          <h4>{{ note.title }}</h4>
          <ul>
            <li v-for="(change, index) in note.changes" :key="index">{{ change }}</li>
          </ul>
        </article>
      </section>
    </template>
  </section>
</template>

<script setup lang="ts">
import { Send } from 'lucide-vue-next'
import { releaseNotesAPI, type ReleaseNote } from '~/composables/useApi'

const headingId = useId()
const detailsHintId = useId()
const historyId = useId()
const canPublish = ref(false)
const checkingAccess = ref(true)
const accessError = ref(false)
const loadingHistory = ref(false)
const historyError = ref(false)
const history = ref<ReleaseNote[]>([])
const draft = useState('release-notes-settings-draft', () => ({
  title: '',
  details: '',
  request: null as { fingerprint: string; id: string } | null,
}))
const submitting = useState('release-notes-settings-publishing', () => false)
const publishError = useState('release-notes-settings-error', () => '')
const lastPublished = useState<ReleaseNote | null>('release-notes-settings-published', () => null)
const title = computed(() => draft.value.title.trim())
const changes = computed(() => draft.value.details.split(/\r\n?|\n/).map(line => line.trim()).filter(Boolean))
const validationError = computed(() => {
  if (changes.value.length > 20) return '更新内容最多 20 条。'
  if (changes.value.some(line => line.length > 500)) return '每条更新最多 500 个字符。'
  return ''
})
const recentNotes = computed(() => {
  const latest = lastPublished.value
  const notes = latest && !history.value.some(note => note.id === latest.id)
    ? [...history.value, latest].sort((first, second) => second.id - first.id)
    : history.value
  return notes.slice(0, 5)
})
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', hour12: false })

function formatPublishedAt(value: string) {
  return dateFormat.format(new Date(value))
}

async function loadAccess() {
  checkingAccess.value = true
  accessError.value = false
  try {
    canPublish.value = (await releaseNotesAPI.access()).canPublish
    if (canPublish.value) void loadHistory()
  } catch {
    accessError.value = true
  } finally {
    checkingAccess.value = false
  }
}

async function loadHistory() {
  loadingHistory.value = true
  historyError.value = false
  try {
    history.value = (await releaseNotesAPI.list()).items
  } catch {
    historyError.value = true
  } finally {
    loadingHistory.value = false
  }
}

async function publish() {
  if (submitting.value || !canPublish.value || !title.value || !changes.value.length || validationError.value) return
  const body = { title: title.value, changes: changes.value }
  const fingerprint = JSON.stringify(body)
  submitting.value = true
  publishError.value = ''
  try {
    if (draft.value.request?.fingerprint !== fingerprint) {
      draft.value.request = { fingerprint, id: crypto.randomUUID() }
    }
    lastPublished.value = await releaseNotesAPI.publish({ ...body, requestId: draft.value.request.id })
    draft.value = { title: '', details: '', request: null }
    window.dispatchEvent(new Event('release-notes-published'))
    void loadHistory()
  } catch (error) {
    publishError.value = error instanceof Error && !(error instanceof TypeError || error instanceof SyntaxError)
      ? error.message
      : '未能确认发布结果，请重试。'
  } finally {
    submitting.value = false
  }
}

onMounted(loadAccess)
</script>

<style scoped>
.settings-head { margin-bottom: 20px; }
.settings-title { margin: 0; color: var(--text-0); font-size: 22px; font-weight: 800; }
.settings-desc { margin: 6px 0 0; color: var(--text-2); font-size: 13px; }
.release-form { display: grid; gap: 14px; padding: 18px; }
.release-form .field { display: grid; gap: 6px; margin: 0; }
.release-form :is(.input, .textarea) { box-sizing: border-box; width: 100%; min-width: 0; }
.release-form .textarea { resize: vertical; }
.release-settings-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; }
.release-settings-actions p { margin: 0; overflow-wrap: anywhere; }
.release-hint, .release-error, .release-success { font-size: 13px; }
.release-hint { color: var(--text-2); }
.release-error { color: var(--danger); }
.release-success { color: var(--success); }
.release-history { display: grid; gap: 8px; margin-top: 24px; }
.release-history h3 { margin: 0; color: var(--text-0); font-size: 16px; }
.release-history-entry { padding: 12px 16px; overflow-wrap: anywhere; }
.release-history-entry time { color: var(--text-2); font-size: 12px; }
.release-history-entry h4 { margin: 4px 0; color: var(--text-0); font-size: 14px; }
.release-history-entry ul { margin: 5px 0 0; padding-inline-start: 18px; font-size: 13px; line-height: 1.65; }
</style>
