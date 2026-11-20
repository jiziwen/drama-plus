<template>
  <section class="sv-editor">
    <header class="sv-head">
      <div>
        <div class="sv-eyebrow">
          <template v-if="segmentNumber">视频编号 {{ String(segmentNumber).padStart(2, '0') }}<span v-if="segmentCount"> / 共 {{ segmentCount }} 段</span></template>
          <template v-else>分镜片段</template>
        </div>
        <h2>{{ card.title }}</h2>
        <div class="sv-meta">
          <span v-if="segmentStart !== undefined">{{ timecode(segmentStart) }}–{{ timecode(segmentStart + card.duration) }}</span><span v-if="segmentStart !== undefined">·</span>
          <span>{{ totalDuration }} 秒</span><span>·</span
          ><span>{{ card.shots.length }} 个镜头</span
          ><span v-if="overLimit" class="sv-error">超过 30 秒上限</span>
        </div>
      </div>
      <span class="sv-badge">{{
        outputMode === 'external' ? '外部交付' : '视频制作'
      }}</span>
    </header>

    <nav class="sv-tabs" aria-label="片段编辑">
      <button
        v-for="item in tabs"
        :key="item.id"
        type="button"
        :class="{ active: tab === item.id }"
        :aria-pressed="tab === item.id"
        @click="tab = item.id"
      >
        {{ item.label }}
      </button>
    </nav>

    <div class="sv-body" :class="{ 'sv-body-preview': tab === 'preview' && previewVideoUrl }">
      <template v-if="tab === 'prompt'">
        <div class="sv-section-head">
          <div>
            <h3>视频提示词</h3>
            <p>编辑本段画面与动作，输入 @ 引用素材。</p>
          </div>
          <div class="sv-prompt-actions">
            <span class="sv-caption">{{ card.prompt.length }} 字</span
            ><button
              class="sv-button sv-quiet"
              type="button"
              @click="tab = 'revise'"
            >
              <Sparkles :size="13" />让 AI 调整
            </button>
          </div>
        </div>
        <MentionTextarea
          ref="promptInput"
          :model-value="promptVoiceView.text"
          :options="mentionOptions"
          searchable
          :preview-on-hover="true"
          :resolve-preview-ranges="previewRanges"
          :rows="12"
          input-class="sv-prompt-input"
          placeholder="描述画面、动作和声音，输入 @ 引用素材…"
          @focus="beginPromptEdit"
          @update:model-value="editPrompt"
          @commit="finishPromptEdit"
        />
        <div class="sv-reference-head">
          <div>
            <h3>本片段参考素材</h3>
            <p>配图和配音随分镜内容更新。可从项目资产或提示词的 @ 菜单添加素材。</p>
          </div>
          <span class="sv-caption">{{ materialUse.imageIds.length }} 配图 · {{ materialUse.speakerIds.length }} 发声角色</span>
        </div>
        <!-- <input
          v-if="selectedAssets.length"
          v-model="assetQuery"
          type="search"
          class="input sv-asset-search"
          placeholder="搜索已选素材"
          aria-label="搜索本片段已选素材"
        /> -->
        <div v-if="filteredAssets.length" class="sv-assets">
          <div
            v-for="asset in filteredAssets"
            :key="asset.id"
            class="sv-asset selected"
          >
            <button
              type="button"
              class="sv-reference-view"
              :aria-label="`查看参考图 ${asset.name}`"
              :aria-haspopup="asset.image ? 'dialog' : undefined"
              :disabled="!asset.image"
              @click="openMediaPreview('image', asset.name, asset.image)"
            >
              <span class="sv-thumb"><ScriptVideoPreviewAssetImage :asset="asset" /></span>
              <span class="sv-asset-copy">
                <strong>{{ asset.name }}</strong>
                <small>{{ kindLabel(asset.kind) }} · {{ materialStatus(asset) }}</small>
              </span>
            </button>
            <button
              v-if="card.assetIds.includes(asset.id)"
              type="button"
              class="sv-reference-remove"
              :aria-label="`移除参考素材 ${asset.name}`"
              :title="`移除参考素材 ${asset.name}`"
              @click="removeReference(asset.id)"
            >
              <X :size="14" aria-hidden="true" />
            </button>
          </div>
        </div>
        <p v-else class="sv-empty">{{ selectedAssets.length ? '已选素材中没有匹配项' : '本片段尚无可用参考素材' }}</p>
      </template>

      <ScriptVideoPreviewRevision
        v-else-if="tab === 'revise'"
        :card="card"
        :assets="assets"
        :asset-context="assetContext"
        :request-revision="requestRevision"
        :revision-state="revisionState"
        :revision-blocked="revisionBlocked"
        :restored-revision="restoredRevision"
        @apply="applyRevision"
        @close="tab = 'prompt'"
        @cancel="emit('cancel-revision')"
        @consume-restored-revision="emit('consume-restored-revision')"
      />

      <template v-else-if="tab === 'shots'">
        <details v-if="production" class="sv-specs">
          <summary>本集制作规格、人物与声音锁定</summary>
          <dl class="sv-facts">
            <div v-for="item in productionFacts" :key="item.label"><dt>{{ item.label }}</dt><dd>{{ item.text }}</dd></div>
          </dl>
          <template v-if="production.characters?.length">
            <h4>人物与声音锁定</h4>
            <div class="sv-table-wrap">
              <table class="sv-voices">
                <thead><tr><th scope="col">角色</th><th scope="col">外观与身份锚点</th><th scope="col">声音、语速与情绪</th></tr></thead>
                <tbody><tr v-for="(character, index) in production.characters" :key="index">
                  <th scope="row">{{ character.name }}</th><td>{{ character.appearance }}</td><td>{{ character.voice }}</td>
                </tr></tbody>
              </table>
            </div>
          </template>
          <template v-if="production.interfacePrompt">
            <h4>界面提示词</h4><p>{{ production.interfacePrompt }}</p>
          </template>
        </details>
        <p v-if="!card.manuallyAdded && (!production || missingMetadata.length)" class="sv-legacy-note" role="status">
          {{ !production ? '本集缺少完整制作规格。' : '' }}{{ missingMetadata.length ? '本段缺少' + missingMetadata.join('、') + '。' : '' }}请在大纲页按完整 Skill 重新生成正式分镜。
        </p>
        <div v-if="card.openingRecap" class="sv-continuity-line"><strong>前镜回顾</strong><p>{{ card.openingRecap }}</p></div>
        <div v-if="card.opening" class="sv-continuity-line"><strong>{{ card.openingRecap ? '本段开场' : '←承上' }}</strong><p>{{ card.opening }}</p></div>
        <dl class="sv-facts sv-card-facts">
          <div v-if="card.scene"><dt>场景</dt><dd>{{ card.scene }}</dd></div>
          <div v-if="card.characters"><dt>人物</dt><dd>{{ card.characters }}</dd></div>
          <div><dt>总时长</dt><dd>{{ card.duration }} 秒</dd></div>
          <div v-if="card.independentGeneration"><dt>独立生成</dt><dd>{{ card.independentGeneration }}</dd></div>
        </dl>
        <div class="sv-section-head sv-shot-tools">
          <h3>正式分镜</h3>
          <div>
            <button type="button" class="sv-button sv-quiet" :aria-pressed="editingShots" @click="editingShots = !editingShots">
              {{ editingShots ? '结束编辑' : '编辑镜头' }}
            </button>
            <button type="button" class="sv-button sv-quiet" @click="addShot">＋ 添加镜头</button>
          </div>
        </div>
        <div v-if="card.shots.length" class="sv-table-wrap">
          <table class="sv-shot-table" aria-label="正式分镜五列表格">
            <colgroup><col class="sv-col-number" /><col class="sv-col-time" /><col class="sv-col-camera" /><col class="sv-col-action" /><col /></colgroup>
            <thead><tr>
              <th scope="col">镜号</th><th scope="col">时长</th><th scope="col">景别／机位／运动</th><th scope="col">画面与动作</th><th scope="col">对白／音效</th>
            </tr></thead>
            <tbody><tr v-for="(shot, index) in card.shots" :key="shot.id">
              <th scope="row"><span class="sv-shot-number">{{ String(index + 1).padStart(2, '0') }}</span>
                <button v-if="editingShots" class="sv-remove" type="button" :aria-label="`删除镜头 ${index + 1}`" @click="removeShot(index)">删除</button>
              </th>
              <td>
                <label v-if="editingShots" class="sv-duration"><input type="number" min="0.1" max="30" step="0.1" :value="shot.duration"
                  :aria-label="`镜头 ${index + 1} 时长（秒）`" @change="updateShot(index, 'duration', ($event.target as HTMLInputElement).value)" /> 秒</label>
                <span v-else>{{ shot.duration }} 秒</span>
              </td>
              <td v-for="column in shotColumns" :key="column.key">
                <textarea v-if="editingShots" :value="shot[column.key]" rows="5" :aria-label="`镜头 ${index + 1} ${column.label}`"
                  @input="updateShot(index, column.key, ($event.target as HTMLTextAreaElement).value)" />
                <template v-else>{{ shot[column.key] || '—' }}</template>
              </td>
            </tr></tbody>
          </table>
        </div>
        <p v-else class="sv-empty">还没有镜头，添加一个镜头开始编辑。</p>
        <p :class="['sv-duration-note', { error: overLimit || totalDuration !== card.duration }]">
          镜头合计 {{ totalDuration }} 秒<span v-if="totalDuration !== card.duration">，与片段总时长 {{ card.duration }} 秒不一致</span><span v-if="overLimit">，请调整到 30 秒以内</span>
        </p>
        <div v-if="card.ending" class="sv-continuity-line sv-ending"><strong>→衔接</strong><p>{{ card.ending }}</p></div>
      </template>

      <template v-else-if="tab === 'continuity'">
        <div v-if="card.openingRecap" class="sv-continuity-line"><strong>前镜回顾</strong><p>{{ card.openingRecap }}</p></div>
        <div class="sv-continuity-line"><strong>{{ card.openingRecap ? '本段开场' : '←承上' }}</strong><p>{{ card.opening || '未记录承上内容，请按完整 Skill 重新生成正式分镜。' }}</p></div>
        <div class="sv-continuity-line sv-ending"><strong>→衔接</strong><p>{{ card.ending || '未记录衔接内容，请按完整 Skill 重新生成正式分镜。' }}</p></div>
      </template>

      <div v-else-if="tab === 'preview' && previewVideoUrl" class="sv-player">
        <div class="sv-player-head">
          <div>
            <strong>{{ currentVideoReady ? '成片预览' : '上一版成片' }}</strong>
            <p v-if="!currentVideoReady">这是保留的历史成片，仍可播放和下载。</p>
          </div>
        </div>
        <video
          ref="inlineVideo"
          :src="previewVideoUrl"
          controls
          preload="metadata"
        />
        <a :href="previewVideoUrl" download class="sv-button sv-quiet"
          >下载视频</a
        >
      </div>
    </div>

    <footer v-if="tab !== 'revise'" class="sv-footer">
      <div v-if="actionWarnings.length || advisoryWarnings.length" :id="actionWarningId" class="sv-action-warning" role="status">
        <div><p v-for="warning in [...actionWarnings, ...advisoryWarnings]" :key="warning">{{ warning }}</p></div>
        <button v-if="card.promptNeedsSync" class="sv-button sv-quiet" type="button" @click="tab = 'revise'">
          <Sparkles :size="13" /> AI 调整
        </button>
      </div>
      <div class="sv-footer-actions">
        <button
          type="button"
          class="sv-button sv-quiet"
          :disabled="card.promptNeedsSync"
          @click="$emit('export')"
        >
          导出
        </button>
        <div class="sv-footer-secondary">
          <button
            type="button"
            class="sv-button sv-quiet"
            :disabled="!previewVideoUrl"
            aria-haspopup="dialog"
            @click="openMediaPreview('video', card.title, previewVideoUrl)"
          >
            查看视频
          </button>
          <button
            type="button"
            class="sv-button sv-quiet"
            :disabled="!card.prompt.trim()"
            @click="$emit('preview-final-prompt', $event)"
          >
            <Eye :size="14" aria-hidden="true" />最终提示词
          </button>
          <button
            v-if="outputMode === 'internal' && canCancelVideo"
            type="button"
            class="sv-button sv-quiet"
            :disabled="cancelingVideo"
            @click="$emit('cancel-video')"
          >{{ cancelingVideo ? '正在取消…' : '取消生成' }}</button>
          <button
            v-else
            type="button"
            class="sv-button sv-primary"
            :disabled="isGenerating || !!actionWarnings.length"
            :aria-describedby="actionWarnings.length ? actionWarningId : undefined"
            @click="outputMode === 'external' ? $emit('export') : $emit('generate')"
          >
            {{
              outputMode === 'external'
                ? '导出交付包'
                : isGenerating
                  ? '正在生成视频…'
                  : '生成视频'
            }}
            <span>↗</span>
          </button>
        </div>
      </div>
    </footer>

    <dialog
      ref="mediaDialog"
      class="sv-reference-dialog"
      :aria-labelledby="mediaTitleId"
      @click.self="mediaDialog?.close()"
      @close="clearMediaPreview"
    >
      <div v-if="previewedMedia" class="sv-reference-dialog-content">
        <header>
          <h3 :id="mediaTitleId">{{ previewedMedia.name }}</h3>
          <button
            type="button"
            class="sv-button sv-quiet"
            :aria-label="previewedMedia.kind === 'video' ? '关闭视频' : '关闭参考图'"
            autofocus
            @click="mediaDialog?.close()"
          >
            <X :size="16" aria-hidden="true" />
          </button>
        </header>
        <p v-if="mediaPreviewFailed" class="sv-empty" role="status">
          {{ previewedMedia.kind === 'video' ? '视频加载失败' : '参考图加载失败' }}
        </p>
        <video
          v-else-if="previewedMedia.kind === 'video'"
          ref="modalVideo"
          :src="previewedMedia.url"
          controls
          playsinline
          preload="metadata"
          @error="mediaPreviewFailed = true"
        />
        <img
          v-else
          :src="previewedMedia.url"
          :alt="previewedMedia.name"
          @error="mediaPreviewFailed = true"
        />
      </div>
    </dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, useId, watch } from 'vue'
import { Eye, Sparkles, X } from 'lucide-vue-next'
import MentionTextarea from './MentionTextarea.vue'
import { getPreviewMaterialUse, inspectPreviewCardAssets, validatePreviewCards } from '~/utils/scriptVideoPreviewValidation'
import { editScriptVideoPromptVoiceView, scriptVideoPromptVoiceView } from '~/utils/scriptVideoPromptVoiceView'
import { getScriptVideoPromptVoices } from '../../../backend/src/services/script-video-delivery'
import type { ScriptVideoRevisionCandidate } from '~/utils/scriptVideoClient'
import {
  rebindCardAssets,
  replacePreviewPrompt,
  type PreviewProduction,
  type PreviewCard,
  scriptVideoCardPlayback,
  type PreviewAsset,
} from '~/utils/scriptVideoPreview'

const props = withDefaults(
  defineProps<{
    card: PreviewCard
    assets: PreviewAsset[]
    outputMode: 'internal' | 'external'
    production?: PreviewProduction
    stylePreset?: PreviewProduction['stylePreset']
    videoProvider?: string
    videoModel?: string
    segmentNumber?: number
    segmentCount?: number
    segmentStart?: number
    running?: boolean
    canCancelVideo?: boolean
    cancelingVideo?: boolean
    videoVoiceWarning?: string
    completedTaskVideoUrl?: string
    tab?: Tab
    revisionState?: 'running' | 'canceling'
    revisionBlocked?: boolean
    restoredRevision?: ScriptVideoRevisionCandidate
    requestRevision: (
      card: PreviewCard,
      instruction: string,
    ) => Promise<ScriptVideoRevisionCandidate>
  }>(),
  { running: false },
)
const emit = defineEmits<{
  update: [card: PreviewCard]
  'update:tab': [tab: Tab]
  generate: []
  'cancel-video': []
  'cancel-revision': []
  'consume-restored-revision': []
  export: []
  'preview-final-prompt': [event: MouseEvent]
}>()
function timecode(seconds: number) {
  const rest = Number((seconds % 60).toFixed(2))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}
type Tab = 'prompt' | 'revise' | 'shots' | 'continuity' | 'preview'
const videoPlayback = computed(() => scriptVideoCardPlayback(props.card, props.completedTaskVideoUrl))
const currentVideoReady = computed(() => videoPlayback.value?.kind === 'current')
const previewVideoUrl = computed(() => videoPlayback.value?.url)
const tabs = computed<{ id: Tab; label: string }[]>(() => [
  { id: 'shots', label: '正式分镜' },
  { id: 'prompt', label: '视频提示词' },
  { id: 'revise', label: 'AI 调整' },
  { id: 'continuity', label: '连续性' },
  ...(previewVideoUrl.value
    ? [{ id: 'preview' as const, label: currentVideoReady.value ? '成片预览' : '上一版成片' }]
    : []),
])
const localTab = ref<Tab>('shots')
const tab = computed<Tab>({
  get: () => {
    const selected = props.tab ?? localTab.value
    return tabs.value.some(item => item.id === selected) ? selected : 'shots'
  },
  set: value => {
    if (props.tab === undefined) localTab.value = value
    emit('update:tab', value)
  },
})
const editingShots = ref(false)
const shotColumns = [
  { key: 'camera', label: '景别／机位／运动' },
  { key: 'action', label: '画面与动作' },
  { key: 'dialogue', label: '对白／音效' },
] as const
const productionFacts = computed(() => {
  const spec = props.production
  if (!spec) return []
  return [
    {label: '核心节奏', text: spec.coreRhythm}, {label: '画面规格', text: spec.visualSpecs},
    {label: '镜头节奏', text: spec.shotRhythm}, {label: '台词规则', text: spec.dialogueRules},
    {label: '界面规则', text: spec.interfaceRules}, {label: '服装规则', text: spec.costumeRules},
    {label: '场景与摄像', text: spec.sceneAndCamera}, {label: '音效与剪辑', text: spec.soundAndEditing},
    {label: '连续性核对', text: spec.continuityReview},
  ].filter(item => item.text?.trim())
})
const missingMetadata = computed(() => [
  ['承上', props.card.opening], ['场景', props.card.scene], ['人物', props.card.characters],
  ['独立生成', props.card.independentGeneration], ['衔接', props.card.ending],
].filter(([, text]) => !text?.trim()).map(([label]) => label))
const totalDuration = computed(() =>
  Number(
    props.card.shots
      .reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0)
      .toFixed(2),
  ),
)
const overLimit = computed(() => totalDuration.value > 30)
const isGenerating = computed(
  () =>
    props.running ||
    props.card.status === 'queued' ||
    props.card.status === 'generating',
)
const kindLabel = (kind: string) =>
  ({ character: '角色', scene: '背景', prop: '道具', creature: '生物' })[
    kind
  ] || '资产'
const assetContext = computed(() => ({
  stylePreset: props.production?.stylePreset || props.stylePreset,
  cast: props.production?.characters,
}))
const selectedAssets = computed(() => {
  const byId = new Map(props.assets.map(asset => [asset.id, asset]))
  const { imageIds, speakerIds } = materialUse.value
  const ids = new Set([...props.card.assetIds, ...imageIds, ...speakerIds])
  return [...ids].map(id => byId.get(id)).filter((asset): asset is PreviewAsset => !!asset)
})
function materialStatus(asset: PreviewAsset) {
  const { imageIds, speakerIds, contextIds, missingVoices } = materialUse.value
  const labels = []
  if (imageIds.includes(asset.id)) labels.push('配图')
  if (speakerIds.includes(asset.id))
    labels.push(missingVoices.includes(asset.name) ? '缺少参考音频' : asset.voiceAudio?.url ? '参考音频' : '模型配音')
  if (!labels.length) labels.push(contextIds.includes(asset.id) ? '仅文本提及' : '候选素材')
  return labels.join(' · ')
}
const assetQuery = ref('')
const filteredAssets = computed(() =>
  selectedAssets.value.filter((asset) =>
    asset.name.toLowerCase().includes(assetQuery.value.trim().toLowerCase()),
  ),
)
const inlineVideo = ref<HTMLVideoElement>()
const modalVideo = ref<HTMLVideoElement>()
const mediaDialog = ref<HTMLDialogElement>()
const mediaTitleId = useId()
type MediaPreview = { kind: 'image' | 'video'; name: string; url: string }
const previewedMedia = shallowRef<MediaPreview | null>(null)
const mediaPreviewFailed = ref(false)
async function openMediaPreview(kind: MediaPreview['kind'], name: string, url?: string) {
  if (!url) return
  inlineVideo.value?.pause()
  previewedMedia.value = { kind, name, url }
  mediaPreviewFailed.value = false
  await nextTick()
  mediaDialog.value?.showModal()
}
function clearMediaPreview() {
  modalVideo.value?.pause()
  previewedMedia.value = null
}
const mentionOptions = computed(() => {
  const selectedIds = new Set(selectedAssets.value.map(asset => asset.id))
  const visuals = [...selectedAssets.value, ...props.assets.filter(asset => !selectedIds.has(asset.id))].map((asset) => ({
    id: asset.id,
    label: asset.name,
    value: asset.name,
    kind: asset.kind,
    group: kindLabel(asset.kind),
    image: asset.image.startsWith('/script-video-preview/')
      ? undefined
      : asset.image || undefined,
  }))
  return [...visuals, ...promptVoices.value.map(({ asset, roles }, i) => ({
    id: `voice-${i + 1}`, label: `音频${i + 1}`, value: `音频${i + 1}`,
    kind: 'audio', group: roles.map(role => role.name).join('、'), previewOnly: true, audioUrl: asset.voiceAudio?.url,
  }))]
})
const analyzePrompt = (prompt: string) =>
  inspectPreviewCardAssets({ ...props.card, prompt }, props.assets, assetContext.value)
const textareaText = (text: string) => text.replace(/\r\n?/gu, '\n')
function projectPrompt(card: PreviewCard) {
  // The textarea normalizes legacy CRLF text. Analyze the same text that its
  // selection offsets refer to, including the generated voice cues.
  const source = textareaText(card.prompt)
  const context = assetContext.value
  const editable = { ...card, prompt: source }
  const analyzed = inspectPreviewCardAssets(editable, props.assets, context)
  const voices = getScriptVideoPromptVoices(editable, props.assets, {
    ...context, provider: props.videoProvider, model: props.videoModel,
  })
  const indices = new Map(voices.flatMap(({ roles }, i) => roles.map(role => [role.id, i + 1] as const)))
  return { view: scriptVideoPromptVoiceView(source, analyzed.mentions, indices), analyzed, voices }
}
const savedPrompt = computed(() => projectPrompt(props.card))
const promptDraft = shallowRef<{ cardId: string; projection: ReturnType<typeof projectPrompt> }>()
const promptProjection = computed(() => promptDraft.value?.cardId === props.card.id
  ? promptDraft.value.projection : savedPrompt.value)
const analyzedPrompt = computed(() => promptProjection.value.analyzed)
const materialUse = computed(() => analyzedPrompt.value.materialUse)
const promptVoices = computed(() => promptProjection.value.voices)
const promptVoiceView = computed(() => promptProjection.value.view)
const promptInput = ref<InstanceType<typeof MentionTextarea>>()
function previewRanges(text: string) {
  const view = promptVoiceView.value
  if (text !== view.text) return analyzePrompt(text).mentions
  return [
    ...analyzedPrompt.value.mentions.map(hit => ({
      ...hit, start: view.displayOffset(hit.start), end: view.displayOffset(hit.end, true),
    })),
    ...view.cues.map(cue => ({ id: `voice-${cue.index}`, start: cue.tokenStart, end: cue.tokenEnd })),
  ].sort((a, b) => a.start - b.start)
}
let lastEdit: { display: string; source: string } | undefined
let editSequence = 0
function beginPromptEdit() {
  if (promptDraft.value?.cardId === props.card.id) return
  promptDraft.value = { cardId: props.card.id, projection: savedPrompt.value }
}
function clearPromptEdit() {
  editSequence++
  promptDraft.value = undefined
  lastEdit = undefined
}
watch([() => props.card.id, tab], clearPromptEdit)

async function editPrompt(display: string, input: HTMLTextAreaElement) {
  const sequence = ++editSequence
  const cardId = props.card.id
  const view = promptVoiceView.value
  const edit = editScriptVideoPromptVoiceView(view, display, input.selectionStart, input.selectionEnd)
  const direction = input.selectionDirection
  lastEdit = { display, source: edit.text }
  // Save authored edits as usual. A save acknowledgement may normalize the
  // stored prompt, but should not replace the active textarea under its caret.
  const projection = edit.text === view.source ? promptProjection.value : projectPrompt(updatePrompt(edit.text))
  promptDraft.value = { cardId, projection }
  await nextTick()
  const updated = promptVoiceView.value
  if (sequence !== editSequence || cardId !== props.card.id || input.value !== display && input.value !== updated.text) return
  if (display !== updated.text) {
    promptInput.value?.syncDisplay(updated.text, updated.displayOffset(edit.selectionStart, edit.beforeCue),
      updated.displayOffset(edit.selectionEnd, edit.beforeCue), direction)
  }
}
const actionWarningId = useId()
const actionWarnings = computed(() => {
  if (props.card.manuallyAdded && props.outputMode === 'internal')
    return props.card.prompt.trim() ? [] : ['请输入视频提示词。']
  const warnings: string[] = []
  if (!props.card.shots.length) warnings.push('请先添加镜头。')
  else if (overLimit.value) warnings.push(`镜头合计 ${totalDuration.value} 秒，超过单段 30 秒上限。`)
  else if (totalDuration.value <= 0) warnings.push('镜头总时长必须大于 0 秒。')
  if (props.card.promptNeedsSync)
    warnings.push('镜头已修改，视频提示词待同步。可让 AI 按当前分镜更新，也可到「视频提示词」手动修改。')
  if (props.outputMode === 'internal' && props.videoVoiceWarning)
    warnings.push(props.videoVoiceWarning)
  return warnings
})
const advisoryWarnings = computed(() => analyzedPrompt.value.warnings.map(issue => issue.message))
function updatePrompt(prompt: string): PreviewCard {
  const assetIds = new Set(analyzePrompt(prompt).mentions
    .filter(hit => hit.explicit && hit.usage !== 'context')
    .map(hit => hit.id))
  const next = {
    ...replacePreviewPrompt(props.card, prompt),
    assetIds: [...new Set([...props.card.assetIds, ...assetIds])],
  }
  if (next.excludedAssetIds) {
    next.excludedAssetIds = next.excludedAssetIds.filter(id => !assetIds.has(id))
    if (!next.excludedAssetIds.length) delete next.excludedAssetIds
  }
  const checked = checkedPromptUpdate(next)
  emit('update', checked)
  return checked
}
function finishPromptEdit(text: string, blurred = false) {
  const view = promptVoiceView.value
  const source = text === view.text ? view.source : lastEdit?.display === text ? lastEdit.source
    : editScriptVideoPromptVoiceView(view, text, text.length, text.length).text
  if (blurred) clearPromptEdit()
  const result = analyzePrompt(source)
  const ids = [...new Set([...props.card.assetIds, ...result.assetIds])]
  // Changes already accepted by autosave can now appear in the editor. Do not
  // overwrite those changes with the focused copy if commit had nothing to add.
  const currentText = textareaText(props.card.prompt)
  const prompt = (blurred && result.text === view.source) || result.text === currentText ? props.card.prompt : result.text
  if (prompt === props.card.prompt && ids.length === props.card.assetIds.length) return
  emit('update', checkedPromptUpdate({ ...replacePreviewPrompt(props.card, prompt), assetIds: ids }))
}
function checkedPromptUpdate(next: PreviewCard): PreviewCard {
  if (props.card.manuallyAdded) return { ...next, promptNeedsSync: false }
  if (!props.card.promptNeedsSync) return next
  if (!next.prompt.trim() || next.prompt.trim() === props.card.prompt.trim()) return { ...next, promptNeedsSync: true }
  const updated = { ...next, promptNeedsSync: false }
  return validatePreviewCards([updated], props.assets, assetContext.value).ok ? updated : { ...next, promptNeedsSync: true }
}
function applyRevision(card: PreviewCard) {
  emit('update', checkedPromptUpdate(card))
  tab.value = 'prompt'
}
function removeReference(id: PreviewAsset['id']) {
  const assetIds = props.card.assetIds.filter(item => item !== id)
  if (!assetIds.length) assetQuery.value = ''
  emit('update', rebindCardAssets(props.card, assetIds, props.assets, props.production))
}
function updateShots(shots: PreviewCard['shots']) {
  const duration = Number(
    shots
      .reduce((sum, shot) => sum + (Number(shot.duration) || 0), 0)
      .toFixed(2),
  )
  const next = {
    ...props.card,
    shots,
    duration: props.card.manuallyAdded && !shots.length ? props.card.duration : duration,
    promptNeedsSync: !props.card.manuallyAdded,
  }
  const { imageIds, speakerIds } = getPreviewMaterialUse(next, props.assets, assetContext.value)
  const excluded = new Set(next.excludedAssetIds)
  const used = [...imageIds, ...speakerIds].filter(id => !excluded.has(id))
  emit('update', { ...next, assetIds: [...new Set([...next.assetIds, ...used])] })
}
function updateShot(
  index: number,
  field: 'duration' | 'camera' | 'action' | 'dialogue',
  value: string,
) {
  const shots = props.card.shots.map((shot, i) => {
    if (i !== index) return shot
    if (field === 'duration') {
      const seconds = Number(value)
      return { ...shot, duration: Number.isFinite(seconds) ? Math.max(0.1, Math.min(30, seconds)) : 0.1 }
    }
    if (shot[field] === value) return shot
    const next = { ...shot, [field]: value }
    if (field === 'dialogue') delete next.speakerAssetIds
    else delete next.visualAssetIds
    return next
  })
  updateShots(shots)
}
function addShot() {
  editingShots.value = true
  updateShots([
    ...props.card.shots,
    {
      id: `shot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      duration: 1,
      camera: '',
      action: '',
      dialogue: '',
    },
  ])
}
function removeShot(index: number) {
  updateShots(props.card.shots.filter((_, i) => i !== index))
}
</script>

<style scoped>
.sv-prompt-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.sv-prompt-actions button {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--accent-text);
}
.sv-editor {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  color: var(--text-0);
  background: var(--surface-raised, var(--surface-1));
}
.sv-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 25px 28px 0px;
}
.sv-eyebrow {
  color: var(--text-3);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.13em;
}
.sv-eyebrow span {
  margin: 0 3px;
}
h2,
h3,
p {
  margin: 0;
}
h2 {
  margin-top: 7px;
  font-size: 21px;
  letter-spacing: 0.01em;
}
h3 {
  font-size: 14px;
}
p {
  line-height: 1.6;
}
.sv-meta {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-2);
}
.sv-error,
.sv-duration-note.error {
  color: var(--danger, #d66b60);
}
.sv-badge {
  align-self: flex-start;
  padding: 5px 9px;
  border: 1px solid var(--border);
  border-radius: 99px;
  color: var(--text-2);
  font-size: 11px;
  white-space: nowrap;
}
.sv-tabs {
  display: flex;
  overflow-x: auto;
  gap: 22px;
  padding: 0 28px;
  border-bottom: 1px solid var(--border);
}
.sv-tabs button {
  flex: none;
  padding: 13px 1px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--text-2);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.sv-tabs button.active {
  color: var(--accent-text, var(--accent));
  border-color: var(--accent);
  font-weight: 650;
}
.sv-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 24px 28px 28px;
}
.sv-body-preview {
  display: flex;
  overflow: hidden;
}
.sv-section-head,
.sv-reference-head {
  display: flex;
  justify-content: space-between;
  align-items: start;
  gap: 12px;
  margin-bottom: 13px;
}
.sv-section-head p,
.sv-reference-head p,
.sv-player-head p {
  margin-top: 5px;
  color: var(--text-3);
  font-size: 12px;
}
.sv-caption {
  color: var(--text-3);
  font-size: 11px;
  white-space: nowrap;
}
.sv-body :deep(.sv-prompt-input) {
  box-sizing: border-box;
  width: 100%;
  min-height: 230px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-1, var(--bg-2));
  color: var(--text-0);
  font: inherit;
  font-size: 13px;
  line-height: 1.8;
  /* The native textarea otherwise uses its own letter spacing. Match the highlighted mirror. */
  letter-spacing: inherit;
}
.sv-body :deep(.mention-input.sv-prompt-input) {
  background: transparent;
  color: transparent;
}
.sv-body :deep(.mention-backdrop.sv-prompt-input) {
  border-color: transparent;
  background: transparent;
}
.sv-action-warning {
  display: flex;
  justify-content: space-between;
  align-items: start;
  gap: 8px;
  margin-bottom: 10px;
  max-height: 9rem;
  overflow-y: auto;
  padding: 9px 11px;
  border: 1px solid var(--border-strong, var(--border));
  border-radius: 7px;
  color: var(--warning, #b77429);
  background: var(--surface-1, var(--bg-2));
  font-size: 12px;
}
.sv-action-warning p + p {
  margin-top: 4px;
}
.sv-action-warning > div {
  min-width: 0;
  overflow-wrap: anywhere;
}
.sv-action-warning button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.sv-reference-head {
  margin-top: 24px;
}
.sv-assets {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.sv-asset {
  display: flex;
  align-items: center;
  gap: 3px;
  width: 160px;
  min-width: 0;
  padding: 7px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface-1, var(--bg-2));
  color: var(--text-1);
}
.sv-asset.selected {
  border-color: var(--accent);
  background: var(--accent-bg);
}
.sv-reference-view,
.sv-reference-remove {
  display: flex;
  align-items: center;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.sv-reference-view {
  flex: 1;
  gap: 8px;
  min-width: 0;
}
.sv-reference-view:disabled {
  cursor: default;
}
.sv-reference-view:not(:disabled):hover strong {
  text-decoration: underline;
}
.sv-reference-remove {
  flex: none;
  width: 23px;
  height: 25px;
  justify-content: center;
  border-radius: 5px;
  color: var(--accent-text, var(--accent));
}
.sv-reference-remove:hover {
  color: var(--action-danger, var(--error));
  background: var(--action-danger-bg, var(--error-bg));
}
.sv-thumb {
  display: grid;
  place-items: center;
  overflow: hidden;
  width: 35px;
  height: 35px;
  flex: none;
  border-radius: 6px;
  background: var(--bg-2);
  color: var(--text-2);
  font-size: 15px;
}
.sv-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.sv-asset-copy {
  flex: 1;
  min-width: 0;
}
.sv-asset-copy strong,
.sv-asset-copy small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sv-asset-copy strong {
  font-size: 12px;
}
.sv-asset-copy small {
  color: var(--text-3);
  font-size: 10px;
  margin-top: 3px;
}
.sv-reference-dialog {
  width: min(900px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px);
  margin: auto;
  padding: 0;
  border: 1px solid var(--border-strong, var(--border));
  border-radius: var(--radius-lg, 14px);
  background: var(--surface-raised, var(--bg-1));
  color: var(--text-0);
  box-shadow: var(--shadow-lg);
}
.sv-reference-dialog::backdrop {
  background: var(--scrim, #000a);
}
.sv-reference-dialog-content {
  display: grid;
  gap: 12px;
  padding: 16px;
}
.sv-reference-dialog-content header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.sv-reference-dialog-content header h3 {
  min-width: 0;
  overflow-wrap: anywhere;
}
.sv-reference-dialog-content :is(img, video) {
  display: block;
  width: 100%;
  max-height: min(75dvh, calc(100dvh - 128px));
  object-fit: contain;
  border-radius: 8px;
  background: var(--bg-0);
}
.sv-specs {
  margin-bottom: 16px;
  padding: 11px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.sv-specs summary {
  color: var(--text-1);
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
}
.sv-specs[open] summary { margin-bottom: 12px; }
.sv-specs h4 { margin: 13px 0 6px; font-size: 12px; }
.sv-specs p, .sv-facts dd, .sv-continuity-line p {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 13px;
  line-height: 1.65;
}
.sv-legacy-note {
  margin: 0 0 16px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 7px;
  color: var(--warning, #b77429);
  font-size: 12px;
}
.sv-shot-tools, .sv-shot-tools > div { display: flex; align-items: center; gap: 8px; }
.sv-shot-tools button { flex: none; }
.sv-facts { margin: 0; }
.sv-facts > div {
  display: grid;
  grid-template-columns: 6em minmax(0, 1fr);
  gap: 8px;
  padding: 4px 0;
}
.sv-facts dt, .sv-continuity-line strong {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
  line-height: 1.75;
}
.sv-facts dd { margin: 0; }
.sv-card-facts { margin: 12px 0 20px; }
.sv-continuity-line { border-left: 2px solid var(--accent); padding: 1px 12px; }
.sv-continuity-line p { margin: 3px 0 0; }
.sv-ending { margin-top: 16px; }
.sv-table-wrap { min-width: 0; overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; }
.sv-shot-table, .sv-voices { width: 100%; border-spacing: 0; table-layout: fixed; text-align: left; }
.sv-shot-table { min-width: 580px; }
.sv-voices { min-width: 360px; }
.sv-shot-table th, .sv-shot-table td, .sv-voices th, .sv-voices td {
  padding: 9px 7px;
  font-size: 12px;
  line-height: 1.65;
  font-weight: 400;
  vertical-align: top;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  border-bottom: 1px solid var(--border);
  border-right: 1px solid var(--border);
}
.sv-table-wrap thead th { background: var(--surface-1, var(--bg-2)); color: var(--text-2); font-weight: 600; }
.sv-table-wrap tr > :last-child { border-right: 0; }
.sv-table-wrap tbody tr:last-child > * { border-bottom: 0; }
.sv-col-number { width: 44px; }
.sv-col-time { width: 66px; }
.sv-col-camera { width: 22%; }
.sv-col-action { width: 37%; }
.sv-voices th:first-child { width: 17%; }
.sv-shot-number { color: var(--accent-text, var(--accent)); font-variant-numeric: tabular-nums; font-weight: 600; }
.sv-shot-table textarea, .sv-duration input {
  box-sizing: border-box;
  width: 100%;
  padding: 5px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-raised, var(--bg-2));
  color: var(--text-0);
  font: inherit;
  line-height: 1.5;
}
.sv-shot-table textarea { resize: vertical; min-height: 58px; }
.sv-duration { color: var(--text-2); }
.sv-duration input { width: 100%; }
.sv-remove {
  display: block;
  margin-top: 5px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--text-3);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.sv-remove:hover { color: var(--danger); }
.sv-duration-note {
  margin-top: 12px;
  color: var(--text-3);
  font-size: 12px;
}
.sv-empty {
  padding: 18px 0;
  color: var(--text-3);
  font-size: 12px;
}
.sv-player {
  display: grid;
  flex: 1;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: 12px;
  min-width: 0;
  min-height: 0;
  padding: 15px;
  border: 1px solid var(--border);
  border-radius: 12px;
}
.sv-player video {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 0;
  object-fit: contain;
  border-radius: 8px;
  background: var(--bg-2);
}
.sv-player > a {
  justify-self: start;
}
.sv-player-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}
.sv-player-head strong {
  font-size: 13px;
}
.sv-frame {
  position: relative;
  display: flex;
  min-height: 260px;
  overflow: hidden;
  flex-direction: column;
  justify-content: center;
  padding: 20px 24px;
  border-radius: 8px;
  background: linear-gradient(135deg, #20383d, #111c27);
  color: #ecf5f3;
}
.sv-frame-image,
.sv-frame-overlay {
  position: absolute;
  inset: 0;
}
.sv-frame-image {
  opacity: 0.82;
}
.sv-frame-image :deep(.preview-uploaded) {
  object-fit: cover;
}
.sv-frame-overlay {
  background:
    linear-gradient(90deg, rgba(6, 16, 25, 0.86), rgba(6, 16, 25, 0.52)),
    linear-gradient(0deg, rgba(6, 16, 25, 0.62), transparent);
}
.sv-frame > :not(.sv-frame-image):not(.sv-frame-overlay):not(.sv-frame-index) {
  position: relative;
  z-index: 1;
}
.sv-frame .sv-frame-index {
  position: absolute;
}
.sv-frame-index {
  position: absolute;
  top: 13px;
  right: 14px;
  opacity: 0.65;
  font:
    11px ui-monospace,
    monospace;
}
.sv-frame-label {
  color: #a9d7cc;
  font-size: 11px;
}
.sv-frame p {
  max-width: 580px;
  margin-top: 8px;
  font-size: 14px;
}
.sv-frame small {
  margin-top: 8px;
  color: #c1d4d1;
}
.sv-dots {
  display: flex;
  justify-content: center;
  gap: 6px;
  margin-top: 11px;
}
.sv-dots button {
  width: 6px;
  height: 6px;
  padding: 0;
  border: 0;
  border-radius: 99px;
  background: var(--border);
  cursor: pointer;
}
.sv-dots button.active {
  width: 16px;
  background: var(--accent);
}
.sv-footer {
  padding: 14px 28px;
  border-top: 1px solid var(--border);
}
.sv-footer-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}
.sv-footer-secondary {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.sv-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding: 7px 12px;
  border: 1px solid var(--border);
  border-radius: 7px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.sv-quiet {
  background: transparent;
  color: var(--text-1);
}
.sv-button:hover:not(:disabled) {
  border-color: var(--accent);
}
.sv-primary {
  display: flex;
  gap: 16px;
  align-items: center;
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 650;
}
.sv-button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.sv-editor button:focus-visible,
.sv-editor input:focus-visible,
.sv-editor textarea:focus-visible,
.sv-editor :deep(textarea:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
@media (max-width: 650px) {
  .sv-head,
  .sv-body {
    padding-left: 16px;
    padding-right: 16px;
  }
  .sv-tabs {
    padding: 0 16px;
    gap: 15px;
  }
  .sv-footer {
    padding: 12px 16px;
  }
  .sv-footer-actions, .sv-action-warning {
    flex-wrap: wrap;
  }
  .sv-asset {
    width: calc(50% - 4px);
  }
}
</style>
