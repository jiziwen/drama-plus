<template>
  <div class="page asset-gallery-page">
    <div class="welcome-heading">
      <div>
        <span class="soft-eyebrow">YOUR VISUAL WORLDS</span>
        <h1>故事里的每个细节，都在这里。</h1>
        <p>浏览和生成项目的角色、场景与道具。</p>
      </div>
      <BaseSelect class="gallery-project-select" v-model="selectedProject"
        :options="projects.map(project => ({ value: project.id, label: project.title }))"
        :disabled="!projects.length" aria-label="选择资产所属项目" />
    </div>

    <div class="gallery-controls">
      <div class="seg">
        <button v-for="kind in kinds" :key="kind.key" type="button" class="seg-item"
          :class="{ on: filter === kind.key }" :aria-pressed="filter === kind.key" @click="filter = kind.key">
          {{ kind.label }}
        </button>
      </div>
      <label class="gallery-search">
        <Search :size="16" />
        <input class="input" v-model.trim="search" placeholder="搜索资产…" aria-label="搜索资产" />
        <button v-if="isCinematic && search" type="button" class="gallery-search-clear" aria-label="清除资产搜索" @click="search = ''">
          <X :size="14" />
        </button>
      </label>
      <button v-if="selectedProject" type="button" class="btn btn-primary" aria-haspopup="dialog"
        :disabled="loading" @click="openEditor()"><Plus :size="16" /> 新增资产</button>
      <NuxtLink v-if="selectedProject" class="btn" :to="`/drama/${selectedProject}?tab=assets`">
        <Pencil :size="14" /> 管理项目资产
      </NuxtLink>
    </div>

    <div v-if="notice" class="gallery-notice" role="alert">
      <span>{{ notice }}</span>
      <button type="button" class="btn btn-sm" @click="notice = ''">关闭</button>
    </div>

    <div v-if="loading" class="empty-state"><LoaderCircle class="animate-spin" :size="28" /><p>正在打开你的视觉世界…</p></div>
    <div v-else-if="error" class="empty-state" role="alert">
      <p>{{ error }}</p><button type="button" class="btn" @click="loadProjects">重新加载</button>
    </div>
    <div v-else-if="!projects.length" class="empty-state">
      <FolderKanban :size="32" /><h2>先为故事创建一个家。</h2><p>创建项目后，就可以为它生成资产。</p>
      <NuxtLink class="btn btn-primary" to="/">前往创作台</NuxtLink>
    </div>
    <div v-else-if="!visibleAssets.length" class="empty-state">
      <div v-if="isCinematic && !search" class="gallery-empty-art" aria-hidden="true">
        <div class="gallery-echo-card echo-left"><UsersRound :size="24" /><span>角色</span></div>
        <div class="gallery-echo-card echo-right"><Box :size="24" /><span>道具</span></div>
        <div class="gallery-echo-card echo-front"><Mountain :size="30" /><span>场景</span></div>
        <Sparkles class="gallery-empty-spark" :size="18" />
      </div>
      <Search v-else-if="isCinematic && search" class="gallery-empty-symbol" :size="32" />
      <Images v-else :size="32" />
      <h2>{{ search ? '没有找到匹配的资产' : '这里还没有资产' }}</h2>
      <button v-if="search" type="button" class="btn gallery-empty-action" @click="search = ''">清除搜索 <X :size="14" /></button>
      <button v-else type="button" class="btn gallery-empty-action" aria-haspopup="dialog" @click="openEditor()">新增资产 <Plus :size="15" /></button>
    </div>

    <div v-else class="gallery-grid">
      <article v-for="asset in visibleAssets" :key="`${asset.kind}-${asset.id}`" class="gallery-card card">
        <div class="gallery-art" :class="{ 'gallery-art-fit': asset.aspect }">
          <button v-if="imageOf(asset)" type="button" class="gallery-preview-trigger"
            :aria-label="`查看${asset.name}大图`" aria-haspopup="dialog" title="点击查看大图" @click="openPreview(asset)">
            <img :key="imageOf(asset)" :src="thumbOf(imageOf(asset))" :alt="asset.name" loading="lazy"
              @error="thumbFallback($event, imageOf(asset))" />
          </button>
          <span v-else class="gallery-initial">{{ asset.name.slice(0, 1) || '·' }}</span>
          <span class="gallery-kind">{{ kindLabels[asset.kind] }}</span>
        </div>
        <div class="gallery-copy">
          <h2><NuxtLink class="gallery-card-link" :to="`/drama/${selectedProject}?tab=assets`">{{ asset.name }}<ArrowUpRight :size="17" /></NuxtLink></h2>
          <p>{{ asset.description || '尚未填写视觉描述' }}</p>
          <div class="gallery-card-footer">
            <div class="gallery-card-status" :class="{ 'gallery-failed': asset.task?.status === 'failed' }">
              <span><LoaderCircle v-if="isGenerating(asset)" :size="13" class="animate-spin" /> {{ assetStatus(asset) }}</span>
              <span v-if="asset.aspect" class="gallery-ratio">{{ asset.aspect }}</span>
            </div>
            <div class="gallery-card-actions">
              <button v-if="asset.task?.canRetryDelivery" type="button" class="btn btn-sm"
                :disabled="isGenerating(asset)" @click="retryImageDelivery(asset)">
                <Download :size="13" /> 重试取图
              </button>
              <button type="button" class="btn btn-sm" aria-haspopup="dialog" :disabled="isGenerating(asset)"
                :aria-label="`${generationLabel(asset)}${asset.name}`" @click="openEditor(asset)">
                <RotateCcw :size="13" /> {{ generationLabel(asset) }}
              </button>
              <button type="button" class="btn btn-sm btn-danger" :aria-label="`删除${asset.name}`" title="删除资产"
                :disabled="isGenerating(asset)" @click="confirmDelete(asset)"><Trash2 :size="14" /></button>
            </div>
          </div>
          <div v-if="!isGenerating(asset) && asset.task?.error" class="gallery-task-message"
            :class="{ 'gallery-failed': asset.task.status === 'failed' }">{{ asset.task.error }}</div>
        </div>
      </article>
    </div>

    <Teleport to="body">
      <dialog ref="previewDialog" class="gallery-image-dialog" :aria-label="`${previewAsset?.name ?? '资产'}大图`"
        @click="closePreviewOnBackdrop" @close="previewAsset = null">
        <div class="gallery-image-head">
          <h2>{{ previewAsset?.name }}</h2>
          <button type="button" class="btn btn-icon" aria-label="关闭大图" @click="previewDialog?.close()"><X :size="18" /></button>
        </div>
        <div class="gallery-image-body"><img v-if="previewAsset" :src="previewAsset.image" :alt="previewAsset.name" /></div>
      </dialog>
      <dialog ref="editorDialog" class="gallery-editor" aria-labelledby="gallery-editor-title" @cancel="onEditorCancel" @close="onEditorClose">
        <form v-if="editor" @submit.prevent="submitEditor">
          <header class="gallery-editor-head">
            <div>
              <h2 id="gallery-editor-title">{{ editor.id ? editor.action : '新增资产' }}</h2>
              <span>{{ editor.id ? editor.name : projectTitle }}</span>
            </div>
            <button type="button" class="btn btn-icon" aria-label="关闭资产表单" :disabled="saving" @click="editorDialog?.close()"><X :size="17" /></button>
          </header>
          <div class="gallery-editor-body">
            <div v-if="!editor.id" class="gallery-editor-fields">
              <label>资产名称（可选）<input v-model.trim="editor.name" class="input" placeholder="留空时根据提示词命名" maxlength="120" :disabled="saving" /></label>
              <label>资产类型
                <select v-model="editor.kind" class="input" :disabled="saving">
                  <option v-for="(label, kind) in kindLabels" :key="kind" :value="kind">{{ label }}</option>
                </select>
              </label>
            </div>
            <label>生图提示词
              <textarea v-model.trim="editor.prompt" class="textarea" rows="5" maxlength="12000" required :disabled="saving"
                placeholder="描述主体、场景、构图或光线…" />
            </label>
            <div class="gallery-editor-fields">
              <fieldset :disabled="saving">
                <legend>尺寸</legend>
                <div class="gallery-aspects">
                  <label v-for="size in GALLERY_IMAGE_ASPECTS" :key="size" class="gallery-aspect" :class="{ selected: editor.aspect === size }">
                    <input type="radio" name="gallery-aspect" :value="size" v-model="editor.aspect" />
                    {{ size }}
                  </label>
                </div>
              </fieldset>
              <label>生图模型
                <select v-model="editor.modelKey" class="input" required :disabled="saving || loadingModels || !models.length">
                  <option value="" disabled>{{ loadingModels ? '正在加载模型…' : '请选择生图模型' }}</option>
                  <option v-for="model in models" :key="modelKey(model)" :value="modelKey(model)">{{ model.model }} · {{ model.configName }}</option>
                </select>
              </label>
            </div>
            <div v-if="!loadingModels && !models.length" class="gallery-model-hint">
              <span>{{ modelError || '请先在设置中启用生图模型。' }}</span>
              <button v-if="modelError" type="button" class="btn btn-sm" @click="loadModels">重试</button>
              <button v-else type="button" class="btn btn-sm" @click="goToModelSettings">前往设置</button>
            </div>
            <p v-if="editorError" class="gallery-editor-error" role="alert">{{ editorError }}</p>
          </div>
          <footer class="gallery-editor-actions">
            <button type="button" class="btn" :disabled="saving" @click="editorDialog?.close()">取消</button>
            <button type="submit" class="btn btn-primary" :disabled="!canGenerate">
              <LoaderCircle v-if="saving" :size="15" class="animate-spin" /><Sparkles v-else :size="15" />
              {{ saving ? '正在提交…' : editor.id ? editor.action : '创建并生成' }}
            </button>
          </footer>
        </form>
      </dialog>
    </Teleport>

    <ConfirmDialog :open="Boolean(deleteTarget)" title="删除资产" confirm-text="删除资产" :loading="deleting"
      :message="`确定删除「${deleteTarget?.asset.name ?? ''}」？它会从该项目的资产列表移除。`"
      @confirm="deleteAsset" @cancel="cancelDelete" />
  </div>
</template>

<script setup lang="ts">
import { Search, Pencil, LoaderCircle, FolderKanban, Images, ArrowUpRight, UsersRound, Mountain, Box, Sparkles, X, Plus, RotateCcw, Trash2, Download } from 'lucide-vue-next'
import { galleryAssetAPI, listAllDramas, taskAPI } from '~/composables/useApi'
import { thumbOf, thumbFallback } from '~/composables/useMedia'
import { GALLERY_IMAGE_ASPECTS, type GalleryAsset, type GalleryAssetKind, type GalleryImageAspect } from '../../../backend/src/services/gallery-asset-types'
import type { ProjectModelOption } from '../../../backend/src/services/project-model-options'

const kindLabels: Record<GalleryAssetKind, string> = { characters: '角色', scenes: '场景', props: '道具' }
const kinds: { key: 'all' | GalleryAssetKind; label: string }[] = [
  { key: 'all', label: '全部资产' },
  { key: 'characters', label: '角色' },
  { key: 'scenes', label: '场景' },
  { key: 'props', label: '道具' },
]
type Editor = {
  projectId: number
  id?: number
  kind: GalleryAssetKind
  name: string
  prompt: string
  aspect: GalleryImageAspect
  modelKey: string
  action: string
}

const { isCinematic } = useStudioInterface()
const { open: openSettings } = useSettingsPanel()
const projects = ref<{ id: number; title: string }[]>([])
const selectedProject = ref<number | null>(null)
const assets = ref<GalleryAsset[]>([])
const filter = ref<'all' | GalleryAssetKind>('all')
const search = ref('')
const loading = ref(true)
const error = ref('')
const notice = ref('')
const editor = ref<Editor | null>(null)
const editorDialog = ref<HTMLDialogElement>()
const previewDialog = ref<HTMLDialogElement>()
const previewAsset = ref<{ name: string; image: string } | null>(null)
const editorError = ref('')
const saving = ref(false)
const models = ref<ProjectModelOption[]>([])
const loadingModels = ref(false)
const modelError = ref('')
const deleteTarget = ref<{ projectId: number; asset: GalleryAsset } | null>(null)
const deleting = ref(false)
const recovering = ref(new Set<number>())
let requestId = 0
let modelRequestId = 0
let pollTimer: ReturnType<typeof setTimeout> | undefined
let alive = true

const projectTitle = computed(() => projects.value.find(project => project.id === selectedProject.value)?.title)
const visibleAssets = computed(() => assets.value.filter(asset =>
  (filter.value === 'all' || asset.kind === filter.value)
  && [asset.name, asset.description, asset.prompt].join(' ').toLowerCase().includes(search.value.toLowerCase()),
))
const modelKey = (model: { configId: number; model: string }) => `${model.configId}/${model.model}`
const chosenModel = computed(() => models.value.find(model => modelKey(model) === editor.value?.modelKey))
const canGenerate = computed(() => Boolean(editor.value?.prompt.trim() && chosenModel.value && !saving.value && !loadingModels.value))
const isRecovering = (asset: GalleryAsset) => !!asset.task && recovering.value.has(asset.task.id)
const isGenerating = (asset: GalleryAsset) => asset.task?.status === 'processing' || isRecovering(asset)
const generationLabel = (asset: GalleryAsset) => asset.image || asset.task ? '重新生成' : '生成图片'

function imageOf(asset: GalleryAsset) {
  const source = asset.image || ''
  return source && !source.startsWith('/') && !/^https?:\/\//i.test(source) ? `/${source}` : source
}

async function openPreview(asset: GalleryAsset) {
  const image = imageOf(asset)
  if (!image || previewDialog.value?.open) return
  previewAsset.value = { name: asset.name, image }
  await nextTick()
  previewDialog.value?.showModal()
}

function closePreviewOnBackdrop(event: MouseEvent) {
  const dialog = previewDialog.value
  if (!dialog || event.target !== dialog) return
  const rect = dialog.getBoundingClientRect()
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close()
}

function assetStatus(asset: GalleryAsset) {
  if (isRecovering(asset) || (asset.task?.status === 'processing' && asset.task.stage === 'downloading')) return '已生成，取图中'
  if (asset.task?.status === 'processing' && asset.task.stage === 'saving') return '保存图片中'
  if (asset.task?.status === 'delivery_pending') return asset.task.canRetryDelivery ? '已生成，待取回' : '已生成，保存中断'
  if (isGenerating(asset)) return '生成中'
  if (asset.task?.status === 'failed') return asset.image ? '生成失败，保留旧图' : '生成失败'
  return asset.image ? '图片已就绪' : '等待生成'
}

function messageOf(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback
}

async function loadDetail(id: number | null, background = false) {
  const request = ++requestId
  clearTimeout(pollTimer)
  if (!background) {
    loading.value = Boolean(id)
    assets.value = []
    error.value = ''
  }
  if (!id) return
  try {
    const result = await galleryAssetAPI.list(id)
    if (request === requestId) assets.value = result
  } catch (cause) {
    if (request === requestId) {
      if (!background) error.value = messageOf(cause, '加载资产失败')
      else if (!assets.value.some(isGenerating)) notice.value = '暂时无法刷新资产，请重新加载页面。'
    }
  } finally {
    if (request === requestId) {
      loading.value = false
      if (assets.value.some(isGenerating)) pollTimer = setTimeout(() => void loadDetail(id, true), 2200)
    }
  }
}

async function loadProjects() {
  loading.value = true
  error.value = ''
  try {
    const result = await listAllDramas()
    if (!alive) return
    projects.value = result
    const id = result.find(project => project.id === selectedProject.value)?.id ?? result[0]?.id ?? null
    if (selectedProject.value === id) await loadDetail(id)
    else selectedProject.value = id
  } catch (cause) {
    if (!alive) return
    error.value = messageOf(cause, '加载项目失败')
    loading.value = false
  }
}

async function loadModels(preferredConfigId?: number | null) {
  const request = ++modelRequestId
  loadingModels.value = true
  modelError.value = ''
  models.value = []
  try {
    const result = await galleryAssetAPI.models()
    if (request !== modelRequestId || !editor.value) return
    models.value = result
    if (!result.some(model => modelKey(model) === editor.value?.modelKey)) {
      const fallback = result.find(model => model.configId === preferredConfigId) ?? result[0]
      editor.value.modelKey = fallback ? modelKey(fallback) : ''
    }
  } catch (cause) {
    if (request === modelRequestId) modelError.value = messageOf(cause, '无法加载生图模型')
  } finally {
    if (request === modelRequestId) loadingModels.value = false
  }
}

async function openEditor(asset?: GalleryAsset) {
  if (!selectedProject.value || saving.value || editorDialog.value?.open) return
  const kind = asset?.kind ?? (filter.value === 'all' ? 'characters' : filter.value)
  editor.value = {
    projectId: selectedProject.value,
    id: asset?.id,
    kind,
    name: asset?.name ?? '',
    prompt: asset?.prompt ?? '',
    aspect: asset?.aspect ?? (kind === 'props' ? '1:1' : '16:9'),
    modelKey: asset?.configId && asset.model ? modelKey({ configId: asset.configId, model: asset.model }) : '',
    action: asset ? generationLabel(asset) : '创建并生成',
  }
  editorError.value = ''
  notice.value = ''
  const loadingOptions = loadModels(asset?.configId)
  await nextTick()
  editorDialog.value?.showModal()
  await loadingOptions
}

function onEditorCancel(event: Event) {
  if (saving.value) event.preventDefault()
}

function onEditorClose() {
  modelRequestId++
  editor.value = null
}

function goToModelSettings() {
  editorDialog.value?.close()
  openSettings('ai')
}

async function submitEditor() {
  const form = editor.value
  const model = chosenModel.value
  if (!canGenerate.value || !form || !model) return
  const input = { prompt: form.prompt, aspect: form.aspect, model: model.model, configId: model.configId }
  saving.value = true
  editorError.value = ''
  try {
    if (form.id) {
      await galleryAssetAPI.generate(form.projectId, form.kind, form.id, input)
    } else {
      const result = await galleryAssetAPI.create(form.projectId, { ...input, name: form.name, kind: form.kind })
      form.id = result.id
      form.name = result.name
      search.value = ''
      if (filter.value !== 'all') filter.value = form.kind
      if (!result.taskId) {
        form.action = '生成图片'
        editorError.value = result.error || '资产已创建，请重试生成图片。'
        if (selectedProject.value === form.projectId) await loadDetail(form.projectId, true)
        return
      }
    }
    editorDialog.value?.close()
    if (selectedProject.value === form.projectId) await loadDetail(form.projectId, true)
  } catch (cause) {
    editorError.value = messageOf(cause, '提交生图任务失败')
  } finally {
    saving.value = false
  }
}

async function retryImageDelivery(asset: GalleryAsset) {
  const projectId = selectedProject.value
  const task = asset.task
  if (!projectId || !task?.canRetryDelivery || isGenerating(asset)) return
  recovering.value.add(task.id)
  notice.value = ''
  try {
    await taskAPI.recover(task.id)
    if (alive && selectedProject.value === projectId) await loadDetail(projectId, true)
  } catch (cause) {
    if (alive && selectedProject.value === projectId) notice.value = messageOf(cause, '暂时无法取回原图')
  } finally {
    recovering.value.delete(task.id)
  }
}

function confirmDelete(asset: GalleryAsset) {
  if (!selectedProject.value) return
  notice.value = ''
  deleteTarget.value = { projectId: selectedProject.value, asset }
}

function cancelDelete() {
  if (!deleting.value) deleteTarget.value = null
}

async function deleteAsset() {
  const target = deleteTarget.value
  if (!target || deleting.value) return
  deleting.value = true
  try {
    await galleryAssetAPI.delete(target.projectId, target.asset.kind, target.asset.id)
    if (selectedProject.value === target.projectId) await loadDetail(target.projectId, true)
  } catch (cause) {
    notice.value = messageOf(cause, '删除资产失败')
  } finally {
    deleting.value = false
    deleteTarget.value = null
  }
}

watch(selectedProject, id => {
  notice.value = ''
  void loadDetail(id)
})
onMounted(loadProjects)
onBeforeUnmount(() => {
  alive = false
  requestId++
  modelRequestId++
  clearTimeout(pollTimer)
})
</script>

<style scoped>
.gallery-controls > .btn { white-space: nowrap; }
.gallery-notice { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; color: var(--action-danger); }
.gallery-card-link { color: inherit; display: block; text-decoration: none; }
.gallery-copy h2 .gallery-card-link { display: flex; justify-content: space-between; align-items: center; gap: 10px; width: 100%; overflow-wrap: anywhere; }
.gallery-copy h2 .gallery-card-link svg { flex-shrink: 0; }
.gallery-preview-trigger { width: 100%; height: 100%; padding: 0; border: 0; background: transparent; cursor: zoom-in; }
.gallery-preview-trigger:focus-visible { outline: 2px solid var(--accent); outline-offset: -3px; }
.gallery-preview-trigger img { display: block; width: 100%; height: 100%; object-fit: cover; }
.gallery-grid .gallery-art-fit .gallery-preview-trigger img { object-fit: contain; }
.gallery-kind { pointer-events: none; }
.gallery-card-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; column-gap: 8px; row-gap: 7px; padding-top: 10px; border-top: 1px solid var(--surface-outline); }
.gallery-card-status, .gallery-card-status > span, .gallery-card-actions { display: flex; align-items: center; gap: 5px; }
.gallery-card-status { flex-wrap: wrap; color: var(--text-2); font-size: 11px; }
.gallery-ratio { border: 1px solid var(--surface-outline); padding: 1px 5px; border-radius: 5px; font-variant-numeric: tabular-nums; }
.gallery-card-actions .btn { min-height: 28px; gap: 5px; padding-inline: 8px; }
.gallery-card-actions { flex-wrap: wrap; }
.gallery-task-message { margin-top: 8px; color: var(--text-2); font-size: 11px; overflow-wrap: anywhere; }
.gallery-editor-error, .gallery-failed { color: var(--action-danger); }

.gallery-image-dialog { width: min(1200px, 94vw); max-width: 94vw; max-height: 92dvh; margin: auto; padding: 0; overflow: hidden; border: 1px solid var(--surface-outline-strong); border-radius: 14px; background: var(--surface-raised); color: var(--text-1); }
.gallery-image-dialog::backdrop { background: rgb(0 0 0 / 75%); }
.gallery-image-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--surface-outline); }
.gallery-image-head h2 { min-width: 0; margin: 0; overflow-wrap: anywhere; font-size: 15px; color: var(--text-0); }
.gallery-image-head button { flex-shrink: 0; }
.gallery-image-body { display: grid; place-items: center; padding: 12px; overflow: auto; max-height: calc(92dvh - 58px); }
.gallery-image-body img { display: block; max-width: 100%; max-height: calc(92dvh - 82px); object-fit: contain; }

.gallery-editor { width: min(570px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); margin: auto; padding: 0; border: 1px solid var(--surface-outline-strong); border-radius: 15px; background: var(--surface-raised); color: var(--text-1); box-shadow: var(--shadow-elevated); }
.gallery-editor::backdrop { background: rgb(0 0 0 / 58%); }
.gallery-editor-head, .gallery-editor-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 16px 20px; }
.gallery-editor-head { border-bottom: 1px solid var(--surface-outline); }
.gallery-editor-head h2 { margin: 0; font-size: 18px; color: var(--text-0); }
.gallery-editor-head span { color: var(--text-3); font-size: 12px; overflow-wrap: anywhere; }
.gallery-editor-body { display: grid; gap: 14px; padding: 18px 20px; }
.gallery-editor-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.gallery-editor-body label { display: grid; gap: 5px; font-size: 13px; }
.gallery-editor-body .input, .gallery-editor-body .textarea { width: 100%; }
.gallery-editor-body .textarea { min-height: 118px; resize: vertical; }
.gallery-editor-body select.input { min-height: 36px; color-scheme: inherit; }
.gallery-editor-body fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
.gallery-editor-body legend { padding: 0 0 5px; font-size: 13px; }
.gallery-aspects { display: flex; flex-wrap: wrap; gap: 4px; }
.gallery-editor-body .gallery-aspect { display: inline-flex; align-items: center; gap: 4px; padding: 5px 6px; min-height: 36px; border: 1px solid var(--surface-outline); border-radius: 7px; cursor: pointer; font-variant-numeric: tabular-nums; }
.gallery-aspect input { margin: 0; accent-color: var(--accent); }
.gallery-aspect.selected { border-color: var(--accent); background: var(--accent-bg); }
.gallery-model-hint { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 12px; color: var(--text-3); }
.gallery-editor-error { font-size: 13px; overflow-wrap: anywhere; }
.gallery-editor-actions { justify-content: flex-end; border-top: 1px solid var(--surface-outline); }
@media (max-width: 480px) { .gallery-editor-fields { grid-template-columns: minmax(0, 1fr); } }
</style>
