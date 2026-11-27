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
      <span class="sv-badge">视频制作</span>
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
      <section
        v-if="assetBindingRows.length && (tab === 'prompt' || tab === 'shots')"
        ref="assetBindingPanel"
        class="sv-asset-bindings"
        :aria-labelledby="assetBindingTitleId"
        tabindex="-1"
      >
        <h3 :id="assetBindingTitleId">确认本片段素材</h3>
        <ul>
          <li v-for="row in assetBindingRows" :key="row.requirement.key">
            <strong>{{ row.requirement.label }} <small>{{ kindLabel(row.requirement.kind) }}</small></strong>
            <span v-if="row.source" class="sv-asset-binding-source">{{ row.source }}</span>
            <p>{{ row.message }}</p>
            <div v-if="row.candidates.length" class="sv-asset-binding-options" :aria-label="`${row.requirement.label}的候选素材`" role="group">
              <button
                v-for="asset in row.candidates"
                :key="asset.id"
                class="sv-button sv-quiet"
                type="button"
                :disabled="isGenerating || !asset.image"
                @click="confirmAssetBinding(row.requirement.key, asset.id)"
              >{{ asset.name }}<small v-if="!asset.image">缺少图片</small></button>
            </div>
            <details v-if="row.otherOptions.length" class="sv-asset-binding-other" :open="!row.hasUsableCandidates">
              <summary>选择其他{{ kindLabel(row.requirement.kind) }}素材</summary>
              <BaseSelect
                :aria-label="`为 ${row.requirement.label} 选择其他素材`"
                :options="row.otherOptions"
                :disabled="isGenerating"
                placeholder="搜索已上传的素材"
                variant="inspector"
                @update:model-value="confirmAssetBinding(row.requirement.key, String($event))"
              />
            </details>
            <p v-else-if="!row.hasUsableCandidates" class="sv-asset-binding-source">请在项目资产补充同类图片。</p>
          </li>
        </ul>
      </section>
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
              :disabled="!!uploadingPromptMedia || !canUploadPromptMedia"
              @click="promptImageInput?.click()"
            >
              <Upload :size="13" />{{ uploadingPromptMedia === 'image' ? '上传中…' : '上传图片' }}
            </button>
            ><button
              class="sv-button sv-quiet"
              type="button"
              :disabled="!!uploadingPromptMedia || !canUploadPromptMedia"
              @click="promptAudioInput?.click()"
            >
              <Headphones :size="13" />{{ uploadingPromptMedia === 'audio' ? '上传中…' : '上传音频' }}
            </button
            ><button
              class="sv-button sv-quiet"
              type="button"
              @click="tab = 'revise'"
            >
              <Sparkles :size="13" />让 AI 调整
            </button>
            <button
              class="sv-button sv-quiet"
              type="button"
              aria-haspopup="dialog"
              @pointerdown.prevent
              @click="expandPromptEditor"
            >
              <Maximize2 :size="13" aria-hidden="true" />放大编辑
            </button>
          </div>
        </div>
        <input
          ref="promptImageInput"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          @change="pickPromptMedia($event, 'image')"
        />
        <input
          ref="promptAudioInput"
          type="file"
          accept=".mp3,.wav,audio/mpeg,audio/wav,audio/x-wav"
          hidden
          @change="pickPromptMedia($event, 'audio')"
        />
        <ScriptVideoPromptStyle
          v-if="promptProjection.style"
          :key="promptProjection.style.name"
          :preset="promptProjection.style"
        />
        <Teleport :to="promptDialogBody || 'body'" :disabled="!promptExpanded">
          <MentionTextarea
            ref="promptInput"
            :model-value="promptVoiceView.text"
            :options="mentionOptions"
            searchable
            manage-history
            :preview-on-hover="true"
            :resolve-preview-ranges="previewRanges"
            :rows="12"
            :popup-target="promptExpanded ? promptDialog : undefined"
            input-class="sv-prompt-input"
            placeholder="描述画面、动作和声音，输入 @ 引用素材…"
            @focus="beginPromptEdit"
            @compositionstart="compositionProjection = promptProjection"
            @compositionend="compositionProjection = undefined"
            @update:model-value="editPrompt"
            @history="movePromptHistory"
            @commit="finishPromptEdit"
          />
        </Teleport>
        <div class="sv-reference-head">
          <div>
            <h3>本片段参考素材</h3>
            <p>上传图片或音频，在提示词里输入 @ 引用素材。</p>
          </div>
          <span class="sv-caption">{{ materialUse.imageIds.length }} 配图 · {{ materialUse.speakerIds.length }} 发声角色<span v-if="materialUse.audioIds.length"> · {{ materialUse.audioIds.length }} 音频</span></span>
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
              :aria-label="asset.kind === 'audio' ? `试听音频 ${asset.name}` : `查看参考图 ${asset.name}`"
              :aria-haspopup="asset.image || asset.kind === 'audio' && asset.voiceAudio?.url ? 'dialog' : undefined"
              :disabled="asset.kind === 'audio' ? !asset.voiceAudio?.url : !asset.image"
              @click="openAssetPreview(asset)"
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
        <p v-else-if="selectedAssets.length || (!frameEditor?.loading.value && !frameEditor?.frames.value?.tail && !frameEditor?.frames.value?.lighting.length)" class="sv-empty">
          {{ selectedAssets.length ? '已选素材中没有匹配项' : '本片段尚无可用参考素材' }}
        </p>
        <ScriptVideoReferenceFrames
          v-if="frameEditor" :frames="frameEditor.frames.value" :loading="frameEditor.loading.value" :changing="frameEditor.changing.value"
          :error="frameEditor.error.value" :choose="frameEditor.choose" @retry="frameEditor.refresh"
          @preview="(name, url) => openMediaPreview('image', name, url)"
        />
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

      <div
        v-else-if="tab === 'preview' && previewVideoUrl"
        class="sv-player"
      >
        <video
          ref="inlineVideo"
          :src="previewVideoUrl"
          controls
          preload="metadata"
        />
      </div>
      <ScriptVideoVideoVersions
        v-else-if="tab === 'versions'"
        :versions="videoVersions"
        :filename="videoFilename"
        :official-url="officialVideoUrl"
        :promoting="promotingVideoVersion"
        :generation-pending="isGenerating"
        @preview="(url, version) => openMediaPreview('video', `${card.title} · 版本 ${version}`, url)"
        @promote="$emit('promote-video-version', $event)"
      />
    </div>

    <footer v-if="tab !== 'revise'" class="sv-footer">
      <div v-if="actionWarnings.length || advisoryWarnings.length" :id="actionWarningId" class="sv-action-warning" role="status">
        <div><p v-for="warning in [...actionWarnings, ...advisoryWarnings]" :key="warning">{{ warning }}</p></div>
        <div v-if="assetBindingRows.length || card.promptNeedsSync" class="sv-action-warning-actions">
          <button v-if="assetBindingRows.length" class="sv-button sv-quiet" type="button" @click="showAssetBindingIssues">确认素材</button>
          <button v-if="card.promptNeedsSync" class="sv-button sv-quiet" type="button" @click="tab = 'revise'">
            <Sparkles :size="13" /> AI 调整
          </button>
        </div>
      </div>
      <div class="sv-footer-actions">
        <div class="sv-footer-secondary">
          <button
            type="button"
            class="sv-button sv-quiet"
            :disabled="card.promptNeedsSync"
            @click="$emit('export')"
          >
            导出
          </button>
          <a v-if="tab === 'preview' && previewVideoUrl" :href="previewVideoUrl" :download="videoFilename" class="sv-button sv-quiet">
            下载视频
          </a>
        </div>
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
            :disabled="!hasPromptBody"
            @click="$emit('preview-final-prompt', $event)"
          >
            <Eye :size="14" aria-hidden="true" />最终提示词
          </button>
          <button
            v-if="canCancelVideo"
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
            @click="$emit('generate')"
          >
            {{ isGenerating ? '正在生成视频…' : '生成视频' }}
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
            :aria-label="`关闭${mediaLabel[previewedMedia.kind]}`"
            autofocus
            @click="mediaDialog?.close()"
          >
            <X :size="16" aria-hidden="true" />
          </button>
        </header>
        <p v-if="mediaPreviewFailed" class="sv-empty" role="status">
          {{ mediaLabel[previewedMedia.kind] }}加载失败
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
        <audio
          v-else-if="previewedMedia.kind === 'audio'"
          ref="modalAudio"
          :src="previewedMedia.url"
          controls
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
    <dialog
      ref="promptDialog"
      class="sv-reference-dialog sv-prompt-dialog"
      :aria-labelledby="promptTitleId"
      @close="collapsePromptEditor"
    >
      <header class="sv-prompt-dialog-header">
        <div>
          <h3 :id="promptTitleId">视频提示词</h3>
          <p>{{ card.title }}</p>
        </div>
        <button class="sv-button sv-quiet" type="button" @pointerdown.prevent @click="promptDialog?.close()">
          <Minimize2 :size="14" aria-hidden="true" />收起编辑
        </button>
      </header>
      <div ref="promptDialogBody" class="sv-prompt-dialog-body" />
    </dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, useId, watch } from 'vue'
import { Eye, Headphones, Maximize2, Minimize2, Sparkles, Upload, X } from 'lucide-vue-next'
import MentionTextarea from './MentionTextarea.vue'
import type { useScriptVideoReferenceFrames } from '~/composables/useScriptVideoReferenceFrames'
import { getPreviewMaterialUse, inspectPreviewCardAssets, validatePreviewCards } from '~/utils/scriptVideoPreviewValidation'
import { editScriptVideoPromptVoiceView, scriptVideoPromptVoiceView } from '~/utils/scriptVideoPromptVoiceView'
import { getScriptVideoPromptVoices, type ScriptVideoPromptMode } from '../../../backend/src/services/script-video-delivery'
import { resolveScriptVideoAssetBinding, scriptVideoAssetBindingIssues } from '../../../backend/src/services/script-video-asset-bindings'
import { scriptVideoAudioReferences } from '../../../backend/src/services/script-video-mentions'
import { splitScriptVideoPromptStyle } from '../../../backend/src/services/script-video-style'
import { officialScriptVideoUrl } from '../../../backend/src/services/script-video-versions'
import type { ScriptVideoRevisionCandidate } from '~/utils/scriptVideoClient'
import type { ScriptVideoEditorTab as Tab } from '~/utils/scriptVideoViewPosition'
import {
  scriptVideoClipFilename,
  rebindCardAssets,
  replacePreviewPrompt,
  type PreviewProduction,
  type PreviewCard,
  type ScriptVideoVersion,
  scriptVideoCardPlayback,
  type PreviewAsset,
} from '~/utils/scriptVideoPreview'

const props = withDefaults(
  defineProps<{
    card: PreviewCard
    frameEditor?: ReturnType<typeof useScriptVideoReferenceFrames>
    assets: PreviewAsset[]
    production?: PreviewProduction
    stylePreset?: PreviewProduction['stylePreset']
    videoProvider?: string
    videoModel?: string
    promptMode?: ScriptVideoPromptMode
    episodeNumber?: number
    segmentNumber?: number
    segmentCount?: number
    segmentStart?: number
    canUploadPromptMedia?: boolean
    uploadingPromptMedia?: 'image' | 'audio'
    running?: boolean
    canCancelVideo?: boolean
    cancelingVideo?: boolean
    recoveringVideoDelivery?: boolean
    videoVoiceWarning?: string
    completedTaskVideoUrl?: string
    videoVersions?: readonly ScriptVideoVersion[]
    promotingVideoVersion?: string
    tab?: Tab
    revisionState?: 'running' | 'canceling'
    revisionBlocked?: boolean
    restoredRevision?: ScriptVideoRevisionCandidate
    requestRevision: (
      card: PreviewCard,
      instruction: string,
    ) => Promise<ScriptVideoRevisionCandidate>
  }>(),
  { running: false, videoVersions: () => [] },
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
  'promote-video-version': [url: string]
  'upload-prompt-media': [file: File, kind: 'image' | 'audio']
}>()
function timecode(seconds: number) {
  const rest = Number((seconds % 60).toFixed(2))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}
const videoPlayback = computed(() => scriptVideoCardPlayback(props.card, props.completedTaskVideoUrl))
const currentVideoReady = computed(() => videoPlayback.value?.kind === 'current')
const previewVideoUrl = computed(() => videoPlayback.value?.url)
const officialVideoUrl = computed(() => officialScriptVideoUrl(props.card))
const videoFilename = computed(() => scriptVideoClipFilename(props.episodeNumber, props.segmentNumber))
const tabs = computed<{ id: Tab; label: string }[]>(() => [
  { id: 'prompt', label: '视频提示词' },
  { id: 'shots', label: '正式分镜' },
  { id: 'revise', label: 'AI 调整' },
  { id: 'continuity', label: '连续性' },
  ...(previewVideoUrl.value
    ? [{ id: 'preview' as const, label: currentVideoReady.value ? '成片预览' : '上一版成片' }]
    : []),
  ...(props.videoVersions?.length ? [{ id: 'versions' as const, label: '成片版本' }] : []),
])
const localTab = ref<Tab>('prompt')
const tab = computed<Tab>({
  get: () => {
    const selected = props.tab ?? localTab.value
    return tabs.value.some(item => item.id === selected) ? selected : 'prompt'
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
  ({ character: '角色', scene: '背景', prop: '道具', creature: '生物', audio: '音频' })[
    kind
  ] || '资产'
const assetBindingTitleId = useId()
const assetBindingPanel = ref<HTMLElement>()
const projectAssetsById = computed(() => new Map(props.assets.map(asset => [asset.id, asset])))
const assetBindingRows = computed(() => scriptVideoAssetBindingIssues(props.card, props.assets).map(issue => {
  const { requirement } = issue
  const { episodeNumber, sceneId, sceneTitle, candidateIds, kind } = requirement
  const source = [episodeNumber ? `第 ${episodeNumber} 集` : '', sceneTitle || (sceneId ? `场次 ${sceneId}` : '')].filter(Boolean).join(' · ')
  const candidates = candidateIds.map(id => projectAssetsById.value.get(id))
    .filter((asset): asset is PreviewAsset => asset?.kind === kind)
  const otherOptions = props.assets.filter(asset => asset.kind === kind && asset.image && !candidateIds.includes(asset.id))
    .map(asset => ({ label: asset.name, value: asset.id }))
  return { ...issue, source, candidates, otherOptions, hasUsableCandidates: candidates.some(asset => !!asset.image) }
}))
async function showAssetBindingIssues() {
  if (tab.value !== 'shots') tab.value = 'prompt'
  await nextTick()
  assetBindingPanel.value?.focus()
}
function confirmAssetBinding(requirementKey: string, assetId: string) {
  if (isGenerating.value || !projectAssetsById.value.get(assetId)?.image) return
  if (!assetBindingRows.value.some(row => row.requirement.key === requirementKey)) return
  const next = resolveScriptVideoAssetBinding(props.card, requirementKey, assetId, props.assets)
  if (next) emit('update', next)
}
const assetContext = computed(() => ({
  stylePreset: props.production?.stylePreset || props.stylePreset,
  cast: props.production?.characters,
}))
const selectedAssets = computed(() => {
  const { imageIds, speakerIds, audioIds } = materialUse.value
  const ids = new Set([...props.card.assetIds, ...imageIds, ...speakerIds, ...audioIds])
  return [...ids].map(id => projectAssetsById.value.get(id)).filter((asset): asset is PreviewAsset => !!asset)
})
function materialStatus(asset: PreviewAsset) {
  const { imageIds, speakerIds, audioIds, contextIds, missingVoices } = materialUse.value
  const labels = []
  if (imageIds.includes(asset.id)) labels.push('配图')
  if (audioIds.includes(asset.id)) labels.push('已引用')
  if (speakerIds.includes(asset.id)) {
    if (missingVoices.includes(asset.name)) labels.push('缺少参考音频')
    else if (asset.voiceAudio?.url) labels.push('参考音频')
    else labels.push(asset.voiceMode === 'model' ? '模型配音' : '发声角色')
  }
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
const modalAudio = ref<HTMLAudioElement>()
const mediaDialog = ref<HTMLDialogElement>()
const mediaTitleId = useId()
const mediaLabel = { image: '参考图', video: '视频', audio: '音频' }
type MediaPreview = { kind: keyof typeof mediaLabel; name: string; url: string }
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
function openAssetPreview(asset: PreviewAsset) {
  if (asset.kind === 'audio') return openMediaPreview('audio', asset.name, asset.voiceAudio?.url)
  return openMediaPreview('image', asset.name, asset.image)
}
function clearMediaPreview() {
  modalVideo.value?.pause()
  modalAudio.value?.pause()
  previewedMedia.value = null
}
const segmentReferenceGroup = '本片段参考素材'
const segmentAssetIds = computed(() => new Set(selectedAssets.value.map(asset => asset.id)))
const mentionOptions = computed(() => {
  const selectedIds = segmentAssetIds.value
  const images = [...selectedAssets.value, ...props.assets.filter(asset => !selectedIds.has(asset.id))]
    .filter(asset => asset.kind !== 'audio').map(asset => ({
      id: asset.id,
      label: asset.name,
      value: asset.name,
      kind: asset.kind,
      group: kindLabel(asset.kind),
      menuGroup: selectedIds.has(asset.id) && asset.image ? segmentReferenceGroup : undefined,
      image: asset.image.startsWith('/script-video-preview/') ? undefined : asset.image || undefined,
    }))
  const currentAudio = [], libraryAudio = []
  const audioNumbers = new Map(promptVoices.value.flatMap(({ roles }, i) => roles.map(role => [role.id, i + 1] as const)))
  for (const [name, asset] of scriptVideoAudioReferences(props.assets)) {
    const audioUrl = asset.voiceAudio?.url
    if (!audioUrl) continue
    const audioNumber = audioNumbers.get(asset.id)
    const selected = audioNumber !== undefined || selectedIds.has(asset.id)
    const roleVoice = asset.kind === 'character'
    const option = { id: roleVoice ? `audio-choice-${asset.id}` : asset.id, label: asset.name, value: name, kind: 'audio',
      group: roleVoice ? '角色音色' : '音频', audioUrl, audioNumber,
      image: roleVoice && !asset.image.startsWith('/script-video-preview/') ? asset.image || undefined : undefined,
      menuGroup: selected ? segmentReferenceGroup : '全项目音频' }
    if (selected) currentAudio.push(option)
    else libraryAudio.push(option)
  }
  currentAudio.sort((a, b) => (a.audioNumber ?? Number.MAX_SAFE_INTEGER) - (b.audioNumber ?? Number.MAX_SAFE_INTEGER))
  const numberedPreviews = promptVoices.value.map(({ asset, roles }, i) => ({
    id: `voice-${i + 1}`, label: `音频${i + 1}`, value: `音频${i + 1}`,
    kind: 'audio', group: roles.map(role => role.name).join('、'), previewOnly: true, audioUrl: asset.voiceAudio?.url,
  }))
  return [...currentAudio, ...images.filter(option => option.menuGroup), ...images.filter(option => !option.menuGroup), ...libraryAudio, ...numberedPreviews]
})
const analyzePrompt = (prompt: string) =>
  inspectPreviewCardAssets({ ...props.card, prompt }, props.assets, assetContext.value)
const textareaText = (text: string) => text.replace(/\r\n?/gu, '\n')
const editablePrompt = (text: string) => splitScriptVideoPromptStyle(text, assetContext.value.stylePreset)
function joinPrompt(prefix: string, body: string) {
  return prefix && body && !prefix.endsWith('\n') ? prefix + '\n\n' + body : prefix + body
}
const promptImageInput = ref<HTMLInputElement>()
const promptAudioInput = ref<HTMLInputElement>()
function pickPromptMedia(event: Event, kind: 'image' | 'audio') {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) emit('upload-prompt-media', file, kind)
}
function projectPrompt(card: PreviewCard) {
  const authored = textareaText(card.prompt)
  const context = assetContext.value
  const references = inspectPreviewCardAssets({ ...card, prompt: authored }, props.assets, context)
  const source = references.text
  const { body, prefix, style } = editablePrompt(source)
  const editable = { ...card, prompt: source }
  // Normalize real references before building the display and its hover bounds.
  // Spoken names remain literal, and need no display-only @ marker.
  const analyzed = source === authored ? references : inspectPreviewCardAssets(editable, props.assets, context)
  const voices = getScriptVideoPromptVoices(editable, props.assets, {
    ...context, provider: props.videoProvider, model: props.videoModel, promptMode: props.promptMode,
  })
  const indices = new Map(voices.flatMap(({ roles }, i) => roles.map(role => [role.id, i + 1] as const)))
  const mentions = offsetMentions(analyzed.mentions, prefix.length)
  const authoredPrefix = editablePrompt(authored).prefix.length
  function normalizedOffset(position: number) {
    const absolute = authoredPrefix + position
    let delta = 0
    for (const hit of references.mentions) {
      if (hit.literal || hit.usage === 'audio') continue
      if (absolute <= hit.start) break
      const length = hit.name.length + 1
      if (absolute < hit.end) {
        return hit.start + delta + Math.min(length, absolute - hit.start + (hit.explicit ? 0 : 1)) - prefix.length
      }
      delta += length - (hit.end - hit.start)
    }
    return absolute + delta - prefix.length
  }
  return {
    view: scriptVideoPromptVoiceView(body, mentions, indices), prefix, style, mentions, analyzed, voices,
    authoredMentions: references.mentions,
    normalizedText: source === authored ? card.prompt : source,
    normalizedOffset,
  }
}
function offsetMentions<T extends { start: number; end: number }>(mentions: readonly T[], offset: number) {
  return mentions.filter(hit => hit.start >= offset).map(hit => ({ ...hit, start: hit.start - offset, end: hit.end - offset }))
}
const savedPrompt = computed(() => projectPrompt(props.card))
const hasPromptBody = computed(() => Boolean(savedPrompt.value.view.source.trim()))
const promptDraft = shallowRef<PreviewCard>()
const activePrompt = computed(() => promptDraft.value?.id === props.card.id
  ? projectPrompt(promptDraft.value) : savedPrompt.value)
// The textarea still contains the previous display while an IME composes.
const compositionProjection = shallowRef<ReturnType<typeof projectPrompt>>()
const promptProjection = computed(() => compositionProjection.value ?? activePrompt.value)
const analyzedPrompt = computed(() => promptProjection.value.analyzed)
const materialUse = computed(() => analyzedPrompt.value.materialUse)
const promptVoices = computed(() => promptProjection.value.voices)
const promptVoiceView = computed(() => promptProjection.value.view)
const promptInput = ref<InstanceType<typeof MentionTextarea>>()
const promptDialog = ref<HTMLDialogElement>()
const promptDialogBody = ref<HTMLElement>()
const promptTitleId = useId()
const promptExpanded = ref(false)
let movingPromptEditor = false
async function expandPromptEditor() {
  const dialog = promptDialog.value
  if (!dialog || promptExpanded.value) return
  const position = promptInput.value?.editingPosition()
  movingPromptEditor = true
  try {
    promptExpanded.value = true
    await nextTick()
    if (!dialog.isConnected || tab.value !== 'prompt') {
      promptExpanded.value = false
      return
    }
    dialog.showModal()
    promptInput.value?.focusEditor(position)
  } finally {
    movingPromptEditor = false
  }
}
async function collapsePromptEditor() {
  const position = promptInput.value?.editingPosition()
  promptExpanded.value = false
  await nextTick()
  if (tab.value === 'prompt') promptInput.value?.focusEditor(position)
}
watch(promptVoiceView, (view, previous) => {
  if (view.source !== previous.source || view.text === previous.text) return
  // Reference numbers can change when two characters no longer share a recording.
  const remap = (offset: number) => view.displayOffset(previous.sourceOffset(offset),
    previous.cues.some(cue => cue.start === offset))
  promptInput.value?.remapDisplay(previous.text, view.text, remap)
})
function previewRanges(text: string) {
  const view = promptVoiceView.value
  const { prefix, mentions } = promptProjection.value
  if (text !== view.text) {
    const full = joinPrompt(prefix, text)
    return offsetMentions(analyzePrompt(full).mentions, full.length - text.length)
  }
  return [
    ...mentions.filter(hit => hit.usage !== 'audio').map(hit => ({
      ...hit, start: view.displayOffset(hit.start), end: view.displayOffset(hit.end, true),
    })),
    ...view.cues.map(cue => ({ id: `voice-${cue.index}`, start: cue.tokenStart, end: cue.tokenEnd })),
  ].sort((a, b) => a.start - b.start)
}
let lastEdit: { display: string; source: string; changed: boolean } | undefined
type PromptSelection = Pick<HTMLTextAreaElement, 'selectionStart' | 'selectionEnd' | 'selectionDirection'>
type PromptView = ReturnType<typeof scriptVideoPromptVoiceView>
type PromptSnapshot = ReturnType<typeof promptSnapshot>
// Replacing the textarea to refresh resolved references clears its native undo stack.
// Keep snapshots of the authored text so undo does not depend on attachment numbers.
const undoEdits: PromptSnapshot[] = [], redoEdits: PromptSnapshot[] = []
let historySource: string | undefined

function promptSnapshot(view: PromptView, selection?: PromptSelection) {
  function offset(position = view.text.length) {
    return {
      source: view.sourceOffset(position),
      beforeCue: view.cues.some(cue => cue.sourceStart === cue.sourceEnd && cue.start === position),
    }
  }
  return { source: view.source, start: offset(selection?.selectionStart), end: offset(selection?.selectionEnd),
    direction: selection?.selectionDirection }
}
function resetPromptHistory() {
  historySource = undefined
  undoEdits.length = 0
  redoEdits.length = 0
}
function movePromptHistory(action: 'undo' | 'redo') {
  const { view, prefix } = activePrompt.value
  if (historySource !== view.source) {
    resetPromptHistory()
    return
  }
  const from = action === 'undo' ? undoEdits : redoEdits
  const to = action === 'undo' ? redoEdits : undoEdits
  const snapshot = from.pop()
  if (!snapshot) return
  to.push(promptSnapshot(view, promptInput.value?.editingPosition()))
  promptDraft.value = updatePrompt(joinPrompt(prefix, snapshot.source))
  const { view: updated, normalizedOffset: normalize } = activePrompt.value
  historySource = updated.source
  lastEdit = { display: updated.text, source: updated.source, changed: true }
  promptInput.value?.syncDisplay(updated.text, updated.displayOffset(normalize(snapshot.start.source), snapshot.start.beforeCue),
    updated.displayOffset(normalize(snapshot.end.source), snapshot.end.beforeCue), snapshot.direction)
}

function beginPromptEdit() {
  if (promptDraft.value?.id === props.card.id) return
  promptDraft.value = { ...props.card }
}
function clearPromptEdit() {
  promptDraft.value = undefined
  compositionProjection.value = undefined
  lastEdit = undefined
}
watch([() => props.card.id, tab], () => {
  if (promptDialog.value?.open) promptDialog.value.close()
  clearPromptEdit()
  resetPromptHistory()
})

function editPrompt(display: string, input: HTMLTextAreaElement, previousSelection?: PromptSelection) {
  const cardId = props.card.id
  const { view, prefix } = promptProjection.value
  const edit = editScriptVideoPromptVoiceView(view, display, input.selectionStart, input.selectionEnd, previousSelection)
  const direction = input.selectionDirection
  const changed = edit.text !== view.source
  lastEdit = { display, source: edit.text, changed: changed || lastEdit?.changed === true }
  // Save authored edits as usual. A save acknowledgement may normalize the
  // stored prompt, but should not replace the active textarea under its caret.
  if (changed) {
    if (historySource !== view.source) resetPromptHistory()
    undoEdits.push(promptSnapshot(view, previousSelection))
    if (undoEdits.length > 100) undoEdits.shift()
    redoEdits.length = 0
    promptDraft.value = updatePrompt(joinPrompt(prefix, edit.text))
    historySource = activePrompt.value.view.source
  }
  else if (promptDraft.value?.id !== cardId) promptDraft.value = { ...props.card }
  const { view: updated, normalizedOffset: normalize } = activePrompt.value
  // Write the normalized display and selection together before Vue updates the native field.
  if (display !== updated.text) {
    promptInput.value?.syncDisplay(updated.text, updated.displayOffset(normalize(edit.selectionStart), edit.beforeCue),
      updated.displayOffset(normalize(edit.selectionEnd), edit.beforeCue), direction)
  }
}
const actionWarningId = useId()
const actionWarnings = computed(() => {
  const warnings: string[] = []
  if (assetBindingRows.value.length && !props.recoveringVideoDelivery) warnings.push('请先确认本片段需要的参考素材。')
  if (props.card.manuallyAdded) return hasPromptBody.value ? warnings : [...warnings, '请输入视频提示词。']
  if (!props.card.shots.length) warnings.push('请先添加镜头。')
  else if (overLimit.value) warnings.push(`镜头合计 ${totalDuration.value} 秒，超过单段 30 秒上限。`)
  else if (totalDuration.value <= 0) warnings.push('镜头总时长必须大于 0 秒。')
  if (props.card.promptNeedsSync)
    warnings.push('镜头已修改，视频提示词待同步。可让 AI 按当前分镜更新，也可到「视频提示词」手动修改。')
  if (props.videoVoiceWarning)
    warnings.push(props.videoVoiceWarning)
  return warnings
})
const advisoryWarnings = computed(() => analyzedPrompt.value.warnings.map(issue => issue.message))
function updatePrompt(prompt: string): PreviewCard {
  const { mentions } = analyzePrompt(prompt)
  const characters = new Set(props.assets.filter(asset => asset.kind === 'character').map(asset => asset.id))
  const assetIds = new Set(mentions
    .filter(hit => !hit.literal && characters.has(hit.id) || hit.explicit && hit.usage !== 'context')
    .map(hit => hit.id))
  const next = {
    ...replacePreviewPrompt(props.card, prompt, { before: savedPrompt.value.authoredMentions, after: mentions }),
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
  if (blurred && movingPromptEditor) return
  const { view, prefix } = promptProjection.value
  const source = text === view.text ? view.source : lastEdit?.display === text ? lastEdit.source
    : editScriptVideoPromptVoiceView(view, text, text.length, text.length).text
  const edited = lastEdit?.changed === true
  if (blurred) clearPromptEdit()
  const authoredPrompt = joinPrompt(prefix, source)
  const result = analyzePrompt(authoredPrompt)
  const ids = [...new Set([...props.card.assetIds, ...result.assetIds])]
  const saved = savedPrompt.value
  const savedText = textareaText(saved.normalizedText)
  const savedIncludesEdit = savedText === result.text || saved.view.source === view.source ||
    (!!result.text && savedText.endsWith('\n\n' + result.text))
  // Accept server normalization after editing only if the saved text contains this edit.
  const currentText = textareaText(props.card.prompt)
  const prompt = blurred && result.text === joinPrompt(prefix, view.source) && (!edited || savedIncludesEdit) ? saved.normalizedText
    : result.text === currentText ? props.card.prompt : result.text
  if (prompt === props.card.prompt && ids.length === props.card.assetIds.length) return
  const after = prompt === authoredPrompt ? result.mentions : analyzePrompt(textareaText(prompt)).mentions
  emit('update', checkedPromptUpdate({
    ...replacePreviewPrompt(props.card, prompt, { before: savedPrompt.value.authoredMentions, after }),
    assetIds: ids,
  }))
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
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
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
  padding: 15px 28px 0px;
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
  padding: 5px 1px;
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
  padding: 15px 28px 28px;
}
.sv-body-preview {
  display: flex;
  overflow: hidden;
  padding-block: 14px;
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
.sv-reference-head p {
  margin-top: 5px;
  color: var(--text-3);
  font-size: 12px;
}
.sv-caption {
  color: var(--text-3);
  font-size: 11px;
  white-space: nowrap;
}
.sv-editor :deep(.sv-prompt-input) {
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
.sv-editor :deep(.mention-input.sv-prompt-input) {
  background: transparent;
  color: transparent;
}
.sv-editor :deep(.mention-backdrop.sv-prompt-input) {
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
.sv-action-warning-actions,
.sv-asset-binding-options {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.sv-asset-bindings {
  margin-bottom: 16px;
  padding: 9px 13px;
  border: 1px solid var(--border-strong, var(--border));
  border-radius: 7px;
  background: var(--surface-1, var(--bg-2));
  overflow-wrap: anywhere;
}
.sv-asset-bindings:focus {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.sv-asset-bindings h3 {
  margin: 0 0 8px;
  color: var(--warning, #b77429);
  font-size: 13px;
}
.sv-asset-bindings ul {
  margin: 0;
  padding: 0;
  list-style: none;
}
.sv-asset-bindings li {
  display: grid;
  gap: 4px;
  font-size: 12px;
}
.sv-asset-bindings li + li {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
.sv-asset-bindings p {
  margin: 0;
}
.sv-asset-binding-source,
.sv-asset-bindings small {
  color: var(--text-2);
  font-weight: 400;
}
.sv-asset-binding-options button {
  max-width: 100%;
  text-align: left;
  white-space: normal;
}
.sv-asset-binding-options small {
  margin-inline-start: 4px;
}
.sv-asset-binding-other {
  max-width: 360px;
  color: var(--text-2);
}
.sv-asset-binding-other summary {
  cursor: pointer;
}
.sv-asset-binding-other[open] summary {
  margin-bottom: 5px;
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
.sv-prompt-dialog {
  width: min(1120px, calc(100vw - 32px));
  height: min(780px, calc(100dvh - 48px));
  overflow: visible;
}
.sv-prompt-dialog[open] {
  display: flex;
  flex-direction: column;
}
.sv-prompt-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px clamp(14px, 2vw, 24px);
  border-bottom: 1px solid var(--border);
}
.sv-prompt-dialog-header h3 { font-size: 16px; }
.sv-prompt-dialog-header p {
  margin-top: 4px;
  color: var(--text-2);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.sv-prompt-dialog-header button { flex-shrink: 0; }
.sv-prompt-dialog-body {
  display: flex;
  flex: 1;
  min-height: 0;
  padding: 14px clamp(14px, 2vw, 24px) clamp(14px, 2vw, 24px);
}
.sv-prompt-dialog-body :deep(.sv-prompt-input) {
  min-height: 0;
  font-size: 15px;
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
  flex: 1;
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
}
.sv-player video {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 0;
  object-fit: contain;
  background: var(--bg-2);
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
