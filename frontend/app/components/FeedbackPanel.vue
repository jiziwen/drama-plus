<template>
  <section class="feedback-panel" aria-labelledby="feedback-title">
    <header class="feedback-heading">
      <h2 id="feedback-title">问题反馈</h2>
      <p v-if="accessReady && !canManage">描述遇到的问题和操作步骤，方便我们复现和处理。</p>
    </header>

    <form v-if="accessReady && !canManage" class="card feedback-form" @submit.prevent="submitFeedback">
      <label class="field">
        <span class="field-label">标题</span>
        <input v-model="draft.title" class="input" required maxlength="100" placeholder="简要说明问题" :disabled="submitting" />
      </label>
      <label class="field">
        <span class="field-label">问题描述</span>
        <textarea v-model="draft.description" class="textarea" rows="5" required maxlength="4000" placeholder="在哪个页面，执行了哪些操作，实际出现了什么？" :disabled="submitting" />
      </label>
      <label class="field">
        <span class="field-label">联系方式（选填）</span>
        <input v-model="draft.contact" class="input" maxlength="160" :disabled="submitting" />
      </label>
      <div class="field">
        <label for="feedback-screenshots" class="field-label">上传截图（选填）</label>
        <input id="feedback-screenshots" class="input" type="file" accept="image/png,image/jpeg,image/webp" multiple
          aria-describedby="feedback-screenshot-limit" :disabled="submitting || screenshots.length >= maxScreenshots" @change="addScreenshots" />
        <small id="feedback-screenshot-limit" class="feedback-muted">最多 3 张，每张不超过 5 MB，支持 PNG、JPEG、WebP。</small>
        <div v-if="screenshots.length" class="feedback-screenshots">
          <div v-for="(screenshot, index) in screenshots" :key="screenshot.preview" class="feedback-screenshot">
            <a :href="screenshot.preview" :aria-label="`查看待提交的截图 ${index + 1}`" target="_blank" rel="noopener">
              <img v-if="screenshot.thumbnail" :src="screenshot.thumbnail" alt="" loading="lazy" decoding="async" />
              <span v-else>截图 {{ index + 1 }}</span>
            </a>
            <button class="btn btn-sm" type="button" :disabled="submitting" @click="removeScreenshot(index)">移除截图 {{ index + 1 }}</button>
          </div>
        </div>
        <p v-if="screenshotError" class="feedback-error" role="alert">{{ screenshotError }}</p>
      </div>
      <div class="feedback-actions">
        <button type="submit" class="btn btn-primary" :disabled="submitting || !draft.title.trim() || !draft.description.trim()">
          <Send :size="14" />{{ submitting ? '提交中…' : '提交反馈' }}
        </button>
        <span v-if="receipt" class="feedback-success" role="status">已提交反馈 #{{ receipt.id }}</span>
      </div>
      <div v-if="receipt?.screenshotCount" class="feedback-screenshots">
        <a v-for="position in receipt.screenshotCount" :key="position" class="feedback-screenshot"
          :href="feedbackAPI.screenshotUrl(receipt.id, position)" target="_blank" rel="noopener">
          <img :src="feedbackAPI.screenshotUrl(receipt.id, position, true)" :alt="`查看已提交的截图 ${position}`" loading="lazy" decoding="async" />
        </a>
      </div>
      <p v-if="submitError" class="feedback-error" role="alert">{{ submitError }}</p>
    </form>

    <p v-if="accessError" class="feedback-error" role="alert">
      {{ accessError }} <button class="btn btn-sm" @click="loadAccess">重试</button>
    </p>
    <p v-else-if="!accessReady" class="feedback-muted" role="status">正在读取反馈权限…</p>

    <section v-if="canManage" class="feedback-queue" aria-labelledby="feedback-queue-title" :aria-busy="loading">
      <div class="feedback-toolbar">
        <h3 id="feedback-queue-title">反馈管理</h3>
        <select v-model="filter" aria-label="筛选反馈状态" class="input" :disabled="loading || saving" @change="changePage(1)">
          <option value="">全部状态</option>
          <option v-for="(label, status) in statusLabels" :key="status" :value="status">{{ label }}</option>
        </select>
        <button class="btn btn-sm" :disabled="loading || saving" @click="refreshQueue"><RefreshCw :size="14" />刷新</button>
      </div>
      <p v-if="queueError" class="feedback-error" role="alert">{{ queueError }}</p>
      <p v-else-if="!entries.length" class="feedback-muted">{{ loading ? '正在加载反馈…' : '暂无反馈' }}</p>

      <article v-for="entry in entries" :key="entry.id" class="card feedback-entry">
        <button class="feedback-entry-head" type="button" :aria-expanded="editing?.id === entry.id" @click="toggleEntry(entry)">
          <span class="tag" :class="statusColors[entry.status]">{{ statusLabels[entry.status] }}</span>
          <strong>{{ entry.title }}</strong>
          <time :datetime="entry.createdAt">{{ formatTime(entry.createdAt) }}</time>
          <ChevronDown :size="14" aria-hidden="true" />
        </button>
        <div v-if="editing?.id === entry.id" class="feedback-entry-body">
          <p class="feedback-description">{{ entry.description }}</p>
          <dl class="feedback-meta">
            <div><dt>反馈编号</dt><dd>#{{ entry.id }}</dd></div>
            <div><dt>来源页面</dt><dd>{{ entry.pagePath }}</dd></div>
            <div v-if="entry.submittedBy"><dt>提交账号</dt><dd>{{ entry.submittedBy }}</dd></div>
            <div v-if="entry.contact"><dt>联系方式</dt><dd>{{ entry.contact }}</dd></div>
          </dl>
          <div v-if="entry.screenshotCount" class="feedback-screenshots feedback-entry-screenshots" aria-label="反馈截图">
            <a v-for="position in entry.screenshotCount" :key="position" class="feedback-screenshot"
              :href="feedbackAPI.screenshotUrl(entry.id, position)" target="_blank" rel="noopener">
              <img :src="feedbackAPI.screenshotUrl(entry.id, position, true)" :alt="`查看反馈截图 ${position}`" loading="lazy" decoding="async" />
            </a>
          </div>
          <form class="feedback-update" @submit.prevent="saveEntry">
            <label class="field">
              <span class="field-label">处理状态</span>
              <select v-model="editing.status" class="input" :disabled="saving">
                <option v-for="(label, status) in statusLabels" :key="status" :value="status">{{ label }}</option>
              </select>
            </label>
            <label class="field">
              <span class="field-label">处理备注</span>
              <textarea v-model="editing.operatorNote" class="textarea" rows="3" maxlength="4000" :disabled="saving" />
            </label>
            <div class="feedback-actions">
              <button type="submit" class="btn btn-primary btn-sm" :disabled="saving">{{ saving ? '保存中…' : '保存处理结果' }}</button>
              <span v-if="saveMessage" class="feedback-success" role="status">{{ saveMessage }}</span>
            </div>
            <p v-if="saveError" class="feedback-error" role="alert">{{ saveError }}</p>
          </form>
        </div>
      </article>

      <div v-if="total > 0" class="feedback-pagination">
        <span class="feedback-muted">共 {{ total }} 条 · 第 {{ page }} / {{ pages }} 页</span>
        <button class="btn btn-sm" :disabled="loading || saving || page <= 1" @click="changePage(page - 1)">上一页</button>
        <button class="btn btn-sm" :disabled="loading || saving || page >= pages" @click="changePage(page + 1)">下一页</button>
      </div>
    </section>
  </section>
</template>

<script setup lang="ts">
import { ChevronDown, RefreshCw, Send } from 'lucide-vue-next'
import { feedbackAPI, type FeedbackEntry, type FeedbackStatus } from '~/composables/useApi'

const route = useRoute()
const maxScreenshots = 3
const maxScreenshotBytes = 5 * 1024 * 1024
const screenshotTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])
const draft = reactive({ title: '', description: '', contact: '' })
const screenshots = ref<{ file: File; preview: string; thumbnail?: string }[]>([])
const screenshotError = ref('')
const receipt = ref<{ id: number; screenshotCount: number } | null>(null)
const submitError = ref('')
const submitting = ref(false)
const canManage = ref(false)
const accessReady = ref(false)
const accessError = ref('')
const statusLabels = { open: '待处理', in_progress: '处理中', resolved: '已解决' }
const statusColors = { open: '', in_progress: 'tag-accent', resolved: 'tag-success' }
const entries = ref<FeedbackEntry[]>([])
const filter = ref<FeedbackStatus | ''>('')
const page = ref(1)
const pageSize = ref(20)
const total = ref(0)
const pages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
const loading = ref(false)
const queueError = ref('')
const editing = ref<FeedbackEntry | null>(null)
const saving = ref(false)
const saveError = ref('')
const saveMessage = ref('')
let listRequest = 0

function formatTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请重试。'
}

function addScreenshots(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (submitting.value || !files.length) return
  screenshotError.value = ''
  if (screenshots.value.length + files.length > maxScreenshots) {
    screenshotError.value = '截图最多上传 3 张。'
    return
  }
  if (files.some(file => !screenshotTypes.has(file.type) || !file.size || file.size > maxScreenshotBytes)) {
    screenshotError.value = '请选择不超过 5 MB 的 PNG、JPEG 或 WebP 图片。'
    return
  }
  for (const file of files) {
    const preview = URL.createObjectURL(file)
    screenshots.value.push({ file, preview })
    void createScreenshotThumbnail(file, preview).catch(() => {})
  }
}

async function createScreenshotThumbnail(file: File, preview: string) {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, 400 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) return
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.78))
    const current = screenshots.value.find(screenshot => screenshot.preview === preview)
    if (blob && current) current.thumbnail = URL.createObjectURL(blob)
  } finally {
    bitmap.close()
  }
}

function removeScreenshot(index: number) {
  const [removed] = screenshots.value.splice(index, 1)
  if (removed) releaseScreenshot(removed)
  screenshotError.value = ''
}

function clearScreenshots() {
  for (const screenshot of screenshots.value) releaseScreenshot(screenshot)
  screenshots.value = []
  screenshotError.value = ''
}

function releaseScreenshot(screenshot: { preview: string; thumbnail?: string }) {
  URL.revokeObjectURL(screenshot.preview)
  if (screenshot.thumbnail) URL.revokeObjectURL(screenshot.thumbnail)
}

async function submitFeedback() {
  if (!accessReady.value || canManage.value || submitting.value) return
  submitting.value = true
  submitError.value = ''
  receipt.value = null
  try {
    const files = screenshots.value.map(screenshot => screenshot.file)
    const result = await feedbackAPI.submit({ ...draft, pagePath: route.path.slice(0, 200) }, files)
    receipt.value = { id: result.id, screenshotCount: files.length }
    Object.assign(draft, { title: '', description: '', contact: '' })
    clearScreenshots()
  } catch (error) {
    submitError.value = errorMessage(error)
  } finally {
    submitting.value = false
  }
}

async function loadAccess() {
  accessError.value = ''
  try {
    canManage.value = (await feedbackAPI.access()).canManage
    accessReady.value = true
    if (canManage.value) await loadEntries()
  } catch {
    accessError.value = '无法读取反馈权限。'
  }
}

async function loadEntries() {
  const request = ++listRequest
  loading.value = true
  queueError.value = ''
  try {
    const query = new URLSearchParams({ page: String(page.value) })
    if (filter.value) query.set('status', filter.value)
    const result = await feedbackAPI.list(query)
    if (request !== listRequest) return
    pageSize.value = result.pageSize
    total.value = result.total
    if (page.value > pages.value) {
      await changePage(pages.value)
      return
    }
    entries.value = result.items
    if (editing.value && !result.items.some(entry => entry.id === editing.value?.id)) editing.value = null
  } catch (error) {
    if (request === listRequest) queueError.value = errorMessage(error)
  } finally {
    if (request === listRequest) loading.value = false
  }
}

async function changePage(value: number) {
  page.value = value
  await loadEntries()
}

function toggleEntry(entry: FeedbackEntry) {
  if (saving.value) return
  editing.value = editing.value?.id === entry.id ? null : { ...entry }
  saveError.value = ''
  saveMessage.value = ''
}

async function refreshQueue() {
  if (saving.value) return
  editing.value = null
  await loadEntries()
}

async function saveEntry() {
  if (saving.value || !editing.value) return
  const { id, status, operatorNote, revision } = editing.value
  saving.value = true
  saveError.value = ''
  saveMessage.value = ''
  try {
    editing.value = await feedbackAPI.save(id, { status, operatorNote, revision })
    saveMessage.value = '已保存'
    await loadEntries()
  } catch (error) {
    saveError.value = errorMessage(error)
  } finally {
    saving.value = false
  }
}

onMounted(loadAccess)
onBeforeUnmount(clearScreenshots)
</script>

<style scoped>
.feedback-panel { max-width: 960px; }
.feedback-heading h2 { margin: 0; font-size: 22px; }
.feedback-heading p, .feedback-muted { color: var(--text-3); font-size: 13px; }
.feedback-heading p { margin: 6px 0 20px; }
.feedback-form { padding: 18px; display: grid; gap: 14px; }
.feedback-panel .field { display: grid; gap: 6px; margin: 0; }
.feedback-panel .input, .feedback-panel .textarea { width: 100%; box-sizing: border-box; }
.feedback-panel textarea { resize: vertical; }
.feedback-actions, .feedback-toolbar, .feedback-pagination { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.feedback-queue { margin-top: 24px; }
.feedback-toolbar { margin-bottom: 12px; }
.feedback-toolbar h3 { flex: 1; margin: 0; font-size: 16px; }
.feedback-toolbar .input { width: auto; }
.feedback-entry { overflow: hidden; margin-bottom: 8px; }
.feedback-entry-head { display: flex; width: 100%; align-items: center; gap: 10px; padding: 12px; background: transparent; border: 0; text-align: left; color: inherit; cursor: pointer; }
.feedback-entry-head:hover { background: var(--accent-bg); }
.feedback-entry-head strong { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.feedback-entry-head time, .feedback-meta dt { color: var(--text-3); font-size: 12px; }
.feedback-entry-body { border-top: 1px solid var(--border); padding: 14px; }
.feedback-description { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.feedback-meta { display: flex; flex-wrap: wrap; gap: 12px 20px; margin: 16px 0; }
.feedback-meta dd { margin: 4px 0 0; overflow-wrap: anywhere; }
.feedback-screenshots { display: flex; flex-wrap: wrap; gap: 10px; }
.feedback-entry-screenshots { margin-bottom: 16px; }
.feedback-screenshot { display: grid; gap: 4px; justify-items: start; }
.feedback-screenshot img { display: block; width: 132px; height: 90px; max-width: 100%; object-fit: contain; background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px; }
.feedback-update { display: grid; gap: 12px; }
.feedback-update select.input { width: auto; justify-self: start; }
.feedback-pagination { justify-content: flex-end; margin-top: 12px; }
.feedback-error { color: var(--danger, #ef8e8e); margin: 8px 0; }
.feedback-success { color: var(--success, #a3e2cc); font-size: 13px; }
@media (max-width: 600px) { .feedback-entry-head { flex-wrap: wrap; } .feedback-entry-head time { margin-left: auto; } }
</style>
