<template>
  <div ref="root" @keydown.esc="onEscape">
    <button
      ref="trigger"
      type="button"
      class="cine-icon release-bell"
      title="版本更新"
      :aria-label="hasUnread ? '版本更新，有未读更新' : '版本更新'"
      :aria-expanded="open"
      aria-controls="release-notes-panel"
      @click="togglePanel"
    >
      <Bell :size="17" aria-hidden="true" />
      <span v-if="hasUnread" class="release-dot" aria-hidden="true" />
    </button>
    <section
      v-show="open"
      id="release-notes-panel"
      ref="panel"
      class="release-panel"
      aria-labelledby="release-notes-title"
      tabindex="-1"
    >
      <header class="release-heading">
        <h2 id="release-notes-title">版本更新</h2>
        <button type="button" class="release-close" aria-label="关闭版本更新" @click="closePanel(true)">
          <X :size="16" aria-hidden="true" />
        </button>
      </header>
      <div v-if="notes.length" class="release-list">
        <article v-for="note in notes" :key="note.id" class="release-entry">
          <time :datetime="note.publishedAt">{{ formatDate(note.publishedAt) }}</time>
          <h3>{{ note.title }}</h3>
          <ul>
            <li v-for="(change, index) in note.changes" :key="index">{{ change }}</li>
          </ul>
        </article>
      </div>
      <div v-else class="release-status">
        <p role="status">{{ failed ? '暂时无法加载更新说明' : loaded ? '暂无更新记录' : '正在加载更新说明…' }}</p>
        <button v-if="failed" type="button" class="cine-icon" @click="refresh">重试</button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { Bell, X } from 'lucide-vue-next'
import { releaseNotesAPI, type ReleaseNote } from '~/composables/useApi'

const readKey = 'drama-plus.release-notes.last-read'
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' })
const route = useRoute()
const root = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const trigger = ref<HTMLButtonElement | null>(null)
const notes = ref<ReleaseNote[]>([])
const open = ref(false)
const loaded = ref(false)
const failed = ref(false)
const lastRead = ref(0)
const latestId = computed(() => notes.value[0]?.id ?? 0)
const hasUnread = computed(() => latestId.value > lastRead.value)
let disposed = false
let checking = false
let recheckAfterPublish = false
let pollId: number | undefined

function formatDate(value: string) {
  return dateFormat.format(new Date(value))
}

function syncReadState() {
  try {
    const saved = Number(localStorage.getItem(readKey))
    if (Number.isSafeInteger(saved)) lastRead.value = Math.max(lastRead.value, saved)
  } catch { /* Keep the in-memory state when storage is unavailable. */ }
}

function markRead() {
  syncReadState()
  if (!hasUnread.value) return
  lastRead.value = latestId.value
  try { localStorage.setItem(readKey, String(lastRead.value)) } catch { /* Storage is optional. */ }
}

async function refresh() {
  if (checking) return
  checking = true
  failed.value = false
  try {
    const { items } = await releaseNotesAPI.list()
    if (!Array.isArray(items)) throw new Error('Invalid release notes')
    if (disposed) return
    notes.value = items
    loaded.value = true
    if (open.value) markRead()
  } catch {
    if (!disposed) failed.value = true
  } finally {
    checking = false
    if (!disposed && recheckAfterPublish) {
      recheckAfterPublish = false
      void refresh()
    }
  }
}

async function togglePanel() {
  if (open.value) return closePanel()
  open.value = true
  markRead()
  void refresh()
  await nextTick()
  panel.value?.focus()
}

function closePanel(restoreFocus = false) {
  open.value = false
  if (restoreFocus) trigger.value?.focus()
}

function onEscape(event: KeyboardEvent) {
  if (!open.value) return
  event.stopPropagation()
  closePanel(true)
}

function onPointerDown(event: PointerEvent) {
  if (open.value && event.target instanceof Node && !root.value?.contains(event.target)) closePanel()
}

function checkWhenVisible() {
  if (!document.hidden) void refresh()
}

function onPublished() {
  if (checking) recheckAfterPublish = true
  else void refresh()
}

function onStorage(event: StorageEvent) {
  if (event.key === readKey) syncReadState()
}

watch(() => route.fullPath, () => closePanel())
onMounted(() => {
  syncReadState()
  checkWhenVisible()
  pollId = window.setInterval(checkWhenVisible, 60_000)
  document.addEventListener('visibilitychange', checkWhenVisible)
  document.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('storage', onStorage)
  window.addEventListener('release-notes-published', onPublished)
})
onBeforeUnmount(() => {
  disposed = true
  window.clearInterval(pollId)
  document.removeEventListener('visibilitychange', checkWhenVisible)
  document.removeEventListener('pointerdown', onPointerDown)
  window.removeEventListener('storage', onStorage)
  window.removeEventListener('release-notes-published', onPublished)
})
</script>

<style scoped>
.release-bell {
  position: relative;
  width: 34px;
  padding: 0;
}

.release-dot {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 7px;
  height: 7px;
  background: #ff887c;
  border: 1px solid var(--bg-1);
  border-radius: 50%;
}

.release-panel {
  position: absolute;
  top: calc(100% + 8px);
  right: clamp(20px, 3.5vw, 55px);
  display: flex;
  flex-direction: column;
  width: min(368px, calc(100vw - 32px));
  max-height: min(440px, calc(100dvh - 132px));
  color: var(--text-1);
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-elevated);
  font-size: 13px;
  outline: none;
}

.release-heading {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}

.release-heading h2,
.release-entry h3 {
  margin: 0;
  color: var(--text-0);
  font-size: 14px;
  font-weight: 600;
}

.release-close {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}

.release-close:hover {
  background: var(--bg-hover);
  color: var(--text-0);
}

.release-bell:focus-visible,
.release-close:focus-visible {
  outline: 2px solid var(--text-1);
  outline-offset: 2px;
}

.release-list {
  overflow-y: auto;
  overscroll-behavior: contain;
}

.release-entry,
.release-status { padding: 14px 16px 16px; }
.release-entry { overflow-wrap: anywhere; }
.release-entry + .release-entry { border-top: 1px solid var(--border); }
.release-entry time { display: block; margin-bottom: 5px; color: var(--text-2); font-size: 11px; }
.release-entry ul { margin: 6px 0 0; padding-inline-start: 18px; line-height: 1.65; }
.release-entry li + li { margin-top: 4px; }
.release-status p { margin: 0; color: var(--text-2); }
.release-status button { margin-top: 8px; }

@media (max-width: 840px) {
  .release-bell { width: 30px; }
  .release-panel { right: 16px; }
}
</style>
