<template>
  <div class="ai-chat-shell" :class="{ 'sidebar-collapsed': !sidebarOpen }">
    <!-- Mobile backdrop -->
    <div v-if="sidebarOpen" class="chat-sidebar-backdrop" @click="sidebarOpen = false" />

    <!-- Left Sidebar: Conversations -->
    <aside class="chat-sidebar" :class="{ open: sidebarOpen }" aria-label="对话列表">
      <div class="chat-sidebar-head">
        <button class="btn btn-primary chat-new-btn" type="button" :disabled="streaming" @click="startNewChat">
          <Plus :size="15" aria-hidden="true" /> 新建对话
        </button>
        <button class="chat-icon-btn chat-sidebar-close" type="button" aria-label="收起对话列表" @click="sidebarOpen = false">
          <PanelLeftClose :size="16" />
        </button>
      </div>

      <div class="chat-session-list">
        <div v-if="loadingList" class="chat-sidebar-empty">
          <LoaderCircle class="chat-spin" :size="16" /> 正在加载对话…
        </div>
        <div v-else-if="!sessions.length" class="chat-sidebar-empty">
          还没有对话记录，开始提问吧。
        </div>
        <button
          v-for="item in sessions"
          :key="item.id"
          type="button"
          class="chat-session-item"
          :class="{ active: activeSession?.id === item.id }"
          :disabled="streaming && activeSession?.id !== item.id"
          @click="openSession(item.id)"
        >
          <MessageSquare :size="14" class="chat-session-icon" aria-hidden="true" />
          <div class="chat-session-meta">
            <span class="chat-session-title">{{ item.title }}</span>
            <small class="chat-session-sub">
              {{ item.messageCount }} 条消息
              <template v-if="item.compressedUntil > 0"> · 已压缩</template>
            </small>
          </div>
          <span
            class="chat-session-delete"
            role="button"
            tabindex="0"
            aria-label="删除对话"
            title="删除对话"
            @click.stop="removeSession(item.id)"
            @keydown.enter.stop.prevent="removeSession(item.id)"
          >
            <Trash2 :size="13" />
          </span>
        </button>
      </div>
    </aside>

    <!-- Main Chat Area -->
    <section class="chat-main">
      <!-- Top Bar -->
      <header class="chat-topbar">
        <div class="chat-topbar-left">
          <button
            class="chat-icon-btn"
            type="button"
            :aria-label="sidebarOpen ? '收起侧边栏' : '展开侧边栏'"
            :title="sidebarOpen ? '收起侧边栏' : '展开侧边栏'"
            @click="sidebarOpen = !sidebarOpen"
          >
            <PanelLeftOpen v-if="!sidebarOpen" :size="17" />
            <PanelLeftClose v-else :size="17" />
          </button>
          <div class="chat-title-wrap">
            <h1>{{ activeSession?.title || 'AI 聊天' }}</h1>
            <span v-if="contextUsageLabel" class="chat-context-pill" :title="contextTooltip">
              {{ contextUsageLabel }}
            </span>
          </div>
        </div>

        <div class="chat-topbar-actions">
          <button
            v-if="activeSession?.summary"
            class="btn btn-sm chat-summary-toggle"
            type="button"
            @click="showSummary = !showSummary"
          >
            <Minimize2 :size="13" aria-hidden="true" />
            已压缩 {{ activeSession.compressedUntil }} 条历史
          </button>
          <button
            v-if="canManualCompress"
            class="btn btn-sm"
            type="button"
            :disabled="streaming || compressing"
            title="将较早对话压缩为摘要以释放上下文空间"
            @click="manualCompress"
          >
            <LoaderCircle v-if="compressing" class="chat-spin" :size="13" />
            <Archive v-else :size="13" aria-hidden="true" />
            压缩上下文
          </button>
          <button class="btn btn-sm" type="button" :disabled="streaming" @click="startNewChat">
            <Plus :size="14" aria-hidden="true" /> 新对话
          </button>
        </div>
      </header>

      <!-- Collapsible Summary Banner -->
      <div v-if="showSummary && activeSession?.summary" class="chat-summary-drawer">
        <div class="chat-summary-drawer-head">
          <span><Archive :size="14" /> 自动压缩的历史上下文摘要（前 {{ activeSession.compressedUntil }} 条消息）</span>
          <button class="chat-icon-btn" type="button" aria-label="关闭摘要" @click="showSummary = false">
            <X :size="14" />
          </button>
        </div>
        <div class="chat-summary-drawer-body">{{ activeSession.summary }}</div>
      </div>

      <!-- Error Banner -->
      <p v-if="error" class="chat-error-banner" role="alert">
        <CircleAlert :size="16" aria-hidden="true" />
        <span>{{ error }}</span>
        <button class="chat-icon-btn" type="button" aria-label="关闭提示" @click="error = ''">
          <X :size="14" />
        </button>
      </p>

      <!-- Message Viewport -->
      <div ref="scrollContainer" class="chat-messages" @scroll="handleScroll">
        <div v-if="loadingSession" class="chat-empty-state" role="status">
          <LoaderCircle class="chat-spin" :size="24" />
          <p>正在加载对话内容…</p>
        </div>

        <!-- Empty Welcome State -->
        <div v-else-if="!displayMessages.length" class="chat-empty-state">
          <div class="chat-welcome-mark">
            <Sparkles :size="26" aria-hidden="true" />
          </div>
          <h2>有什么可以帮你的？</h2>
          <p>支持流式实时输出与多模型切换；当对话达到模型上下文上限时，会自动压缩历史记录并继续回答。</p>
          <div class="chat-starter-grid">
            <button
              v-for="starter in starterPrompts"
              :key="starter.title"
              type="button"
              class="chat-starter-card"
              :disabled="!hasAnyModel || streaming"
              @click="useStarter(starter.prompt)"
            >
              <strong>{{ starter.title }}</strong>
              <span>{{ starter.desc }}</span>
            </button>
          </div>
        </div>

        <!-- Messages List -->
        <div v-else class="chat-thread">
          <template v-for="(msg, index) in displayMessages" :key="msg.id">
            <div
              v-if="activeSession && activeSession.compressedUntil > 0 && index === activeSession.compressedUntil"
              class="chat-compression-divider"
            >
              <span>以上 {{ activeSession.compressedUntil }} 条较早对话已自动压缩为上下文摘要</span>
              <button type="button" @click="showSummary = !showSummary">
                {{ showSummary ? '收起摘要' : '查看摘要' }}
              </button>
            </div>

            <article class="chat-message" :class="[`role-${msg.role}`, { streaming: isStreamingMessage(msg) }]">
              <div v-if="msg.role === 'assistant'" class="chat-avatar" aria-hidden="true">
                <Bot :size="17" />
              </div>

              <div class="chat-bubble-wrap">
                <div v-if="msg.role === 'assistant'" class="chat-msg-meta">
                  <span class="chat-msg-author">AI 助手</span>
                  <span v-if="msg.model" class="chat-msg-model">{{ modelLabel(msg.model) }}</span>
                  <span v-if="msg.compression" class="chat-msg-compressed" title="本轮回答前自动触发了上下文压缩">
                    <Archive :size="11" /> 已压缩 {{ msg.compression.compressedCount }} 条上下文后继续回答
                  </span>
                </div>

                <!-- Thinking / Reasoning Collapsible -->
                <details
                  v-if="msg.reasoning"
                  class="chat-reasoning"
                  :open="isStreamingMessage(msg) && !msg.content"
                >
                  <summary>
                    <Brain :size="13" aria-hidden="true" />
                    <span>{{ isStreamingMessage(msg) && !msg.content ? '正在深度思考…' : '已深度思考' }}</span>
                  </summary>
                  <div class="chat-reasoning-body">{{ msg.reasoning }}</div>
                </details>

                <!-- Compression / Streaming Live Status inside active streaming turn -->
                <div v-if="isStreamingMessage(msg) && liveStatus" class="chat-live-status" :class="{ compressing: livePhase === 'compressing' }">
                  <LoaderCircle class="chat-spin" :size="14" aria-hidden="true" />
                  <span>{{ liveStatus }}</span>
                </div>

                <!-- Message Body -->
                <div v-if="msg.role === 'user'" class="chat-user-bubble">
                  <ul v-if="msg.attachments?.length" class="chat-file-list" aria-label="消息附件">
                    <li v-for="(file, fileIndex) in msg.attachments" :key="fileIndex" class="chat-file-chip">
                      <FileText :size="15" aria-hidden="true" />
                      <span class="chat-file-name" :title="file.name">{{ file.name }}</span>
                      <span class="chat-file-size">{{ formatFileSize(file.size) }}</span>
                    </li>
                  </ul>
                  <div v-if="msg.content" class="chat-user-text">{{ msg.content }}</div>
                </div>
                <div
                  v-else
                  class="chat-assistant-body chat-markdown"
                  :class="{ 'is-streaming': isStreamingMessage(msg) }"
                >
                  <div v-if="msg.content" v-html="renderChatMarkdown(msg.content)" />
                  <span v-else-if="isStreamingMessage(msg) && !liveStatus" class="chat-typing-dots"><i /><i /><i /></span>
                  <p v-if="msg.error" class="chat-msg-error">{{ msg.error }}</p>
                </div>

                <!-- Message Actions -->
                <div v-if="!isStreamingMessage(msg) && (msg.content || msg.error || msg.attachments?.length)" class="chat-msg-actions">
                  <button
                    v-if="msg.content"
                    type="button"
                    class="chat-action-btn"
                    @click="copyText(msg.id, msg.content)"
                  >
                    <Check v-if="copiedId === msg.id" :size="12" />
                    <Copy v-else :size="12" />
                    <span>{{ copiedId === msg.id ? '已复制' : '复制' }}</span>
                  </button>
                  <button
                    v-if="index === displayMessages.length - 1"
                    type="button"
                    class="chat-action-btn"
                    :disabled="streaming"
                    @click="regenerateLast"
                  >
                    <RotateCcw :size="12" />
                    <span>重新生成</span>
                  </button>
                </div>
              </div>
            </article>
          </template>
        </div>

        <button
          v-if="userScrolledUp && displayMessages.length"
          type="button"
          class="chat-scroll-bottom"
          aria-label="回到底部"
          @click="scrollToBottom(true)"
        >
          <ArrowDown :size="15" /> 回到底部
        </button>
      </div>

      <!-- Bottom Composer -->
      <footer class="chat-composer-wrap">
        <div v-if="!modelsLoading && !hasAnyModel" class="chat-no-model-notice">
          <TriangleAlert :size="14" />
          <span>尚未启用文字模型，请先前往右上角「设置」配置文字 AI 服务。</span>
          <button type="button" class="btn btn-sm" @click="openSettings('ai')">前往配置</button>
        </div>

        <div class="chat-composer" :class="{ focused: inputFocused, disabled: !hasAnyModel }">
          <ul v-if="draftFiles.length" class="chat-file-list" aria-label="待发送附件">
            <li v-for="(file, index) in draftFiles" :key="fileKey(file)" class="chat-file-chip">
              <FileText :size="15" aria-hidden="true" />
              <span class="chat-file-name" :title="file.name">{{ file.name }}</span>
              <span class="chat-file-size">{{ formatFileSize(file.size) }}</span>
              <button
                class="chat-icon-btn chat-file-remove"
                type="button"
                :aria-label="`移除 ${file.name}`"
                :disabled="streaming"
                @click="draftFiles.splice(index, 1)"
              ><X :size="13" aria-hidden="true" /></button>
            </li>
          </ul>
          <textarea
            ref="inputEl"
            v-model="draftInput"
            rows="1"
            :placeholder="hasAnyModel ? '输入你的问题，Enter 发送，Shift + Enter 换行…' : '请先在设置中配置并启用文字模型…'"
            :disabled="!hasAnyModel || awaitingAcceptance"
            @focus="inputFocused = true"
            @blur="inputFocused = false"
            @input="autoResizeInput"
            @keydown="handleKeydown"
          />

          <div class="chat-composer-bar">
            <div class="chat-composer-tools">
              <input ref="fileInput" type="file" :accept="attachmentAccept" multiple hidden @change="onChooseFiles" />
              <button
                class="btn chat-attach-btn"
                type="button"
                aria-label="上传文件"
                title="上传 TXT、MD、CSV、TSV、JSON、SRT、VTT、DOCX 或 PDF。每条最多 5 个，每个 10 MB，合计 20 MB。"
                :disabled="!hasAnyModel || streaming || loadingSession || draftFiles.length >= CHAT_ATTACHMENT_COUNT_LIMIT"
                @click="fileInput?.click()"
              ><Paperclip :size="15" aria-hidden="true" /> <span>上传文件</span></button>
              <div class="chat-model-picker">
                <BaseSelect
                  :model-value="selectedModelKey"
                  :options="modelSelectOptions"
                  :searchable="modelSelectOptions.length > 6"
                  :disabled="streaming || modelsLoading"
                  aria-label="选择对话模型"
                  variant="inspector"
                  @update:model-value="onSelectModel"
                >
                  <template #label="{ option }">
                    <span class="chat-model-option">
                      <img
                        v-if="modelIconUrl(option.provider, option.rawModel)"
                        :src="modelIconUrl(option.provider, option.rawModel)"
                        class="chat-model-icon"
                        alt=""
                        loading="lazy"
                        decoding="async"
                      />
                      <span class="chat-model-name">{{ option.label }}</span>
                    </span>
                  </template>
                </BaseSelect>
              </div>
            </div>

            <div class="chat-composer-right">
              <span v-if="draftInput.length" class="chat-char-count">{{ draftInput.length }} 字</span>
              <button
                v-if="streaming"
                type="button"
                class="btn chat-stop-btn"
                @click="stopGeneration"
              >
                <Square :size="13" fill="currentColor" aria-hidden="true" /> 停止
              </button>
              <button
                v-else
                type="button"
                class="btn btn-primary chat-send-btn"
                :disabled="!canSend"
                aria-label="发送消息"
                @click="sendMessage()"
              >
                <SendHorizontal :size="15" aria-hidden="true" />
                <span>发送</span>
              </button>
            </div>
          </div>
        </div>
      </footer>
    </section>
  </div>
</template>

<script setup lang="ts">
import {
  Archive,
  ArrowDown,
  Bot,
  Brain,
  Check,
  CircleAlert,
  Copy,
  FileText,
  LoaderCircle,
  MessageSquare,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Plus,
  RotateCcw,
  SendHorizontal,
  Sparkles,
  Square,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-vue-next'
import { aiChatAPI } from '~/composables/useApi'
import { modelIconUrl } from '~/composables/useProviderIcon'
import { renderChatMarkdown } from '~/utils/markdown'
import {
  CHAT_ATTACHMENT_COUNT_LIMIT,
  CHAT_ATTACHMENT_EXTENSIONS,
  CHAT_ATTACHMENT_FILE_BYTES,
  CHAT_ATTACHMENT_TOTAL_BYTES,
  chatAttachmentExtension,
} from '../../../backend/src/services/ai-chat-attachment-limits'
import type {
  ChatMessage,
  ChatModelOption,
  ChatModelSelection,
  ChatSession,
  ChatSessionSummary,
} from '../../../backend/src/services/ai-chat-types'

const starterPrompts = [
  {
    title: '短剧黄金前三秒开场',
    desc: '帮我设计 3 个强冲突、高反转的短剧开场钩子',
    prompt: '请帮我设计 3 个适合下沉市场短剧的黄金前三秒开场冲突方案，分别覆盖逆袭打脸、家庭伦理和职场悬疑，并给出首句台词示例。',
  },
  {
    title: '润色剧本台词张力',
    desc: '把平铺直叙的对白改成更有情绪交锋的短剧台词',
    prompt: '请给我一套短剧台词润色原则，并示范如何把平淡的日常对话改写成节奏紧凑、潜台词丰富、有情绪反转的短剧对白。',
  },
  {
    title: '分镜与提示词拆解',
    desc: '把一段剧情拆成适合生图和视频生成的分镜描述',
    prompt: '请示范如何将一场「暴雨夜旧巷对峙」的 30 秒短剧剧情拆解为 4 个分镜，并给出每个分镜的景别、动作和 AI 视频提示词。',
  },
  {
    title: '自由问答与头脑风暴',
    desc: '探讨代码、文案、策划或任何你想聊的话题',
    prompt: '你好！请介绍一下你能帮我做哪些事情，以及长对话达到上下文上限时你会如何处理？',
  },
]

const route = useRoute()
const router = useRouter()
const modelLabel = useModelLabel()
const { open: openSettings, revision: settingsRevision } = useSettingsPanel()

const sidebarOpen = ref(true)
const loadingList = ref(true)
const loadingSession = ref(false)
const modelsLoading = ref(true)
const sessions = ref<ChatSessionSummary[]>([])
const activeSession = ref<ChatSession | null>(null)
const availableModels = ref<ChatModelOption[]>([])
const defaultModelInfo = ref<{ configId?: number; model: string } | null>(null)
const selectedModel = ref<ChatModelSelection | null>(null)

const draftInput = ref('')
const draftFiles = ref<File[]>([])
const fileInput = ref<HTMLInputElement | null>(null)
const attachmentAccept = CHAT_ATTACHMENT_EXTENSIONS.map(extension => `.${extension}`).join(',')
const inputEl = ref<HTMLTextAreaElement | null>(null)
const inputFocused = ref(false)
const scrollContainer = ref<HTMLElement | null>(null)
const userScrolledUp = ref(false)

const streaming = ref(false)
const awaitingAcceptance = ref(false)
const streamingMessageId = ref<string | null>(null)
const streamingDraft = ref<ChatMessage | null>(null)
const liveStatus = ref('')
const livePhase = ref<'thinking' | 'compressing' | 'answering' | ''>('')
const compressing = ref(false)
const showSummary = ref(false)
const error = ref('')
const copiedId = ref('')

let abortController: AbortController | null = null
let alive = true

const hasAnyModel = computed(() => availableModels.value.length > 0 || Boolean(defaultModelInfo.value?.model))

const modelKey = (choice: ChatModelSelection) => `${choice.configId}/${choice.model}`

const selectedModelKey = computed(() => {
  const current = activeSession.value ? activeSession.value.model : selectedModel.value
  return current ? modelKey(current) : ''
})

const modelSelectOptions = computed(() => {
  const firstDefault = availableModels.value[0]
  const defaultName = defaultModelInfo.value?.model || firstDefault?.model
  const defaultProvider = firstDefault?.provider || 'openai'
  const items = availableModels.value.map(opt => ({
    value: modelKey(opt),
    label: `${modelLabel(opt.model)} · ${opt.configName}`,
    provider: opt.provider,
    rawModel: opt.model,
    disabled: false,
  }))
  const current = activeSession.value ? activeSession.value.model : selectedModel.value
  if (current && !items.some(item => item.value === modelKey(current))) {
    items.unshift({
      value: modelKey(current),
      label: `${modelLabel(current.model)}（已不可用）`,
      provider: 'openai',
      rawModel: current.model,
      disabled: true,
    })
  }
  return [
    {
      value: '',
      label: defaultName ? `默认（${modelLabel(defaultName)}）` : '跟随全局默认',
      provider: defaultProvider,
      rawModel: defaultName || '',
      disabled: false,
    },
    ...items,
  ]
})

const displayMessages = computed<ChatMessage[]>(() => {
  const base = activeSession.value?.messages ?? []
  if (streamingDraft.value) return [...base, streamingDraft.value]
  return base
})

const canSend = computed(() => !streaming.value && !loadingSession.value && !compressing.value && hasAnyModel.value &&
  Boolean(draftInput.value.trim() || draftFiles.value.length))

const canManualCompress = computed(() => {
  const s = activeSession.value
  if (!s) return false
  return s.messages.length >= 2 && s.compressedUntil < s.messages.length - 1
})

const contextUsageLabel = computed(() => {
  const s = activeSession.value
  if (!s?.lastInputTokens) return ''
  const used = s.lastInputTokens >= 1000 ? `${(s.lastInputTokens / 1000).toFixed(1)}k` : String(s.lastInputTokens)
  if (s.contextWindow) {
    const cap = s.contextWindow >= 1000 ? `${Math.round(s.contextWindow / 1000)}k` : String(s.contextWindow)
    return `${used} / ${cap} tokens`
  }
  return `~${used} tokens`
})

const contextTooltip = computed(() => {
  const s = activeSession.value
  if (!s?.lastInputTokens) return ''
  return s.contextWindow
    ? `当前上下文约 ${s.lastInputTokens} tokens，模型窗口 ${s.contextWindow} tokens；接近上限时将自动压缩。`
    : `当前上下文约 ${s.lastInputTokens} tokens；达到模型上下文上限时将自动压缩。`
})

function isStreamingMessage(msg: ChatMessage) {
  return Boolean(streaming.value && streamingMessageId.value && msg.id === streamingMessageId.value)
}

function upsertSessionSummary(session: ChatSession) {
  const summary: ChatSessionSummary = {
    id: session.id,
    title: session.title,
    model: session.model,
    compressedUntil: session.compressedUntil,
    messageCount: session.messages.length,
    lastInputTokens: session.lastInputTokens,
    contextWindow: session.contextWindow,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  }
  const idx = sessions.value.findIndex(item => item.id === session.id)
  if (idx >= 0) {
    const copy = [...sessions.value]
    copy.splice(idx, 1)
    sessions.value = [summary, ...copy]
  } else {
    sessions.value = [summary, ...sessions.value]
  }
}

async function loadModels() {
  modelsLoading.value = true
  try {
    const res = await aiChatAPI.models()
    if (!alive) return
    availableModels.value = res.models
    defaultModelInfo.value = res.defaultModel
  } catch {
    /* keep existing state */
  } finally {
    if (alive) modelsLoading.value = false
  }
}

async function loadSessions() {
  loadingList.value = true
  try {
    const list = await aiChatAPI.listSessions()
    if (!alive) return
    sessions.value = list
    const requestedId = typeof route.query.chat === 'string' ? route.query.chat : ''
    const target = list.find(item => item.id === requestedId) || list[0]
    if (target) await openSession(target.id)
  } catch (cause) {
    if (alive) error.value = (cause as Error).message || '加载对话列表失败'
  } finally {
    if (alive) loadingList.value = false
  }
}

async function openSession(id: string) {
  if (streaming.value) return
  if (activeSession.value?.id === id) {
    if (window.innerWidth <= 900) sidebarOpen.value = false
    return
  }
  loadingSession.value = true
  error.value = ''
  showSummary.value = false
  try {
    const session = await aiChatAPI.getSession(id)
    if (!alive) return
    draftFiles.value = []
    activeSession.value = session
    selectedModel.value = session.model
    await router.replace({ query: { ...route.query, chat: id } })
    if (window.innerWidth <= 900) sidebarOpen.value = false
    await nextTick()
    scrollToBottom(true)
  } catch (cause) {
    if (alive) error.value = (cause as Error).message || '读取对话失败'
  } finally {
    if (alive) loadingSession.value = false
  }
}

async function startNewChat() {
  if (streaming.value) return
  error.value = ''
  showSummary.value = false
  activeSession.value = null
  draftFiles.value = []
  const { chat: _removed, ...restQuery } = route.query
  await router.replace({ query: restQuery })
  if (window.innerWidth <= 900) sidebarOpen.value = false
  await nextTick()
  inputEl.value?.focus()
}

async function removeSession(id: string) {
  if (streaming.value && activeSession.value?.id === id) return
  try {
    await aiChatAPI.deleteSession(id)
    sessions.value = sessions.value.filter(item => item.id !== id)
    if (activeSession.value?.id === id) {
      activeSession.value = null
      draftFiles.value = []
      const next = sessions.value[0]
      if (next) await openSession(next.id)
      else {
        const { chat: _removed, ...restQuery } = route.query
        await router.replace({ query: restQuery })
      }
    }
  } catch (cause) {
    error.value = (cause as Error).message || '删除对话失败'
  }
}

async function onSelectModel(value: string | number) {
  const option = availableModels.value.find(item => modelKey(item) === value)
  const nextSelection: ChatModelSelection | null = option ? { configId: option.configId, model: option.model } : null
  selectedModel.value = nextSelection
  if (!activeSession.value) return
  try {
    const updated = await aiChatAPI.updateSession(activeSession.value.id, { model: nextSelection })
    if (!alive) return
    activeSession.value = updated
    upsertSessionSummary(updated)
  } catch (cause) {
    error.value = (cause as Error).message || '切换模型失败'
  }
}

async function manualCompress() {
  if (!activeSession.value || streaming.value || compressing.value) return
  compressing.value = true
  error.value = ''
  try {
    const res = await aiChatAPI.compressSession(activeSession.value.id)
    if (!alive) return
    activeSession.value = res.session
    upsertSessionSummary(res.session)
    showSummary.value = true
  } catch (cause) {
    if (alive) error.value = (cause as Error).message || '压缩上下文失败'
  } finally {
    if (alive) compressing.value = false
  }
}

function handleScroll() {
  const el = scrollContainer.value
  if (!el) return
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
  userScrolledUp.value = distanceFromBottom > 80
}

function scrollToBottom(force = false) {
  const el = scrollContainer.value
  if (!el) return
  if (!force && userScrolledUp.value) return
  el.scrollTop = el.scrollHeight
  if (force) userScrolledUp.value = false
}

function autoResizeInput() {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    if (canSend.value) void sendMessage()
  }
}

function fileKey(file: File) {
  return `${file.name}/${file.size}/${file.lastModified}`
}

function formatFileSize(size: number) {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  if (size >= 1024) return `${Math.ceil(size / 1024)} KB`
  return `${size} B`
}

function onChooseFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length || streaming.value || loadingSession.value) return

  const next = [...draftFiles.value]
  const issues: string[] = []
  let size = next.reduce((total, file) => total + file.size, 0)
  for (const file of files) {
    if (next.some(item => fileKey(item) === fileKey(file))) continue
    if (next.length >= CHAT_ATTACHMENT_COUNT_LIMIT) {
      issues.push('每条消息最多上传 5 个文件。')
      break
    }
    if (!CHAT_ATTACHMENT_EXTENSIONS.includes(chatAttachmentExtension(file.name))) {
      issues.push(`不支持文件「${file.name}」。请选择 TXT、MD、CSV、TSV、JSON、SRT、VTT、DOCX 或 PDF。`)
    } else if (!file.size || file.size > CHAT_ATTACHMENT_FILE_BYTES) {
      issues.push(`「${file.name}」为空或超过 10 MB。`)
    } else if (size + file.size > CHAT_ATTACHMENT_TOTAL_BYTES) {
      const message = '每条消息的附件合计不能超过 20 MB。'
      if (!issues.includes(message)) issues.push(message)
    } else {
      size += file.size
      next.push(file)
    }
  }
  draftFiles.value = next
  error.value = issues.join(' ')
}

function useStarter(prompt: string) {
  draftInput.value = prompt
  nextTick(() => {
    autoResizeInput()
    void sendMessage()
  })
}

async function sendMessage(regenerate = false) {
  if (streaming.value || loadingSession.value || compressing.value || !hasAnyModel.value) return
  const content = regenerate ? undefined : draftInput.value.trim()
  const files = regenerate ? [] : [...draftFiles.value]
  if (!regenerate && !content && !files.length) return

  error.value = ''
  streaming.value = true
  awaitingAcceptance.value = !regenerate
  abortController = new AbortController()
  try {
    let session = activeSession.value
    if (!session) {
      session = await aiChatAPI.createSession({ model: selectedModel.value })
      if (!alive) return
      activeSession.value = session
      upsertSessionSummary(session)
      await router.replace({ query: { ...route.query, chat: session.id } })
    }
    abortController.signal.throwIfAborted()
    const tempId = `streaming-${Date.now()}`
    streamingMessageId.value = tempId
    streamingDraft.value = {
      id: tempId,
      role: 'assistant',
      content: '',
      reasoning: '',
      model: session.model?.model || defaultModelInfo.value?.model,
      createdAt: new Date().toISOString(),
    }
    livePhase.value = 'thinking'
    liveStatus.value = files.length ? '正在上传并读取附件…' : '正在连接模型…'
    userScrolledUp.value = false
    await nextTick()
    scrollToBottom(true)

    await aiChatAPI.streamMessage(
      session.id,
      { content, regenerate, model: selectedModel.value },
      {
        signal: abortController.signal,
        onEvent(eventName, data) {
          if (!alive) return
          if (eventName === 'session' && data?.session) {
            if (awaitingAcceptance.value) {
              draftInput.value = ''
              draftFiles.value = []
              awaitingAcceptance.value = false
              void nextTick(autoResizeInput)
            }
            activeSession.value = data.session
            upsertSessionSummary(data.session)
            void nextTick(() => scrollToBottom())
          } else if (eventName === 'status') {
            livePhase.value = data?.phase || 'answering'
            liveStatus.value = data?.message || ''
            void nextTick(() => scrollToBottom())
          } else if (eventName === 'compressed') {
            if (activeSession.value) {
              activeSession.value = {
                ...activeSession.value,
                summary: data.summary,
                compressedUntil: data.compressedUntil,
              }
              upsertSessionSummary(activeSession.value)
            }
            livePhase.value = 'answering'
            liveStatus.value = data?.message || '上下文已自动压缩，正在继续回答…'
            void nextTick(() => scrollToBottom())
          } else if (eventName === 'reasoning' && data?.delta && streamingDraft.value) {
            liveStatus.value = ''
            streamingDraft.value = {
              ...streamingDraft.value,
              reasoning: (streamingDraft.value.reasoning || '') + data.delta,
            }
            void nextTick(() => scrollToBottom())
          } else if (eventName === 'delta' && data?.delta && streamingDraft.value) {
            liveStatus.value = ''
            streamingDraft.value = {
              ...streamingDraft.value,
              content: streamingDraft.value.content + data.delta,
            }
            void nextTick(() => scrollToBottom())
          } else if (eventName === 'done' && data?.session) {
            streamingDraft.value = null
            activeSession.value = data.session
            upsertSessionSummary(data.session)
            liveStatus.value = ''
            livePhase.value = ''
            void nextTick(() => scrollToBottom())
          } else if (eventName === 'error') {
            if (data?.session) {
              streamingDraft.value = null
              activeSession.value = data.session
              upsertSessionSummary(data.session)
            } else {
              error.value = data?.message || '模型回复失败'
            }
            liveStatus.value = ''
            livePhase.value = ''
          }
        },
      },
      files,
    )
  } catch (cause: any) {
    if (cause?.name !== 'AbortError') {
      error.value = cause?.message || '发送消息失败'
    } else if (activeSession.value && streamingDraft.value?.content) {
      // Refresh saved partial state from server if aborted
      try {
        const refreshed = await aiChatAPI.getSession(activeSession.value.id)
        if (alive) {
          activeSession.value = refreshed
          upsertSessionSummary(refreshed)
        }
      } catch { /* ignore */ }
    }
  } finally {
    abortController = null
    if (alive) {
      streaming.value = false
      awaitingAcceptance.value = false
      streamingMessageId.value = null
      streamingDraft.value = null
      liveStatus.value = ''
      livePhase.value = ''
      await nextTick()
      inputEl.value?.focus()
    }
  }
}

function stopGeneration() {
  abortController?.abort()
}

function regenerateLast() {
  if (streaming.value) return
  void sendMessage(true)
}

async function copyText(id: string, text: string) {
  try {
    await navigator.clipboard.writeText(text)
    copiedId.value = id
    setTimeout(() => {
      if (copiedId.value === id) copiedId.value = ''
    }, 1800)
  } catch { /* clipboard unavailable */ }
}

onMounted(() => {
  if (window.innerWidth <= 900) sidebarOpen.value = false
  void loadModels()
  void loadSessions()
})

watch(settingsRevision, () => {
  void loadModels()
})

onBeforeUnmount(() => {
  alive = false
  abortController?.abort()
})
</script>

<style>
.ai-chat-shell {
  display: grid;
  grid-template-columns: 270px minmax(0, 1fr);
  flex: 1;
  min-height: 0;
  height: 100%;
  width: 100%;
  overflow: hidden;
  position: relative;
  color: var(--text-1);
}
.ai-chat-shell.sidebar-collapsed {
  grid-template-columns: 0 minmax(0, 1fr);
}
.chat-sidebar-backdrop {
  display: none;
}

.chat-sidebar {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border-right: 1px solid var(--surface-outline);
  background: var(--surface-raised);
  transition: opacity .2s;
}
.ai-chat-shell.sidebar-collapsed .chat-sidebar {
  border-right: 0;
  opacity: 0;
  pointer-events: none;
}
.chat-sidebar-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 12px 10px;
  border-bottom: 1px solid var(--surface-outline);
}
.chat-new-btn {
  flex: 1;
  justify-content: center;
  height: 36px;
}
.chat-sidebar-close {
  display: none;
}

.chat-session-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.chat-sidebar-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 28px 12px;
  text-align: center;
  color: var(--text-3);
  font-size: 12.5px;
}
.chat-session-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 9px 10px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: var(--text-2);
  text-align: left;
  cursor: pointer;
  transition: background .15s, border-color .15s, color .15s;
}
.chat-session-item:hover {
  background: var(--surface-muted);
  color: var(--text-0);
}
.chat-session-item.active {
  background: var(--accent-bg);
  border-color: var(--surface-outline-strong);
  color: var(--accent-text);
}
.chat-session-icon {
  flex-shrink: 0;
  opacity: .75;
}
.chat-session-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.chat-session-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 560;
}
.chat-session-sub {
  font-size: 11px;
  color: var(--text-3);
}
.chat-session-delete {
  opacity: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  color: var(--text-3);
  transition: opacity .15s, background .15s, color .15s;
}
.chat-session-item:hover .chat-session-delete,
.chat-session-item.active .chat-session-delete {
  opacity: .8;
}
.chat-session-delete:hover {
  opacity: 1 !important;
  background: var(--action-danger-bg, rgba(220, 60, 60, .14));
  color: var(--action-danger, #e06c75);
}

.chat-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  position: relative;
}

.chat-topbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px clamp(16px, 3vw, 32px);
  border-bottom: 1px solid var(--surface-outline);
  background: var(--surface-raised);
}
.chat-topbar-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.chat-title-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.chat-title-wrap h1 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
  color: var(--text-0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat-context-pill {
  flex-shrink: 0;
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid var(--surface-outline);
  background: var(--surface-muted);
  color: var(--text-3);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.chat-topbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  flex-wrap: wrap;
}
.chat-summary-toggle {
  border-color: var(--surface-outline-strong);
  background: var(--accent-bg);
  color: var(--accent-text);
}

.chat-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--surface-outline);
  border-radius: 8px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
  flex-shrink: 0;
  transition: background .15s, color .15s;
}
.chat-icon-btn:hover {
  background: var(--surface-muted);
  color: var(--text-0);
}

.chat-summary-drawer {
  flex-shrink: 0;
  margin: 10px clamp(16px, 3vw, 32px) 0;
  border: 1px solid var(--surface-outline-strong);
  border-radius: 12px;
  background: var(--surface-raised);
  overflow: hidden;
}
.chat-summary-drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--accent-bg);
  color: var(--accent-text);
  font-size: 12px;
  font-weight: 600;
}
.chat-summary-drawer-head span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.chat-summary-drawer-body {
  max-height: 180px;
  overflow-y: auto;
  padding: 10px 14px;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--text-2);
  white-space: pre-wrap;
}

.chat-error-banner {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px clamp(16px, 3vw, 32px) 0;
  padding: 9px 12px;
  border-radius: 10px;
  border: 1px solid var(--surface-outline);
  background: var(--error-bg, rgba(220, 60, 60, .12));
  color: var(--error, #e06c75);
  font-size: 13px;
}
.chat-error-banner span {
  flex: 1;
}

.chat-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px clamp(16px, 4vw, 48px) 24px;
  position: relative;
}

.chat-empty-state {
  max-width: 720px;
  margin: clamp(24px, 8vh, 80px) auto 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 12px;
}
.chat-welcome-mark {
  width: 54px;
  height: 54px;
  border-radius: 16px;
  display: grid;
  place-items: center;
  border: 1px solid var(--surface-outline-strong);
  background: var(--accent-bg);
  color: var(--accent-text);
}
.chat-empty-state h2 {
  margin: 4px 0 0;
  font-size: 22px;
  color: var(--text-0);
}
.chat-empty-state p {
  margin: 0;
  max-width: 520px;
  color: var(--text-2);
  font-size: 13.5px;
  line-height: 1.65;
}
.chat-starter-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  width: 100%;
  margin-top: 14px;
}
.chat-starter-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 13px 15px;
  border: 1px solid var(--surface-outline);
  border-radius: 13px;
  background: var(--surface-raised);
  color: var(--text-1);
  text-align: left;
  cursor: pointer;
  transition: border-color .18s, background .18s, transform .18s;
}
.chat-starter-card:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--accent-bg);
  transform: translateY(-1px);
}
.chat-starter-card:disabled {
  opacity: .55;
  cursor: default;
}
.chat-starter-card strong {
  font-size: 13.5px;
  color: var(--text-0);
}
.chat-starter-card span {
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.45;
}

.chat-thread {
  max-width: 860px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.chat-compression-divider {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 7px 14px;
  margin: 4px 0;
  border-radius: 999px;
  border: 1px dashed var(--surface-outline-strong);
  background: var(--surface-muted);
  color: var(--text-2);
  font-size: 12px;
}
.chat-compression-divider button {
  border: 0;
  background: transparent;
  color: var(--accent-text);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
}

.chat-message {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.chat-message.role-user {
  justify-content: flex-end;
}
.chat-message.role-user .chat-bubble-wrap {
  align-items: flex-end;
  max-width: min(82%, 680px);
}
.chat-message.role-assistant .chat-bubble-wrap {
  flex: 1;
  min-width: 0;
}
.chat-avatar {
  width: 32px;
  height: 32px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  border: 1px solid var(--surface-outline-strong);
  background: var(--accent-bg);
  color: var(--accent-text);
}
.chat-bubble-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.chat-msg-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
}
.chat-msg-author {
  font-weight: 650;
  color: var(--text-0);
}
.chat-msg-model {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--surface-muted);
  border: 1px solid var(--surface-outline);
  color: var(--text-3);
  font-size: 11px;
}
.chat-msg-compressed {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--accent-bg);
  color: var(--accent-text);
  font-size: 11px;
}

.chat-user-bubble {
  padding: 10px 15px;
  border-radius: 15px 15px 4px 15px;
  border: 1px solid var(--surface-outline-strong);
  background: var(--accent-bg);
  color: var(--text-0);
  font-size: 14px;
  line-height: 1.65;
}
.chat-user-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.chat-user-bubble .chat-file-list + .chat-user-text {
  margin-top: 8px;
}

.chat-file-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.chat-file-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 100%;
  min-width: 0;
  padding: 4px 8px;
  border: 1px solid var(--surface-outline);
  border-radius: 8px;
  background: var(--surface-muted);
  font-size: 12px;
}
.chat-file-chip svg,
.chat-file-size {
  flex-shrink: 0;
  color: var(--text-3);
}
.chat-file-name {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.chat-file-chip .chat-file-remove {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border: 0;
}

.chat-reasoning {
  border: 1px solid var(--surface-outline);
  border-radius: 10px;
  background: var(--surface-muted);
  padding: 7px 11px;
  font-size: 12.5px;
}
.chat-reasoning summary {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  color: var(--text-2);
  font-weight: 600;
  user-select: none;
}
.chat-reasoning-body {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--surface-outline);
  color: var(--text-3);
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.chat-live-status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 6px 11px;
  border-radius: 9px;
  background: var(--surface-muted);
  border: 1px solid var(--surface-outline);
  color: var(--text-2);
  font-size: 12.5px;
  width: fit-content;
}
.chat-live-status.compressing {
  background: var(--accent-bg);
  border-color: var(--surface-outline-strong);
  color: var(--accent-text);
}

.chat-assistant-body {
  color: var(--text-1);
  font-size: 14px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.chat-msg-error {
  margin: 8px 0 0;
  color: var(--error, #e06c75);
  font-size: 12.5px;
}

.chat-typing-dots {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 8px 2px;
}
.chat-typing-dots i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: chat-pulse 1.2s infinite ease-in-out;
}
.chat-typing-dots i:nth-child(2) { animation-delay: .18s; }
.chat-typing-dots i:nth-child(3) { animation-delay: .36s; }
@keyframes chat-pulse {
  0%, 80%, 100% { opacity: .28; transform: scale(.82); }
  40% { opacity: 1; transform: scale(1); }
}

.chat-msg-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  opacity: 0;
  transition: opacity .15s;
}
.chat-message:hover .chat-msg-actions,
.chat-message:focus-within .chat-msg-actions {
  opacity: 1;
}
.chat-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid var(--surface-outline);
  border-radius: 6px;
  background: var(--surface-raised);
  color: var(--text-3);
  font-size: 11.5px;
  cursor: pointer;
}
.chat-action-btn:hover:not(:disabled) {
  color: var(--text-0);
  border-color: var(--surface-outline-strong);
}

/* Markdown Typography */
.chat-markdown :first-child { margin-top: 0; }
.chat-markdown :last-child { margin-bottom: 0; }
.chat-markdown p { margin: 0 0 10px; }
.chat-markdown h1,
.chat-markdown h2,
.chat-markdown h3,
.chat-markdown h4 {
  margin: 14px 0 8px;
  color: var(--text-0);
  line-height: 1.35;
}
.chat-markdown h1 { font-size: 18px; }
.chat-markdown h2 { font-size: 16px; }
.chat-markdown h3 { font-size: 14.5px; }
.chat-markdown ul,
.chat-markdown ol {
  margin: 6px 0 10px;
  padding-left: 20px;
}
.chat-markdown li { margin: 3px 0; }
.chat-markdown blockquote {
  margin: 8px 0;
  padding: 6px 12px;
  border-left: 3px solid var(--accent);
  background: var(--surface-muted);
  border-radius: 0 8px 8px 0;
  color: var(--text-2);
}
.chat-markdown hr {
  border: 0;
  border-top: 1px solid var(--surface-outline);
  margin: 12px 0;
}
.chat-markdown a {
  color: var(--accent-text);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.chat-markdown .chat-inline-code {
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--surface-muted);
  border: 1px solid var(--surface-outline);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12.5px;
}
.chat-markdown .chat-code-block {
  margin: 10px 0;
  border: 1px solid var(--surface-outline);
  border-radius: 10px;
  background: var(--surface-input);
  overflow: hidden;
}
.chat-markdown .chat-code-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 12px;
  border-bottom: 1px solid var(--surface-outline);
  background: var(--surface-muted);
}
.chat-markdown .chat-code-lang {
  font-size: 11px;
  color: var(--text-3);
  text-transform: lowercase;
}
.chat-markdown .chat-code-block pre {
  margin: 0;
  padding: 11px 13px;
  overflow-x: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.55;
}
.chat-markdown .chat-table-wrap {
  overflow-x: auto;
  margin: 10px 0;
}
.chat-markdown table {
  border-collapse: collapse;
  width: 100%;
  font-size: 13px;
}
.chat-markdown th,
.chat-markdown td {
  border: 1px solid var(--surface-outline);
  padding: 6px 10px;
  text-align: left;
}
.chat-markdown th {
  background: var(--surface-muted);
  color: var(--text-0);
}

.chat-scroll-bottom {
  position: sticky;
  bottom: 10px;
  left: 50%;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 13px;
  border: 1px solid var(--surface-outline-strong);
  border-radius: 999px;
  background: var(--surface-raised);
  color: var(--text-0);
  font-size: 12px;
  cursor: pointer;
  box-shadow: var(--shadow-sm);
}

/* Composer */
.chat-composer-wrap {
  flex-shrink: 0;
  padding: 10px clamp(16px, 4vw, 48px) 18px;
}
.chat-no-model-notice {
  max-width: 860px;
  margin: 0 auto 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid var(--warn-border, var(--surface-outline));
  background: var(--warn-bg, var(--surface-raised));
  color: var(--warn-text, var(--text-2));
  font-size: 12.5px;
}
.chat-no-model-notice .btn {
  margin-left: auto;
}
.chat-composer {
  max-width: 860px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px 10px;
  border: 1px solid var(--surface-outline-strong);
  border-radius: 16px;
  background: var(--surface-raised);
  transition: border-color .18s, box-shadow .18s;
}
.chat-composer.focused {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--button-focus);
}
.chat-composer textarea {
  width: 100%;
  min-height: 26px;
  max-height: 200px;
  border: 0;
  outline: none;
  resize: none;
  background: transparent;
  color: var(--text-0);
  font: inherit;
  font-size: 14px;
  line-height: 1.6;
}
.chat-composer textarea::placeholder {
  color: var(--text-3);
}
.chat-composer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.chat-composer-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 0 1 420px;
}
.chat-attach-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 9px;
  white-space: nowrap;
}
.chat-model-picker {
  flex: 1;
  min-width: 0;
}
.chat-model-option {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.chat-model-icon {
  width: 14px;
  height: 14px;
  object-fit: contain;
  border-radius: 3px;
  flex-shrink: 0;
}
.chat-model-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat-composer-right {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}
.chat-char-count {
  font-size: 11.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.chat-send-btn,
.chat-stop-btn {
  height: 34px;
  padding: 0 14px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.chat-spin {
  animation: chat-spin 1s linear infinite;
  flex-shrink: 0;
}
@keyframes chat-spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 900px) {
  .ai-chat-shell,
  .ai-chat-shell.sidebar-collapsed {
    grid-template-columns: minmax(0, 1fr);
  }
  .chat-sidebar-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 44;
    background: rgb(0 0 0 / 48%);
  }
  .chat-sidebar {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: min(290px, 84vw);
    z-index: 45;
    transform: translateX(-100%);
    visibility: hidden;
    transition: transform .2s ease, visibility .2s;
  }
  .chat-sidebar.open {
    transform: translateX(0);
    visibility: visible;
    opacity: 1;
    pointer-events: auto;
  }
  .chat-sidebar-close {
    display: inline-flex;
  }
  .chat-starter-grid {
    grid-template-columns: 1fr;
  }
  .chat-msg-actions {
    opacity: 1;
  }
}
@media (max-width: 650px) {
  .chat-topbar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; padding: 6px 12px; }
  .chat-topbar-left { min-width: 0; }
  .chat-topbar-actions { gap: 6px; }
  .chat-topbar-actions:has(> :nth-child(2)) { grid-column: 1 / -1; justify-content: flex-start; flex-wrap: wrap; }
  .chat-title-wrap h1 { font-size: 13px; }
  .chat-icon-btn { width: 32px; height: 32px; }
  html:root body :is(.chat-topbar-actions .btn, .chat-new-btn) {
    min-height: 32px;
    padding-inline: 8px;
    font-size: 11px;
  }
  .chat-session-list { overscroll-behavior: contain; }
  .chat-session-delete { width: 36px; height: 36px; flex: none; opacity: .8; }
  .chat-summary-drawer, .chat-error-banner { margin: 8px 12px 0; }
  .chat-summary-drawer-head > span svg, .chat-error-banner > svg { flex: none; }
  .chat-summary-drawer-body { max-height: min(20dvh, 180px); overflow-wrap: anywhere; }
  .chat-error-banner span { min-width: 0; overflow-wrap: anywhere; }
  .chat-messages { padding: 12px 12px 16px; }
  .chat-empty-state { margin-top: clamp(6px, 1.8dvh, 16px); gap: 6px; }
  .chat-empty-state h2 { margin-top: 2px; font-size: clamp(16px, 4.7vw, 19px); }
  .chat-empty-state p { max-width: 34ch; font-size: 12px; line-height: 1.6; }
  .chat-welcome-mark { width: 34px; height: 34px; border-radius: 12px; }
  .chat-welcome-mark svg { width: 19px; height: 19px; }
  .chat-starter-grid { margin-top: 6px; gap: 10px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .chat-starter-card { gap: 4px; min-width: 0; padding: 9px 10px; border-radius: 10px; }
  .chat-starter-card strong { font-size: 12.5px; }
  .chat-starter-card span { font-size: 11.5px; line-height: 1.45; }
  .chat-thread { gap: 14px; }
  .chat-message { gap: 7px; }
  .chat-avatar { width: 26px; height: 26px; }
  .chat-msg-model { max-width: 100%; overflow-wrap: anywhere; }
  .chat-user-bubble { max-width: 100%; padding: 8px 10px; }
  .chat-markdown :is(.chat-code-block pre, .chat-table-wrap) { overscroll-behavior-inline: contain; }
  .chat-compression-divider { flex-wrap: wrap; gap: 4px 8px; }
  .chat-action-btn { min-height: 32px; }
  .chat-composer-wrap { padding: 6px 12px max(10px, env(safe-area-inset-bottom)); }
  .chat-no-model-notice { padding: 4px 8px; font-size: 12px; }
  .chat-no-model-notice > :is(svg, .btn) { flex: none; }
  .chat-composer { padding: 7px 8px; gap: 5px; border-radius: 13px; }
  .chat-composer > .chat-file-list { max-height: 72px; overflow-y: auto; }
  .chat-file-chip .chat-file-remove { width: 34px; height: 34px; }
  .chat-composer textarea { font-size: 16px; max-height: min(20dvh, 200px); }
  .chat-composer textarea::placeholder { font-size: 13px; }
  .chat-composer-bar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; }
  .chat-composer-tools, .chat-composer-right { gap: 6px; }
  html:root body :is(.chat-composer-tools .chat-attach-btn, .chat-composer-right .btn) {
    min-height: 32px;
    padding-inline: 8px;
    font-size: 12px;
    white-space: nowrap;
  }
  .chat-model-picker :deep(.base-select-trigger) { min-height: 32px; }
}
@media (max-width: 480px) {
  .chat-topbar-left { gap: 8px; }
  .chat-title-wrap { flex-wrap: wrap; gap: 1px 6px; }
  .chat-title-wrap h1 { max-width: 100%; }
  .chat-composer textarea { min-height: 1.8em; }
  html:root body .chat-composer-tools .chat-attach-btn { width: 36px; min-width: 36px; padding: 0; justify-content: center; }
  .chat-attach-btn span { display: none; }
}
@media (max-width: 350px) {
  .chat-starter-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 900px) and (max-height: 500px) {
  .chat-empty-state { margin-top: 6px; }
  .chat-topbar { padding-block: 4px; }
  .chat-composer-wrap { padding-block: 4px; }
  .chat-composer textarea { min-height: 26px; max-height: 72px; }
}
@media (max-width: 900px) and (prefers-reduced-motion: reduce) {
  .chat-sidebar { transition: none; }
}
</style>
