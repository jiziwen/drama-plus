<template>
  <div class="novel-workbench">
    <header class="novel-header">
      <div class="novel-identity">
        <span class="novel-mark"><BookOpen :size="23" aria-hidden="true" /></span>
        <div>
          <h1>小说转剧本</h1>
          <p>把小说编排成短剧分镜，再从全书分镜提取生图资产。</p>
        </div>
      </div>
      <NuxtLink v-if="projectId" class="btn" :to="{ query: directoryQuery }">
        <ArrowLeft :size="16" /> 返回项目列表
      </NuxtLink>
      <button v-else-if="projects.length && !showImport" class="btn" type="button" :disabled="sending || loading" @click="showImport = true">
        <Plus :size="16" /> 导入新小说
      </button>
    </header>

    <div v-if="error" class="novel-notice novel-error" role="alert">
      <CircleAlert :size="17" /> {{ error }}
      <button v-if="projectId ? !project : !directoryLoaded" class="btn btn-sm" type="button" @click="openProject(projectId)">重试读取</button>
      <button v-else-if="conflict && project" class="btn btn-sm" type="button" @click="reloadProject">读取最新进度</button>
    </div>

    <div v-if="loading" class="novel-paper novel-empty" role="status">
      <LoaderCircle class="novel-spin" :size="23" /> 正在读取小说项目…
    </div>

    <form v-else-if="!projectId && directoryLoaded && (showImport || !projects.length)" class="novel-paper novel-import" @submit.prevent="importNovel">
      <div>
        <h2>导入小说</h2>
        <p>支持 TXT、Markdown，单个文件最多 8 MB。按章节标题自动拆分。</p>
      </div>
      <label class="novel-upload">
        <Upload :size="22" aria-hidden="true" />
        <span>{{ file?.name || '选择小说文件' }}</span>
        <input type="file" accept=".txt,.md,text/plain,text/markdown" :disabled="sending" @change="chooseFile">
      </label>
      <fieldset class="novel-pace" :disabled="sending">
        <legend>分镜节奏</legend>
        <label><input v-model="importPace" type="radio" name="import-pace" value="fast"> 快节奏</label>
        <label><input v-model="importPace" type="radio" name="import-pace" value="normal"> 正常节奏</label>
      </fieldset>
      <label class="novel-field">改编要求（可选）
        <textarea v-model="adaptationNotes" rows="2" maxlength="2000" placeholder="例如：淡化擦边或迷信元素，保留主线和人物关系。" :disabled="sending" />
      </label>
      <div class="novel-actions">
        <button class="btn btn-primary" type="submit" :disabled="!file || sending">
          <LoaderCircle v-if="sending" class="novel-spin" :size="16" /><ArrowRight v-else :size="16" /> {{ sending ? '正在导入' : '导入并拆章' }}
        </button>
        <button v-if="projects.length" class="btn" type="button" :disabled="sending" @click="showImport = false">取消</button>
      </div>
    </form>

    <section v-else-if="!projectId && directoryLoaded" class="novel-paper">
      <h2>小说项目</h2>
      <ul class="novel-project-list">
        <li v-for="item in projects" :key="item.id">
          <div class="novel-project-heading">
            <h3>{{ item.title }}</h3>
            <p>{{ item.fileName }}</p>
          </div>
          <div class="novel-actions">
            <NuxtLink class="btn" :to="{ query: { ...directoryQuery, project: item.id } }" :aria-label="'打开项目 ' + item.title">
              打开项目 <ArrowRight :size="15" />
            </NuxtLink>
            <button class="btn novel-delete-trigger" type="button" :disabled="deleting" :aria-label="'删除项目 ' + item.title"
              @click="requestDelete(item)">
              <Trash2 :size="15" /> 删除
            </button>
          </div>
        </li>
      </ul>
    </section>

    <template v-else-if="project && project.id === projectId">
      <section class="novel-paper novel-project">
        <div class="novel-project-top">
          <div class="novel-project-heading">
            <h2>{{ project.title }}</h2>
            <p>{{ project.fileName }} · {{ finished }} / {{ project.chapters.length }} 章已生成</p>
          </div>
          <div class="novel-actions">
            <label class="novel-inline-field">分镜节奏
              <select :value="project.pace" :disabled="busy" aria-label="分镜节奏" @change="changePace">
                <option value="fast">快节奏</option>
                <option value="normal">正常节奏</option>
              </select>
            </label>
            <button v-if="!allChapters" class="btn btn-primary" type="button" :disabled="busy" @click="send({ action: 'generate' })">
              <Sparkles :size="16" /> {{ finished ? '继续生成剩余章节' : '生成整本分镜' }}
            </button>
          </div>
        </div>
        <div class="novel-models" role="group" aria-label="项目生成模型">
          <div v-for="menu in modelMenus" :key="menu.kind" class="novel-model">
            <span>{{ menu.label }}</span>
            <BaseSelect
              :model-value="menu.value"
              :options="menu.options"
              :aria-label="menu.label"
              :searchable="menu.options.length > 8"
              :disabled="busy || modelsLoading || modelsError"
              variant="inspector"
              @update:model-value="selectModel(menu.kind, $event)"
            />
          </div>
          <small v-if="modelsLoading" role="status">正在读取模型…</small>
          <button v-else-if="modelsError" class="btn btn-sm" type="button" @click="loadModels">重试读取模型</button>
          <button v-else-if="missingModelKinds" class="btn btn-sm" type="button" @click="openSettings('ai')">
            配置{{ missingModelKinds }}
          </button>
        </div>
        <progress :value="finished" :max="project.chapters.length" aria-label="分镜章节完成进度" />
        <details v-if="project.adaptationNotes" class="novel-details">
          <summary>项目改编要求</summary>
          <p class="novel-prose">{{ project.adaptationNotes }}</p>
        </details>
      </section>

      <div v-if="project.job?.status === 'running'" class="novel-notice" role="status">
        <LoaderCircle class="novel-spin" :size="17" />
        <span>{{ project.job.chapter ? '第 ' + project.job.chapter + ' 章 · ' : '' }}{{ project.job.phase }}…</span>
        <button v-if="project.job.action !== 'image'" class="btn btn-sm" type="button" :disabled="sending" @click="send({ action: 'stop', jobId: project.job.id })">停止</button>
      </div>
      <div v-else-if="project.job?.status === 'failed'" class="novel-notice novel-error" role="alert">
        <CircleAlert :size="17" /> {{ project.job.chapter ? '第 ' + project.job.chapter + ' 章 · ' : '' }}{{ project.job.error }}
      </div>
      <div v-else-if="project.job?.status === 'stopped'" class="novel-notice" role="status">
        已停止。已完成的章节可以继续查看。
      </div>
      <p v-if="pollError" class="novel-notice novel-error" role="status">暂时无法刷新后台进度，正在重试。</p>

      <nav class="novel-switch" aria-label="小说工作台">
        <button type="button" :aria-pressed="view === 'chapters'" @click="view = 'chapters'"><Clapperboard :size="16" /> 章节分镜</button>
        <button type="button" :aria-pressed="view === 'assets'" @click="view = 'assets'"><Images :size="16" /> 全书资产 <span v-if="project.assetsCurrent">· {{ project.assets.length }}</span></button>
      </nav>

      <div v-if="view === 'chapters'" class="novel-chapter-layout">
        <aside class="novel-paper novel-catalog">
          <h2>章节目录</h2>
          <div class="novel-chapter-list">
            <button v-for="item in project.chapters" :key="item.number" type="button"
              :aria-current="selectedNumber === item.number ? 'true' : undefined" @click="selectChapter(item.number)">
              <span class="novel-chapter-number">{{ String(item.number).padStart(2, '0') }}</span>
              <span class="novel-chapter-title">{{ item.title }}</span>
              <LoaderCircle v-if="project.job?.status === 'running' && project.job.chapter === item.number" class="novel-spin" :size="15" aria-label="处理中" />
              <Check v-else-if="item.version" :size="15" aria-label="已生成" />
            </button>
          </div>
        </aside>

        <section class="novel-paper novel-chapter">
          <template v-if="selected">
            <div class="novel-project-top">
              <div class="novel-project-heading">
                <h2>{{ selected.title }}</h2>
                <p v-if="storyboard">{{ storyboard.segments.length }} 段 · {{ storyboard.segments.length * 30 }} 秒 · {{ paceLabel(storyboard.pace) }} · 第 {{ storyboard.version }} 版</p>
                <p v-else>每段分镜 30 秒，按章节顺序编排。</p>
              </div>
              <div class="novel-actions">
                <button v-if="storyboard" class="btn" type="button" @click="downloadChapter"><Download :size="15" /> 下载本章</button>
                <button v-if="canGenerateChapter" class="btn" :class="{ 'btn-primary': !selected.version }" type="button" :disabled="busy"
                  @click="selected.version ? revising = !revising : generateChapter()">
                  <RotateCcw v-if="selected.version" :size="15" /><Sparkles v-else :size="15" /> {{ selected.version ? '重新生成本章' : '生成本章' }}
                </button>
              </div>
            </div>
            <form v-if="revising" class="novel-revise" @submit.prevent="generateChapter">
              <label class="novel-field">本章调整要求（可选）
                <textarea v-model="notes" rows="2" maxlength="2000" placeholder="例如：压短开场，保留发现证据时的原话。" :disabled="busy" />
              </label>
              <div class="novel-actions">
                <button class="btn btn-primary" type="submit" :disabled="busy">按{{ paceLabel(project.pace) }}重生成</button>
                <button class="btn" type="button" @click="revising = false">取消</button>
              </div>
            </form>
            <div class="novel-switch novel-chapter-tabs" aria-label="章节内容">
              <button type="button" :aria-pressed="chapterView === 'shots'" @click="chapterView = 'shots'">分镜</button>
              <button type="button" :aria-pressed="chapterView === 'source'" @click="chapterView = 'source'">小说原文</button>
            </div>
            <div v-if="chapterError" class="novel-notice novel-error" role="alert">
              {{ chapterError }} <button class="btn btn-sm" type="button" @click="loadChapter">重新读取</button>
            </div>
            <div v-else-if="chapterLoading && !chapter" class="novel-empty" role="status">
              <LoaderCircle class="novel-spin" :size="20" /> 正在读取本章…
            </div>
            <p v-else-if="chapterView === 'source'" class="novel-prose">{{ chapter?.source }}</p>
            <template v-else-if="storyboard">
              <details class="novel-details">
                <summary>本章事件链、画面规格与人物声音</summary>
                <p class="novel-prose">{{ storyboard.summary }}</p>
                <p>{{ storyboard.visualStyle }}</p>
                <dl v-if="storyboard.voices.length" class="novel-segment-meta">
                  <template v-for="voice in storyboard.voices" :key="voice.name">
                    <dt>{{ voice.name }}</dt><dd>{{ voice.appearance }}。{{ voice.voice }}</dd>
                  </template>
                </dl>
                <p v-if="storyboard.screens" class="novel-prose">{{ storyboard.screens }}</p>
              </details>
              <details v-for="(segment, index) in storyboard.segments" :key="storyboard.version + ':' + index" class="novel-details novel-segment" :open="index === 0">
                <summary><strong>视频编号 {{ numberLabel(index + 1) }}</strong><span>{{ segment.scene }}</span><span class="novel-tag">{{ segment.combat ? '高燃打斗 · ' : '' }}30 秒</span></summary>
                <dl class="novel-segment-meta">
                  <dt>承上</dt><dd>{{ segment.incoming }}</dd>
                  <dt>人物</dt><dd>{{ segment.cast.join('、') || '无' }}</dd>
                  <dt>独立生成</dt><dd>{{ segment.direction }}</dd>
                </dl>
                <div class="novel-table-wrap">
                  <table class="novel-table">
                    <thead><tr><th>镜号</th><th>时长</th><th>景别／机位／运动</th><th>画面与动作</th><th>对白／音效</th></tr></thead>
                    <tbody>
                      <tr v-for="(shot, shotIndex) in segment.shots" :key="shotIndex">
                        <td>{{ numberLabel(shotIndex + 1) }}</td><td>{{ shot.seconds }} 秒</td><td>{{ shot.camera }}</td><td>{{ shot.action }}</td><td>{{ shot.sound }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p class="novel-outgoing"><strong>衔接</strong> {{ segment.outgoing }}</p>
              </details>
              <details class="novel-details"><summary>台词与逻辑复核</summary><p class="novel-prose">{{ storyboard.review }}</p></details>
            </template>
            <div v-else class="novel-empty">
              <Clapperboard :size="24" />
              {{ canGenerateChapter ? '本章分镜尚未生成。' : '生成前面的章节后，就可以编排本章。' }}
            </div>
          </template>
        </section>
      </div>

      <section v-else class="novel-paper">
        <div class="novel-project-top">
          <div>
            <h2>全书资产</h2>
            <p v-if="project.assetsCurrent">{{ project.assets.length }} 项 · 从全部分镜提取，可用已配置的生图模型生成参考图。</p>
            <p v-else-if="allChapters">分镜已齐。资产将按当前版本汇总。</p>
            <p v-else>逐章生成完成后，智能体自动汇总全书资产。</p>
          </div>
          <button v-if="allChapters && !project.assetsCurrent" class="btn btn-primary" type="button" :disabled="busy" @click="send({ action: 'assets' })">
            <Sparkles :size="16" /> 提取全书资产
          </button>
        </div>
        <div v-if="project.assets.length" class="novel-switch novel-chapter-tabs" aria-label="资产类型">
          <button type="button" :aria-pressed="assetFilter === 'all'" @click="assetFilter = 'all'">全部</button>
          <button v-for="kind in availableKinds" :key="kind" type="button" :aria-pressed="assetFilter === kind" @click="assetFilter = kind">{{ kinds[kind] }}</button>
        </div>
        <p v-if="!project.assetsCurrent && project.assets.length" class="novel-notice">下方是上一版资产。更新后可继续生图。</p>
        <div v-if="visibleAssets.length" class="novel-asset-grid">
          <article v-for="asset in visibleAssets" :key="asset.id" class="novel-asset">
            <a v-if="asset.image" :href="asset.image" target="_blank" rel="noopener noreferrer" :aria-label="'查看' + asset.name + '原图'">
              <img :src="asset.image" :alt="asset.name" loading="lazy">
            </a>
            <div v-else class="novel-asset-placeholder"><Images :size="26" aria-hidden="true" /></div>
            <div class="novel-asset-body">
              <div class="novel-project-top"><h3>{{ asset.name }}</h3><span class="novel-tag">{{ kinds[asset.kind] }}</span></div>
              <p>{{ asset.description }}</p>
              <details class="novel-asset-uses">
                <summary>出现章节 · {{ asset.appearances.length }}</summary>
                <button v-for="appearance in asset.appearances" :key="appearance.chapter" class="btn btn-sm" type="button" @click="showAppearance(appearance.chapter)">
                  第 {{ appearance.chapter }} 章 · {{ appearance.segments.map(numberLabel).join('、') }}
                </button>
              </details>
              <label class="novel-field">生图提示词
                <textarea :value="assetPrompts[asset.id] ?? asset.prompt" rows="3" maxlength="2400"
                  :disabled="!project.assetsCurrent || asset.imageStatus === 'running'" @input="assetPrompts[asset.id] = ($event.target as HTMLTextAreaElement).value" />
              </label>
              <p v-if="asset.imageError" class="novel-error" role="status">{{ asset.imageError }}</p>
              <button class="btn" type="button" :disabled="busy || !project.assetsCurrent || asset.imageStatus === 'running' || !(assetPrompts[asset.id] ?? asset.prompt).trim()"
                @click="send({ action: 'image', assetId: asset.id, prompt: assetPrompts[asset.id] ?? asset.prompt })">
                <LoaderCircle v-if="asset.imageStatus === 'running'" class="novel-spin" :size="15" /><Sparkles v-else :size="15" />
                {{ asset.imageStatus === 'running' ? '生图中' : asset.imageStatus === 'ready' ? '重新生图' : asset.imageStatus === 'failed' ? '重试生图' : '生成参考图' }}
              </button>
            </div>
          </article>
        </div>
        <div v-else class="novel-empty"><Images :size="25" /> {{ project.assetsCurrent ? '当前分镜没有需要单独生图的资产。' : '等待资产提取。' }}</div>
      </section>
    </template>

    <dialog ref="deleteDialog" class="novel-delete-dialog" aria-labelledby="novel-delete-title" aria-describedby="novel-delete-message"
      @cancel="cancelDelete" @close="pendingDelete = undefined">
      <h2 id="novel-delete-title">删除项目</h2>
      <p id="novel-delete-message">「{{ pendingDelete?.title }}」的小说正文、章节分镜和资产清单将永久删除。</p>
      <p v-if="deleteError" class="novel-error" role="alert">{{ deleteError }}</p>
      <div class="novel-actions">
        <button type="button" class="btn" autofocus :disabled="deleting" @click="deleteDialog?.close()">取消</button>
        <button type="button" class="btn btn-danger" :disabled="deleting" @click="deleteProject">
          {{ deleting ? '正在删除…' : '确认删除' }}
        </button>
      </div>
    </dialog>
  </div>
</template>

<script setup lang="ts">
import { ArrowLeft, ArrowRight, BookOpen, Check, CircleAlert, Clapperboard, Download, Images, LoaderCircle, Plus, RotateCcw, Sparkles, Trash2, Upload } from 'lucide-vue-next'
import type { NovelAssetKind, NovelChapter, NovelCommand, NovelPace, NovelProject, NovelProjectSummary } from '../../../backend/src/services/novel-storyboard-types'
import type { ProjectModelKind, ProjectModelOption, ProjectModelSelection } from '../../../backend/src/services/project-model-options'
import { novelStoryboardAPI } from '~/composables/useApi'

const route = useRoute()
const router = useRouter()
const { open: openSettings, revision: settingsRevision } = useSettingsPanel()
const modelLabel = useModelLabel()
const projectId = computed(() => typeof route.query.project === 'string' ? route.query.project : '')
const directoryQuery = computed(() => {
  const { project: _selected, ...query } = route.query
  return query
})
const projects = ref<NovelProjectSummary[]>([])
const project = ref<NovelProject>()
const availableModels = ref<ProjectModelOption[]>([])
const modelsLoading = ref(false)
const modelsError = ref(false)
const chapter = ref<NovelChapter>()
const selectedNumber = ref(1)
const view = ref<'chapters' | 'assets'>('chapters')
const chapterView = ref<'shots' | 'source'>('shots')
const loading = ref(true)
const sending = ref(false)
const chapterLoading = ref(false)
const directoryLoaded = ref(false)
const showImport = ref(false)
const deleteDialog = ref<HTMLDialogElement>()
const pendingDelete = ref<NovelProjectSummary>()
const deleting = ref(false)
const deleteError = ref('')
const file = shallowRef<File>()
const importPace = ref<NovelPace>('fast')
const adaptationNotes = ref('')
const revising = ref(false)
const notes = ref('')
const error = ref('')
const chapterError = ref('')
const pollError = ref(false)
const conflict = ref(false)
const assetPrompts = reactive<Record<string, string>>({})
const assetFilter = ref<NovelAssetKind | 'all'>('all')
const kinds = { character: '人物', scene: '场景', prop: '道具', creature: '生物', other: '其他' }
const modelFields = [
  { kind: 'text', label: 'LLM 文字模型' },
  { kind: 'image', label: '图片模型' },
] as const
const modelKey = (choice: ProjectModelSelection) => choice.configId + '/' + choice.model
const modelMenus = computed(() => modelFields.map(({ kind, label }) => {
  const choices = availableModels.value.filter(option => option.kind === kind)
  const options = choices.map(option => ({
    value: modelKey(option), label: modelLabel(option.model) + ' · ' + option.configName, disabled: false,
  }))
  const selection = project.value?.models?.[kind]
  const value = selection ? modelKey(selection) : ''
  if (selection && !options.some(option => option.value === value)) {
    const status = modelsLoading.value || modelsError.value ? '' : '（已不可用）'
    options.unshift({ value, label: modelLabel(selection.model) + status, disabled: true })
  }
  return { kind, label, value, options: [{ value: '', label: '跟随全局默认', disabled: false }, ...options] }
}))
const missingModelKinds = computed(() => modelFields.filter(({ kind }) =>
  !availableModels.value.some(option => option.kind === kind)).map(({ label }) => label).join('、'))

const busy = computed(() => sending.value || project.value?.job?.status === 'running')
const finished = computed(() => project.value?.chapters.filter(item => item.version > 0).length ?? 0)
const allChapters = computed(() => !!project.value && finished.value === project.value.chapters.length)
const selected = computed(() => project.value?.chapters[selectedNumber.value - 1])
const storyboard = computed(() => chapter.value?.storyboard)
const canGenerateChapter = computed(() => !!selected.value && (selected.value.version > 0 ||
  selected.value.number === project.value?.chapters.find(item => !item.version)?.number))
const availableKinds = computed(() => (Object.keys(kinds) as NovelAssetKind[]).filter(kind => project.value?.assets.some(asset => asset.kind === kind)))
const visibleAssets = computed(() => project.value?.assets.filter(asset => assetFilter.value === 'all' || asset.kind === assetFilter.value) ?? [])
const paceLabel = (pace: NovelPace) => pace === 'fast' ? '快节奏' : '正常节奏'
const numberLabel = (number: number) => String(number).padStart(2, '0')

let live = true
let projectRequest = 0
let chapterRequest = 0
let modelRequest = 0
let pollTimer: ReturnType<typeof setTimeout> | undefined

async function loadModels() {
  const request = ++modelRequest
  modelsLoading.value = true
  modelsError.value = false
  try {
    const models = await novelStoryboardAPI.models()
    if (live && request === modelRequest) availableModels.value = models
  } catch {
    if (live && request === modelRequest) modelsError.value = true
  } finally {
    if (live && request === modelRequest) modelsLoading.value = false
  }
}

async function selectModel(kind: ProjectModelKind, value: string | number) {
  const current = project.value?.models?.[kind]
  if (busy.value || value === (current ? modelKey(current) : '')) return
  const option = availableModels.value.find(item => item.kind === kind && modelKey(item) === value)
  if (value !== '' && !option) return
  await send({ action: 'selectModel', kind, selection: option ? { configId: option.configId, model: option.model } : null })
}

function install(projectData: NovelProject) {
  project.value = projectData
  if (!availableKinds.value.includes(assetFilter.value as NovelAssetKind)) assetFilter.value = 'all'
  schedulePoll()
}

function schedulePoll() {
  clearTimeout(pollTimer)
  if (!live || !project.value || sending.value || loading.value) return
  if (!pollError.value && project.value.job?.status !== 'running' && !project.value.assets.some(asset => asset.imageStatus === 'running')) return
  pollTimer = setTimeout(reloadProject, 1800)
}

async function reloadProject() {
  const id = project.value?.id
  if (!id || sending.value || loading.value) return
  const request = ++projectRequest
  try {
    const next = await novelStoryboardAPI.get(id)
    if (!live || request !== projectRequest) return
    if (conflict.value) error.value = ''
    pollError.value = false
    conflict.value = false
    install(next)
  } catch (err) {
    if (!live || request !== projectRequest) return
    if ((err as { status?: number }).status === 404) {
      project.value = undefined
      pollError.value = false
      error.value = (err as Error).message
      return
    }
    pollError.value = true
    schedulePoll()
  }
}

function resetSelection(data: NovelProject) {
  selectedNumber.value = data.job?.status === 'running' && data.job.chapter
    ? data.job.chapter : data.chapters.find(item => item.version)?.number ?? 1
  chapter.value = undefined
  chapterView.value = 'shots'
  view.value = 'chapters'
  revising.value = false
  notes.value = ''
  assetFilter.value = 'all'
  for (const key of Object.keys(assetPrompts)) delete assetPrompts[key]
}

async function openProject(id: string) {
  const request = ++projectRequest
  ++chapterRequest
  clearTimeout(pollTimer)
  loading.value = true
  project.value = undefined
  chapter.value = undefined
  error.value = ''
  pollError.value = false
  conflict.value = false
  showImport.value = false
  deleteDialog.value?.close()
  try {
    if (!id) {
      directoryLoaded.value = false
      const list = await novelStoryboardAPI.list()
      if (!live || request !== projectRequest) return
      projects.value = list
      directoryLoaded.value = true
      return
    }
    const data = await novelStoryboardAPI.get(id)
    if (!live || request !== projectRequest) return
    resetSelection(data)
    install(data)
  } catch (err) {
    if (live && request === projectRequest) error.value = (err as Error).message
  } finally {
    if (live && request === projectRequest) {
      loading.value = false
      schedulePoll()
    }
  }
}

function requestDelete(item: NovelProjectSummary) {
  pendingDelete.value = item
  deleteError.value = ''
  deleteDialog.value?.showModal()
}

function cancelDelete(event: Event) {
  if (deleting.value) event.preventDefault()
}

async function deleteProject() {
  const item = pendingDelete.value
  if (!item || deleting.value) return
  deleting.value = true
  deleteError.value = ''
  try {
    await novelStoryboardAPI.delete(item.id)
    if (live) {
      projects.value = projects.value.filter(project => project.id !== item.id)
      deleteDialog.value?.close()
    }
  } catch (err) {
    if (live) deleteError.value = (err as Error).message
  } finally {
    deleting.value = false
  }
}

function chooseFile(event: Event) {
  const input = event.target as HTMLInputElement
  const picked = input.files?.[0]
  file.value = undefined
  error.value = ''
  if (!picked) return
  if (!/\.(txt|md)$/iu.test(picked.name) || picked.size > 8 * 1024 * 1024) {
    error.value = '请选择 8 MB 以内的 TXT 或 Markdown 小说。'
    input.value = ''
    return
  }
  file.value = picked
}

async function importNovel() {
  if (!file.value || sending.value) return
  const request = projectRequest
  sending.value = true
  error.value = ''
  try {
    const { id } = await novelStoryboardAPI.import(file.value, importPace.value, adaptationNotes.value)
    if (!live || request !== projectRequest) return
    file.value = undefined
    importPace.value = 'fast'
    adaptationNotes.value = ''
    await router.push({ query: { ...directoryQuery.value, project: id } })
  } catch (err) {
    if (live && request === projectRequest) error.value = (err as Error).message
  } finally {
    sending.value = false
    schedulePoll()
  }
}

async function loadChapter() {
  const id = project.value?.id
  const number = selected.value?.number
  if (!id || !number) return
  const request = ++chapterRequest
  chapterLoading.value = true
  chapterError.value = ''
  try {
    const data = await novelStoryboardAPI.chapter(id, number)
    if (live && request === chapterRequest) chapter.value = data
  } catch (err) {
    if (live && request === chapterRequest) chapterError.value = (err as Error).message
  } finally {
    if (live && request === chapterRequest) chapterLoading.value = false
  }
}

function selectChapter(number: number) {
  if (number === selectedNumber.value) return
  chapter.value = undefined
  selectedNumber.value = number
  chapterView.value = 'shots'
  revising.value = false
  notes.value = ''
}

function showAppearance(number: number) {
  selectChapter(number)
  chapterView.value = 'shots'
  view.value = 'chapters'
}

async function send(command: NovelCommand) {
  if (!project.value || sending.value) return false
  const request = ++projectRequest
  clearTimeout(pollTimer)
  sending.value = true
  conflict.value = false
  error.value = ''
  try {
    const result = await novelStoryboardAPI.command(project.value.id, project.value.revision, command)
    if (!live || request !== projectRequest) return false
    install(result)
    return true
  } catch (err) {
    if (!live || request !== projectRequest) return false
    error.value = (err as Error).message
    conflict.value = (err as { status?: number }).status === 409
    return false
  } finally {
    sending.value = false
    schedulePoll()
  }
}

async function changePace(event: Event) {
  const select = event.target as HTMLSelectElement
  if (!await send({ action: 'pace', pace: select.value as NovelPace }) && project.value) select.value = project.value.pace
}

async function generateChapter() {
  if (!selected.value || !canGenerateChapter.value) return
  if (await send({ action: 'chapter', chapter: selected.value.number, notes: notes.value })) {
    notes.value = ''
    revising.value = false
    chapterView.value = 'shots'
  }
}

function markdownCell(value: string) {
  return value.replace(/\|/gu, '｜').replace(/\r?\n/gu, '<br>')
}

function downloadChapter() {
  if (!selected.value || !storyboard.value) return
  const { title, number } = selected.value
  const board = storyboard.value
  const lines = [
    '# ' + title, '', '## 制作规格', '', board.summary, '',
    board.segments.length + ' 段，每段 30 秒，总时长 ' + board.segments.length * 30 + ' 秒。' + paceLabel(board.pace) + '。',
    '', board.visualStyle, '', '## 人物与声音锁定', '',
    '| 角色 | 外观与身份锚点 | 声音、语速与情绪 |', '|---|---|---|',
    ...board.voices.map(voice => '| ' + [voice.name, voice.appearance, voice.voice].map(markdownCell).join(' | ') + ' |'),
  ]
  if (board.screens) lines.push('', '## 界面提示词', '', board.screens)
  for (const [index, segment] of board.segments.entries()) {
    lines.push('', '## 视频编号' + numberLabel(index + 1), '', '←承上：' + segment.incoming, '',
      '场景：' + segment.scene, '', '人物：' + (segment.cast.join('、') || '无'), '',
      '总时长：30秒', '', '独立生成：' + segment.direction, '',
      '| 镜号 | 时长 | 景别／机位／运动 | 画面与动作 | 对白／音效 |', '|---|---:|---|---|---|',
      ...segment.shots.map((shot, shotIndex) =>
        '| ' + [numberLabel(shotIndex + 1), shot.seconds + '秒', shot.camera, shot.action, shot.sound].map(markdownCell).join(' | ') + ' |'),
      '', '→衔接：' + segment.outgoing)
  }
  lines.push('', '## 台词与逻辑复核', '', board.review, '')
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = numberLabel(number) + '-' + title.replace(/[<>:"/\\|?*\u0000-\u001F]/gu, '_') + '-分镜-v' + board.version + '.md'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

watch([() => project.value?.id, selectedNumber, () => selected.value?.version], loadChapter)
watch(projectId, openProject)
watch([projectId, settingsRevision], ([id]) => { if (id) void loadModels() }, { immediate: true })
onMounted(() => openProject(projectId.value))
onBeforeUnmount(() => {
  live = false
  clearTimeout(pollTimer)
})
</script>

<style scoped>
.novel-workbench { width: min(100%, 1510px); flex: 1; min-height: 0; overflow-y: auto; margin: 0 auto; padding: 26px clamp(16px, 3vw, 42px) 48px; color: var(--text-1); }
.novel-workbench h1, .novel-workbench h2, .novel-workbench h3, .novel-workbench p { margin: 0; }
.novel-workbench h1 { font-size: clamp(24px, 3vw, 32px); line-height: 1.2; color: var(--text-0); }
.novel-workbench h2 { font-size: 18px; line-height: 1.35; color: var(--text-0); }
.novel-workbench h3 { font-size: 15px; color: var(--text-0); }
.novel-workbench p { line-height: 1.65; color: var(--text-2); overflow-wrap: anywhere; }
.novel-header, .novel-identity, .novel-actions, .novel-project-top { display: flex; align-items: center; gap: 12px; }
.novel-header, .novel-project-top { justify-content: space-between; flex-wrap: wrap; }
.novel-header { margin-bottom: 20px; }
.novel-identity p, .novel-project-top p { margin-top: 4px; }
.novel-project-heading { min-width: 0; overflow-wrap: anywhere; }
.novel-actions { flex-wrap: wrap; }
.novel-mark { width: 46px; height: 46px; border: 1px solid var(--surface-outline-strong); border-radius: 12px; display: grid; place-items: center; color: var(--accent); background: var(--surface-raised); flex: none; }
.novel-paper { display: grid; align-content: start; min-width: 0; gap: 15px; padding: clamp(16px, 2vw, 24px); border: 1px solid var(--surface-outline); border-radius: 15px; background: var(--surface-raised); }
.novel-project-list { display: grid; gap: 8px; padding: 0; margin: 0; list-style: none; }
.novel-project-list li { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; min-width: 0; padding: 12px 14px; border: 1px solid var(--surface-outline); border-radius: 9px; background: var(--surface-input); }
.novel-project-list .novel-project-heading { flex: 1 1 240px; }
.novel-delete-trigger { color: var(--action-danger); }
.novel-delete-dialog { width: min(420px, calc(100vw - 32px)); margin: auto; padding: 23px; border: 1px solid var(--surface-outline-strong); border-radius: 13px; background: var(--surface-raised); color: var(--text-1); }
.novel-delete-dialog::backdrop { background: rgb(0 0 0 / 57%); }
.novel-delete-dialog p { margin: 10px 0 16px; }
.novel-delete-dialog .novel-actions { justify-content: flex-end; }
.novel-import { max-width: 650px; }
.novel-upload { min-height: 120px; display: grid; justify-items: center; align-content: center; gap: 9px; padding: 16px; border: 1px dashed var(--surface-outline-strong); border-radius: 11px; background: var(--surface-input); color: var(--accent); position: relative; cursor: pointer; overflow-wrap: anywhere; text-align: center; }
.novel-upload input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; }
.novel-upload:focus-within, .novel-workbench :is(button, select, textarea, summary, a):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.novel-pace { border: 0; padding: 0; margin: 0; display: flex; gap: 20px; flex-wrap: wrap; }
.novel-pace legend { padding: 0 0 7px; font-weight: 600; }
.novel-pace label { display: flex; gap: 7px; align-items: center; }
.novel-pace input { margin: 0; accent-color: var(--accent); }
.novel-inline-field { display: flex; align-items: center; gap: 8px; color: var(--text-2); font-size: 13px; }
.novel-models, .novel-model { display: flex; align-items: center; gap: 10px; min-width: 0; }
.novel-models { flex-wrap: wrap; gap: 10px 20px; }
.novel-model { flex: 0 1 310px; }
.novel-model > span, .novel-models > small { color: var(--text-2); font-size: 13px; }
.novel-model > span { white-space: nowrap; }
.novel-model :deep(.base-select) { flex: 1; min-width: 0; }
.novel-workbench :is(select, textarea) { font: inherit; color: var(--text-1); background: var(--surface-input); border: 1px solid var(--surface-outline-strong); border-radius: 8px; padding: 8px 10px; }
.novel-workbench textarea { width: 100%; min-width: 0; resize: vertical; line-height: 1.55; }
.novel-workbench progress { width: 100%; height: 6px; appearance: none; border: 0; border-radius: 99px; background: var(--surface-input); color: var(--accent); }
.novel-workbench progress::-webkit-progress-bar { background: var(--surface-input); border-radius: 99px; }
.novel-workbench progress::-webkit-progress-value { background: var(--accent); border-radius: 99px; }
.novel-workbench progress::-moz-progress-bar { background: var(--accent); border-radius: 99px; }
.novel-notice { margin-block: 10px; display: flex; align-items: center; flex-wrap: wrap; gap: 9px; padding: 10px 13px; border-radius: 9px; border: 1px solid var(--surface-outline); background: var(--surface-input); color: var(--text-1); }
.novel-notice svg { flex: none; }
.novel-workbench .novel-error { color: var(--danger, #ae3a40); }
.novel-empty { display: flex; align-items: center; justify-content: center; min-height: 130px; gap: 12px; color: var(--text-2); text-align: center; }
.novel-switch { display: flex; flex-wrap: wrap; gap: 6px; margin-block: 13px; }
.novel-switch button { display: inline-flex; align-items: center; gap: 7px; padding: 8px 12px; border: 1px solid transparent; border-radius: 8px; background: transparent; font: inherit; font-weight: 600; color: var(--text-2); cursor: pointer; }
.novel-switch button[aria-pressed="true"] { border-color: var(--surface-outline-strong); background: var(--surface-input); color: var(--text-0); }
.novel-chapter-tabs { margin: 0; }
.novel-chapter-layout { display: grid; grid-template-columns: minmax(200px, 251px) minmax(0, 1fr); align-items: start; gap: 13px; }
.novel-catalog { padding: 16px 12px 12px; }
.novel-catalog h2 { padding-inline: 8px; }
.novel-chapter-list { display: grid; gap: 4px; max-height: max(220px, 52vh); overflow-y: auto; }
.novel-chapter-list button { text-align: left; min-width: 0; display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 8px; padding: 9px 8px; border-radius: 8px; border: 1px solid transparent; background: transparent; font: inherit; color: var(--text-1); cursor: pointer; }
.novel-chapter-list button:is(:hover, [aria-current="true"]) { border-color: var(--surface-outline); background: var(--surface-input); }
.novel-chapter-number { color: var(--text-2); font-size: 11px; font-variant-numeric: tabular-nums; }
.novel-chapter-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.novel-chapter-list svg { color: var(--accent); }
.novel-prose { white-space: pre-wrap; }
.novel-revise { display: grid; gap: 10px; }
.novel-field { display: grid; gap: 6px; font-size: 13px; font-weight: 550; }
.novel-field textarea { font-weight: 400; }
.novel-details { min-width: 0; border: 1px solid var(--surface-outline); border-radius: 9px; background: var(--surface-input); }
.novel-details > summary { padding: 11px 13px; cursor: pointer; font-weight: 600; overflow-wrap: anywhere; }
.novel-details > summary span { margin-inline: 8px 0; font-weight: 400; }
.novel-details > p { padding: 4px 13px 12px; }
.novel-tag { display: inline-block; font-size: 12px; color: var(--accent); white-space: nowrap; }
.novel-segment-meta { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 12px; padding: 0 13px; margin: 7px 0 13px; font-size: 13px; line-height: 1.6; }
.novel-segment-meta dt { font-weight: 600; }
.novel-segment-meta dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-2); }
.novel-table-wrap { overflow-x: auto; padding: 0 13px 11px; }
.novel-table { width: 100%; min-width: 595px; border-collapse: collapse; font-size: 13px; line-height: 1.55; }
.novel-table :is(th, td) { text-align: left; vertical-align: top; padding: 8px; border-bottom: 1px solid var(--surface-outline); white-space: pre-wrap; overflow-wrap: anywhere; }
.novel-table :is(th, td):nth-child(-n+2) { white-space: nowrap; }
.novel-table th:nth-child(3) { width: 24%; }
.novel-table th:nth-child(4) { width: 40%; }
.novel-table th { color: var(--text-0); }
.novel-outgoing strong { margin-right: 7px; color: var(--text-1); }
.novel-asset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); gap: 12px; }
.novel-asset { min-width: 0; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--surface-outline); border-radius: 10px; background: var(--surface-input); }
.novel-asset :is(img, .novel-asset-placeholder) { display: grid; place-items: center; width: 100%; aspect-ratio: 16 / 9; object-fit: contain; color: var(--text-2); background: var(--surface-raised); }
.novel-asset-body { padding: 12px; display: grid; align-content: start; gap: 9px; flex: 1; }
.novel-asset-body button { justify-self: start; }
.novel-asset-uses { font-size: 13px; color: var(--text-2); }
.novel-asset-uses summary { cursor: pointer; }
.novel-asset-uses button { margin: 5px 5px 0 0; }
.novel-spin { animation: novel-spin 1s linear infinite; }
@keyframes novel-spin { to { transform: rotate(360deg); } }
@media (max-width: 720px) {
  .novel-chapter-layout { grid-template-columns: minmax(0, 1fr); }
  .novel-chapter-list { max-height: 172px; }
}
@media (prefers-reduced-motion: reduce) { .novel-spin { animation: none; } }
</style>
