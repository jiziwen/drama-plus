<template>
  <section class="sv-revision">
    <header class="sv-revision-head">
      <div>
        <h3>调整视频提示词</h3>
        <p>按修改意见调用文字模型，自动核对分镜和资产引用</p>
      </div>
      <button type="button" class="sv-link" @click="$emit('close')">
        返回提示词
      </button>
    </header>
    <p class="sv-context">
      {{ card.duration }} 秒 · {{ card.assetIds.length }} 个已关联素材
    </p>
    <label class="sv-input-label" for="sv-revision-instruction">修改意见</label>
    <textarea
      id="sv-revision-instruction"
      v-model="instruction"
      class="sv-instruction"
      rows="3"
      placeholder="说说你希望怎样调整，例如：让人物动作和镜头衔接更清楚"
    />
    <div class="sv-suggestions">
      <button v-for="tip in tips" :key="tip" type="button" @click="addTip(tip)">
        {{ tip }}
      </button>
    </div>
    <div class="sv-generate-actions">
      <button
        type="button"
        class="sv-action sv-generate"
        :disabled="!instruction.trim() || working || revisionBlocked || stale"
        @click="generate"
      >
        {{ working ? '正在生成修改候选…' : '生成修改候选' }} <span>↗</span>
      </button>
      <button
        v-if="revisionState"
        type="button"
        class="sv-action sv-outline"
        :disabled="revisionState === 'canceling'"
        @click="emit('cancel')"
      >{{ revisionState === 'canceling' ? '正在取消…' : '取消生成' }}</button>
    </div>
    <p v-if="error" class="sv-warning" role="status">{{ error }}</p>

    <div v-if="candidate" class="sv-compare">
      <div class="sv-compare-head">
        <div>
          <h4>修改建议</h4>
          <p>{{ candidate.summary }}</p>
        </div>
        <button type="button" class="sv-link" :disabled="working" @click="discard">撤回候选</button>
      </div>
      <p v-if="stale" class="sv-warning" role="alert">
        提示词或素材已变化，这份候选已过期。请撤回后重新生成，避免覆盖新内容。
      </p>
      <div class="sv-compare-grid">
        <label
          ><span>当前提示词</span
          ><textarea :value="basePrompt" readonly rows="9" /></label
        ><label
          ><span>建议版本 · 可编辑</span
          ><textarea v-model="candidate.prompt" rows="9" />
        </label>
      </div>
      <div class="sv-compare-actions">
        <button
          type="button"
          class="sv-action sv-outline"
          :disabled="stale || working"
          @click="continueAdjust"
        >
          继续调整</button
        ><button
          type="button"
          class="sv-action sv-primary"
          :disabled="stale || working || !candidate.prompt.trim()"
          @click="applyCandidate"
        >
          采用本次修改
        </button>
      </div>
    </div>

    <div class="sv-history">
      <div class="sv-history-head">
        <h4>历史版本</h4>
        <span>{{ versions.length }} 条</span>
      </div>
      <p v-if="!versions.length" class="sv-empty">
        采用修改后，这里会保留提示词版本。
      </p>
      <div
        v-for="version in [...versions].reverse()"
        :key="version.id"
        class="sv-history-row"
      >
        <div>
          <strong>{{ version.summary || '提示词版本' }}</strong
          ><small
            >{{ version.instruction || '原始提示词' }} ·
            {{ formatTime(version.createdAt) }}</small
          >
        </div>
        <button
          type="button"
          class="sv-link"
          @click="viewedId = viewedId === version.id ? null : version.id"
        >
          {{ viewedId === version.id ? '收起' : '查看' }}</button
        ><button
          type="button"
          class="sv-link"
          :disabled="working || missingVersionAssets(version)"
          @click="restoreVersion(version)"
        >
          恢复
        </button>
        <p v-if="missingVersionAssets(version)" class="sv-history-warning">
          版本引用的素材已不存在或缺少图片，请先补充素材。
        </p>
        <div v-if="viewedId === version.id" class="sv-history-content">
          {{ version.prompt }}
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  replacePreviewPrompt,
  type PreviewCard,
  type PreviewAsset,
  type PreviewPromptVersion,
} from '~/utils/scriptVideoPreview'
import { inspectPreviewCardAssets, validatePreviewCards, type PreviewAssetContext } from '~/utils/scriptVideoPreviewValidation'
import type { ScriptVideoRevisionCandidate } from '~/utils/scriptVideoClient'

const props = defineProps<{
  card: PreviewCard
  assets: PreviewAsset[]
  assetContext?: PreviewAssetContext
  revisionState?: 'running' | 'canceling'
  revisionBlocked?: boolean
  restoredRevision?: ScriptVideoRevisionCandidate
  requestRevision: (
    card: PreviewCard,
    instruction: string,
  ) => Promise<ScriptVideoRevisionCandidate>
}>()
const emit = defineEmits<{ apply: [card: PreviewCard]; close: []; cancel: []; consumeRestoredRevision: [] }>()
const tips = ['节奏更紧凑', '打斗更具体', '镜头更清楚', '减少特效']
const instruction = ref('')
const loading = ref(false)
const working = computed(() => loading.value || !!props.revisionState)
const error = ref('')
const candidate = ref<{
  prompt: string
  summary: string
  card: PreviewCard
} | null>(null)
const basePrompt = ref('')
const baseFingerprint = ref('')
const continueFromCandidate = ref(false)
const candidateInstruction = ref('')
const viewedId = ref<string | null>(null)
let timer: ReturnType<typeof setTimeout> | undefined
let alive = true
let requestId = 0
const versions = computed(() => props.card.promptVersions || [])
const fingerprint = () =>
  JSON.stringify({
    shots: props.card.shots,
    prompt: props.card.prompt,
    assetIds: props.card.assetIds,
    assets: props.card.assetIds.map((id) => {
      const asset = props.assets.find((item) => item.id === id)
      return asset
        ? { id: asset.id, name: asset.name, image: asset.image }
        : null
    }),
  })
const stale = computed(
  () => !!candidate.value && fingerprint() !== baseFingerprint.value,
)
watch(() => props.restoredRevision, (result) => {
  if (!result) return
  emit('consumeRestoredRevision')
  if (result.baseCardVersion !== props.card.version) {
    error.value = '当前分镜已修改，请重新生成候选。'
    return
  }
  setCandidate(result, fingerprint(), props.card.prompt, '')
}, { immediate: true })
function addTip(tip: string) {
  instruction.value = instruction.value.trim()
    ? `${instruction.value.trim()}；${tip}`
    : tip
}
async function generate() {
  const input = instruction.value.trim()
  if (!input || working.value || props.revisionBlocked || stale.value) return
  loading.value = true
  error.value = ''
  const request = ++requestId,
    snapshot = fingerprint(),
    original = props.card.prompt
  const source =
    candidate.value && continueFromCandidate.value
      ? candidate.value.prompt
      : original
  try {
    const result = await props.requestRevision(
      { ...props.card, prompt: source },
      input,
    )
    if (!alive || request !== requestId) return
    setCandidate(result, snapshot, original, input)
  } catch (err: any) {
    if (alive && request === requestId && err.name !== 'AbortError')
      error.value = err.message || 'AI 修改未完成，当前版本已保留。'
  } finally {
    if (alive && request === requestId) loading.value = false
  }
}
function setCandidate(result: ScriptVideoRevisionCandidate, snapshot: string, original: string, input: string) {
  baseFingerprint.value = snapshot
  basePrompt.value = original
  candidate.value = { card: result.card, prompt: result.card.prompt, summary: result.summary }
  checkCandidate(result.card)
  candidateInstruction.value = input
  continueFromCandidate.value = false
}
function discard() {
  requestId++
  if (timer) clearTimeout(timer)
  loading.value = false
  candidate.value = null
  continueFromCandidate.value = false
  candidateInstruction.value = ''
  error.value = ''
}
function continueAdjust() {
  if (!candidate.value || stale.value) return
  continueFromCandidate.value = true
  instruction.value = ''
  error.value = '请填写下一步修改意见，再生成修改候选。'
}
function makeVersion(
  prompt: string,
  instructionText: string,
  summary: string,
  assetIds = props.card.assetIds,
  excluded = props.card.excludedAssetIds || [],
): PreviewPromptVersion {
  return {
    assetIds: [...assetIds],
    ...(excluded.length ? { excludedAssetIds: [...excluded] } : {}),
    id: `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    prompt,
    instruction: instructionText,
    summary,
    createdAt: new Date().toISOString(),
  }
}
function historyWithCurrent() {
  const history = [...versions.value]
  if (
    !history.length ||
    history[history.length - 1]?.prompt !== props.card.prompt ||
    JSON.stringify(history[history.length - 1]?.assetIds) !==
      JSON.stringify(props.card.assetIds) ||
    JSON.stringify(history.at(-1)?.excludedAssetIds || []) !== JSON.stringify(props.card.excludedAssetIds || [])
  )
    history.push(makeVersion(props.card.prompt, '', '修改前的提示词'))
  return history
}
function applyCandidate() {
  if (!candidate.value || stale.value || !candidate.value.prompt.trim()) return
  const prompt = candidate.value.prompt
  if (!checkCandidate({ ...candidate.value.card, prompt })) return
  const promptVersions = [
    ...historyWithCurrent(),
    makeVersion(prompt, candidateInstruction.value, candidate.value.summary, candidate.value.card.assetIds, candidate.value.card.excludedAssetIds || []),
  ]
  emit('apply', { ...candidate.value.card, prompt, promptVersions })
  discard()
}
function checkCandidate(card: PreviewCard) {
  const result = validatePreviewCards([card], props.assets, props.assetContext)
  error.value = result.ok
    ? ''
    : result.issues
        .filter((issue) => issue.level === 'ERROR')
        .map((issue) => issue.message)
        .join('；')
  return result.ok
}
function missingVersionAssets(version: PreviewPromptVersion) {
  const card = { ...replacePreviewPrompt(props.card, version.prompt), assetIds: version.assetIds, excludedAssetIds: version.excludedAssetIds }
  return inspectPreviewCardAssets(card, props.assets, props.assetContext).issues.some(issue => issue.code === 'ASSET_GAP')
}
function restoreVersion(version: PreviewPromptVersion) {
  if (working.value) return
  const card = {
    ...replacePreviewPrompt(props.card, version.prompt),
    assetIds: [...version.assetIds],
    excludedAssetIds: version.excludedAssetIds,
  }
  if (!checkCandidate(card)) return
  const promptVersions = [
    ...historyWithCurrent(),
    makeVersion(
      version.prompt,
      '恢复历史版本',
      `恢复：${version.summary || '提示词版本'}`,
      version.assetIds, version.excludedAssetIds || [],
    ),
  ]
  emit('apply', { ...card, promptVersions })
  discard()
}
function formatTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
}
onBeforeUnmount(() => {
  alive = false
  if (timer) clearTimeout(timer)
})
</script>

<style scoped>
.sv-generate-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.sv-revision {
  color: var(--text-0);
  font-size: 12px;
}
.sv-revision h3,
.sv-revision h4,
.sv-revision p {
  margin: 0;
}
.sv-revision-head,
.sv-compare-head,
.sv-history-head {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 12px;
}
.sv-revision h3 {
  font-size: 14px;
}
.sv-revision h4 {
  font-size: 13px;
}
.sv-revision-head p,
.sv-compare-head p {
  margin-top: 5px;
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.6;
}
.sv-context {
  margin: 14px 0 !important;
  color: var(--text-3);
  font-size: 11px;
}
.sv-input-label {
  display: block;
  margin-bottom: 7px;
  color: var(--text-2);
  font-weight: 600;
}
.sv-instruction,
.sv-compare textarea {
  box-sizing: border-box;
  width: 100%;
  resize: vertical;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-input, var(--bg-input));
  color: var(--text-0);
  padding: 11px;
  font: inherit;
  line-height: 1.7;
}
.sv-suggestions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 9px 0 13px;
}
.sv-suggestions button {
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 99px;
  background: transparent;
  color: var(--text-2);
  font: inherit;
  cursor: pointer;
}
.sv-action {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  gap: 14px;
  min-height: 34px;
  padding: 7px 11px;
  border: 1px solid var(--border);
  border-radius: 7px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.sv-generate,
.sv-primary {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
}
.sv-outline {
  background: transparent;
  color: var(--text-1);
}
.sv-action:disabled,
.sv-link:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.sv-link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--accent-text, var(--accent));
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.sv-warning {
  margin-top: 11px !important;
  color: var(--warning, #b77429);
  line-height: 1.6;
}
.sv-compare,
.sv-history {
  margin-top: 22px;
  padding-top: 18px;
  border-top: 1px solid var(--border);
}
.sv-compare-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-top: 12px;
}
.sv-compare-grid label {
  min-width: 0;
}
.sv-compare-grid label span {
  display: block;
  margin-bottom: 6px;
  color: var(--text-2);
  font-size: 11px;
}
.sv-compare textarea[readonly] {
  color: var(--text-2);
}
.sv-compare-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}
.sv-history-head span,
.sv-empty {
  color: var(--text-3);
  font-size: 11px;
}
.sv-empty {
  margin-top: 12px !important;
}
.sv-history-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}
.sv-history-row > div:first-child {
  flex: 1;
  min-width: 0;
}
.sv-history-row strong,
.sv-history-row small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sv-history-row strong {
  font-weight: 600;
}
.sv-history-row small {
  margin-top: 5px;
  color: var(--text-3);
}
.sv-history-warning {
  flex: 0 0 100%;
  color: var(--warning, #b77429);
  font-size: 11px;
}
.sv-history-content {
  flex: 0 0 100%;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  padding: 10px;
  border-radius: 7px;
  background: var(--surface-input, var(--bg-input));
  color: var(--text-2);
  line-height: 1.7;
}
.sv-revision button:focus-visible,
.sv-revision textarea:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
@media (max-width: 600px) {
  .sv-compare-grid {
    grid-template-columns: 1fr;
  }
}
</style>
