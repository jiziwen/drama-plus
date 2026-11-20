<template>
  <div class="mention-textarea" :class="{ 'mention-hover-preview': previewOnHover }">
    <!-- 高亮镜像层：渲染与 textarea 完全相同的文本，@引用 着彩色；textarea 文字透明、仅显示光标 -->
    <div ref="backdropEl" :class="[inputClass, 'mention-backdrop']" aria-hidden="true">
      <div class="mention-backdrop-content" v-html="highlightedHtml"></div>
    </div>
    <textarea
      ref="taEl"
      :class="[inputClass, 'mention-input']"
      :rows="rows"
      :placeholder="placeholder"
      :value="text"
      :aria-description="hasAudioPreviews ? '在参考音频标记内按 Alt + Enter 打开试听。' : undefined"
      :aria-keyshortcuts="searchable && mention.open ? 'Alt+ArrowDown' : undefined"
      @input="onInput"
      @compositionstart="onCompositionStart"
      @compositionend="onCompositionEnd"
      @keydown="onKeydown"
      @focus="emit('focus')"
      @blur="onBlur"
      @click="closeMention"
      @scroll="onScroll"
      @mousemove="onPreviewMove"
      @mouseleave="leavePreview"
      @pointerup="onTouchPreview"
    />
    <Teleport to="body">
      <div
        v-if="preview.option"
        ref="previewEl"
        :role="preview.option.audioUrl ? 'group' : 'tooltip'"
        class="mention-preview"
        :class="{ 'mention-preview-audio': preview.option.audioUrl }"
        :style="previewStyle"
        @mouseenter="enterPreview"
        @mouseleave="leavePreview"
      >
        <div v-if="!preview.option.audioUrl" class="mention-preview-image">
          <img v-if="preview.option.image && !previewImageFailed" :src="preview.option.image" :alt="preview.option.label || preview.option.value" decoding="async" @error="previewImageFailed = true" />
          <component v-else :is="groupIcon(preview.option.kind)" :size="28" :stroke-width="1.5" />
        </div>
        <strong>@{{ preview.option.label || preview.option.value }}</strong>
        <span>{{ preview.option.group }}</span>
        <audio
          v-if="preview.option.audioUrl"
          ref="audioEl"
          :key="preview.option.audioUrl"
          :src="preview.option.audioUrl"
          :aria-label="`试听 ${preview.option.group || preview.option.label}`"
          controls
          preload="none"
          @play="activateScriptVideoAudio"
          @pause="deactivateScriptVideoAudio"
          @ended="deactivateScriptVideoAudio"
        />
      </div>
      <div v-if="mention.open" ref="dropdownEl" class="mention-dropdown" :style="mentionStyle" @focusout="onDropdownFocusOut">
        <div v-if="searchable" ref="searchRowEl" class="mention-search">
          <input
            ref="searchEl"
            v-model="searchQuery"
            type="search"
            :placeholder="t('components.mention.searchAssets')"
            :aria-label="t('components.mention.searchAssets')"
            autocomplete="off"
            @keydown="onMentionKeydown"
          />
        </div>
        <template v-if="groupedFiltered.length">
          <template v-for="(group, gi) in groupedFiltered" :key="group.group">
            <div class="mention-group-label">{{ group.group }}</div>
            <button
              v-for="(opt, oi) in group.options"
              :key="group.group + '-' + opt.value"
              type="button"
              tabindex="-1"
              :class="['mention-option', { highlighted: flatIndex(gi, oi) === highlightIdx }]"
              @mousedown.prevent
              @click="pick(opt)"
              @mousemove="highlightIdx = flatIndex(gi, oi)"
            >
              <span :class="['mention-avatar', `mention-avatar-${opt.kind === 'scene' ? 'scene' : (opt.kind === 'prop' ? 'prop' : 'role')}`]">
                <img v-if="opt.image" :src="opt.image" alt="" loading="lazy" decoding="async" @error="$event.target.style.display = 'none'" />
                <component v-else :is="groupIcon(opt.kind)" :size="12" :stroke-width="2" />
              </span>
              <span class="mention-name">@{{ opt.label }}</span>
              <span class="mention-type">{{ opt.group }}</span>
            </button>
          </template>
        </template>
        <div v-else class="mention-empty">{{ t('components.mention.noMatch') }}</div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { User, MapPin, Package, Headphones } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { activateScriptVideoAudio, deactivateScriptVideoAudio, useScriptVideoAudioPreview } from '~/composables/useScriptVideoAudioPreview'

const { t } = useI18n()

// 无图资产在下拉中显示分组图标兜底（场景=定位、道具=包裹、角色=人物）——按 kind code 判断，不依赖显示文案
const groupIcon = (kind) => (kind === 'scene' ? MapPin : kind === 'prop' ? Package : kind === 'audio' ? Headphones : User)

const props = defineProps({
  modelValue: { type: String, default: '' },
  // value 为插入的 @引用名；image 和 audioUrl 用于悬停预览。
  options: { type: Array, default: () => [] },
  rows: { type: [Number, String], default: 4 },
  placeholder: { type: String, default: '' },
  inputClass: { type: String, default: '' },
  searchable: { type: Boolean, default: false },
  previewOnHover: { type: Boolean, default: false },
  // Script-to-video also highlights literal names within spoken lines, without
  // inserting reference syntax into the actor's words or moving the caret.
  resolvePreviewRanges: { type: Function, default: null },
})
const emit = defineEmits(['update:modelValue', 'commit', 'focus'])

const taEl = ref(null)
const backdropEl = ref(null)
const text = ref(props.modelValue)
let lastEmittedText = props.modelValue
let hasComposingInput = false
let commitAfterComposition = false
const mention = ref({ open: false, start: 0, end: 0, query: '', top: 0, left: 0 })
const highlightIdx = ref(0)
const dropdownEl = ref(null)
const searchEl = ref(null)
const searchRowEl = ref(null)
const searchInput = ref(null)
const searchQuery = computed({
  get: () => searchInput.value ?? mention.value.query,
  set(query) {
    searchInput.value = query
    resetMentionSelection()
  },
})
const previewEl = ref(null)
const preview = ref({ option: null, left: 0, top: 0 })
const previewImageFailed = ref(false)
const hasAudioPreviews = computed(() => props.previewOnHover && props.options.some(option => option.audioUrl))
const { player: audioEl, scheduleAudioPreview, cancelAudioStart, stopAudioPreview } = useScriptVideoAudioPreview()
let previewDismissal
let pointerInPreview = false
const PREVIEW_WIDTH = 216
const PREVIEW_HEIGHT = 240
const AUDIO_PREVIEW_WIDTH = 280
const AUDIO_PREVIEW_HEIGHT = 96
const PREVIEW_GAP = 10
const PREVIEW_MARGIN = 8
const previewStyle = computed(() => ({
  left: `${preview.value.left}px`,
  top: `${preview.value.top}px`,
}))

function cancelPreviewDismissal() {
  clearTimeout(previewDismissal)
  previewDismissal = undefined
}

function enterPreview() {
  pointerInPreview = true
  cancelPreviewDismissal()
}

function leavePreview() {
  pointerInPreview = false
  if (!preview.value.option?.audioUrl) closePreview()
  else {
    cancelAudioStart()
    if (previewDismissal === undefined) previewDismissal = setTimeout(closePreview, 180)
  }
}

function closePreview() {
  cancelPreviewDismissal()
  stopAudioPreview()
  pointerInPreview = false
  if (preview.value.option) preview.value = { option: null, left: 0, top: 0 }
}

// The textarea stays above the noninteractive mirror, so editing and selection
// keep their native behavior. Hit-test the exact rendered token rectangles.
function onPreviewMove(event, autoplay = true) {
  if (!props.previewOnHover || mention.value.open || event.buttons) {
    closePreview()
    return
  }
  const ta = taEl.value
  const backdrop = backdropEl.value
  if (!ta || !backdrop) return
  const { clientX: x, clientY: y } = event
  const clip = ta.getBoundingClientRect()
  if (x < clip.left || x >= clip.right || y < clip.top || y >= clip.bottom) {
    leavePreview()
    return
  }
  for (const token of backdrop.querySelectorAll('[data-mention-index]')) {
    for (const rect of token.getClientRects()) {
      if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) continue
      const option = props.options[Number(token.dataset.mentionIndex)]
      if (!option || !autoplay && !option.audioUrl) continue
      showPreviewOption(option, rect, clip, autoplay)
      return
    }
  }
  leavePreview()
}

function showPreviewOption(option, rect, clip, autoplay) {
  cancelPreviewDismissal()
  if (preview.value.option !== option) {
    previewImageFailed.value = false
    if (autoplay && option.audioUrl) scheduleAudioPreview()
    else stopAudioPreview()
  }
  const height = Math.min(option.audioUrl ? AUDIO_PREVIEW_HEIGHT : PREVIEW_HEIGHT, window.innerHeight - PREVIEW_MARGIN * 2)
  const width = Math.min(option.audioUrl ? AUDIO_PREVIEW_WIDTH : PREVIEW_WIDTH, window.innerWidth - PREVIEW_MARGIN * 2)
  const below = Math.min(rect.bottom, clip.bottom) + PREVIEW_GAP
  const top = below + height <= window.innerHeight - PREVIEW_MARGIN ? below : rect.top - PREVIEW_GAP - height
  preview.value = {
    option,
    left: Math.max(PREVIEW_MARGIN, Math.min(rect.left, window.innerWidth - width - PREVIEW_MARGIN)),
    top: Math.max(PREVIEW_MARGIN, Math.min(top, window.innerHeight - height - PREVIEW_MARGIN)),
  }
}

function onTouchPreview(event) {
  if (event.pointerType === 'touch') onPreviewMove(event, false)
}

function previewAudioAtCaret() {
  const ta = taEl.value
  const content = backdropEl.value?.querySelector('.mention-backdrop-content')
  if (!hasAudioPreviews.value || !ta || !content || mention.value.open || ta.selectionStart !== ta.selectionEnd) return false
  // Both the native field and the mirror normalize the saved prompt's line breaks.
  const range = document.createRange()
  range.setStart(content, 0)
  const clip = ta.getBoundingClientRect()
  for (const token of content.querySelectorAll('[data-mention-index]')) {
    const option = props.options[Number(token.dataset.mentionIndex)]
    if (!option?.audioUrl) continue
    range.setEndBefore(token)
    const start = range.toString().length
    if (ta.selectionStart < start || ta.selectionStart > start + token.textContent.length) continue
    const rect = Array.from(token.getClientRects()).find(rect => rect.bottom > clip.top && rect.top < clip.bottom)
      ?? { left: clip.left, top: clip.top, bottom: clip.top }
    cancelAudioStart()
    showPreviewOption(option, rect, clip, false)
    void nextTick(() => audioEl.value?.focus({ preventScroll: true }))
    return true
  }
  return false
}

function highlightOption(index) {
  highlightIdx.value = index
  nextTick(() => {
    const dropdown = dropdownEl.value
    const option = dropdown?.querySelector('.mention-option.highlighted')
    if (!option) return
    const boundsTop = dropdown.getBoundingClientRect().top + dropdown.clientTop
    const top = searchRowEl.value?.getBoundingClientRect().bottom ?? boundsTop
    const bottom = boundsTop + dropdown.clientHeight
    const rect = option.getBoundingClientRect()
    if (rect.top < top) dropdown.scrollTop -= top - rect.top
    else if (rect.bottom > bottom) dropdown.scrollTop += rect.bottom - bottom
  })
}

const DROPDOWN_WIDTH = 240
const DROPDOWN_MAX_HEIGHT = 220

// 外层滚动会移动锚点。浏览器也会滚动外层以让输入光标留在视口内。
function closeOnOuterScroll(e) {
  if (e?.target === dropdownEl.value || e?.target === backdropEl.value) return
  if (mention.value.open && e?.target !== taEl.value) {
    if (e?.type === 'scroll' || e?.type === 'resize') {
      const focused = document.activeElement
      if (focused === taEl.value || dropdownEl.value?.contains(focused)) updateMentionState(false)
      else closeMention()
    } else closeMention()
  }
  closePreview()
}
function closePreviewOnEscape(event) {
  if (event.key !== 'Escape') return
  const restoreFocus = previewEl.value?.contains(document.activeElement)
  closePreview()
  if (restoreFocus) taEl.value?.focus()
}
onMounted(() => {
  window.addEventListener('scroll', closeOnOuterScroll, true)
  window.addEventListener('resize', closeOnOuterScroll)
  window.addEventListener('keydown', closePreviewOnEscape)
  window.addEventListener('blur', closePreview)
})
onBeforeUnmount(() => {
  cancelPreviewDismissal()
  stopAudioPreview()
  window.removeEventListener('scroll', closeOnOuterScroll, true)
  window.removeEventListener('resize', closeOnOuterScroll)
  window.removeEventListener('keydown', closePreviewOnEscape)
  window.removeEventListener('blur', closePreview)
})

watch(() => props.modelValue, (v) => {
  lastEmittedText = v
  if (hasComposingInput) return
  if (v !== text.value) {
    text.value = v
    closeMention()
    const listening = preview.value.option?.audioUrl && (pointerInPreview || previewEl.value?.contains(document.activeElement))
    if (!listening) closePreview()
  }
})
watch(() => [props.options, props.previewOnHover], () => {
  const shown = preview.value.option
  if (!shown) return
  const option = props.options.find(candidate => shown.id == null ? candidate.value === shown.value : candidate.id === shown.id)
  if (!props.previewOnHover || !option || option.audioUrl !== shown.audioUrl || option.image !== shown.image) closePreview()
  else preview.value.option = option
})

// 可引用名（按长度降序，保证最长匹配优先）及其分组样式（kind code 判断）
const mentionNames = computed(() => {
  const seen = new Map()
  for (const o of props.options) {
    if (o.value && !o.previewOnly && !seen.has(o.value)) seen.set(o.value, o.kind === 'scene' ? 'scene' : 'role')
  }
  return [...seen.entries()].sort((a, b) => b[0].length - a[0].length)
})

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const highlightRegex = computed(() => {
  if (!mentionNames.value.length) return null
  const alt = mentionNames.value.map(([name]) => escapeRegExp(name)).join('|')
  return new RegExp(`@(${alt})`, 'g')
})

// 镜像层高亮 HTML：@引用 包上分组色彩 span，其余文本原样
const highlightedHtml = computed(() => {
  let html = ''
  let last = 0
  const indexOf = new Map(props.options.map((option, index) => [option.value, index]))
  const spans = props.resolvePreviewRanges?.(text.value)
  const re = highlightRegex.value
  if (spans) {
    const indexById = new Map()
    props.options.forEach((option, index) => {
      if (option.id != null) indexById.set(option.id, index)
    })
    for (const hit of spans) {
      const index = indexById.size && hit.id != null ? indexById.get(hit.id) : indexOf.get(hit.name)
      if (index == null) continue
      const group = props.options[index].kind === 'scene' ? 'scene' : 'role'
      const virtual = text.value[hit.start] !== '@' ? ' mention-virtual' : ''
      html += escapeHtml(text.value.slice(last, hit.start))
      html += `<span class="mention-token mention-token-${group}${virtual}" data-mention-index="${index}">${escapeHtml(text.value.slice(hit.start, hit.end))}</span>`
      last = hit.end
    }
  } else if (re) {
    const groupOf = Object.fromEntries(mentionNames.value)
    for (const match of text.value.matchAll(re)) {
      // An unimported costume suffix must not preview a different base asset.
      if (/[A-Za-z0-9_-]/u.test(text.value[match.index + match[0].length] || '')) continue
      html += escapeHtml(text.value.slice(last, match.index))
      html += `<span class="mention-token mention-token-${groupOf[match[1]]}" data-mention-index="${indexOf.get(match[1])}">${escapeHtml(match[0])}</span>`
      last = match.index + match[0].length
    }
  }
  html += escapeHtml(text.value.slice(last))
  if (html.endsWith('\n')) html += '\u200b'
  return html
})

// 光标前最近一个 @token（@ 后不含空白），命中则处于引用输入态
function activeMention() {
  const ta = taEl.value
  if (!ta) return null
  const pos = ta.selectionStart
  const before = ta.value.slice(0, pos)
  const m = before.match(/@([^\s@]{0,20})$/)
  if (!m) return null
  return { start: pos - m[0].length, end: pos, query: m[1] }
}

// 光标紧邻一个完整 @引用（用于整体删除）
function mentionBeforeCaret() {
  const ta = taEl.value
  const pos = ta.selectionStart
  const before = ta.value.slice(0, pos)
  for (const [name] of mentionNames.value) {
    if (before.endsWith(`@${name}`)) return { start: pos - name.length - 1, end: pos }
  }
  return null
}
function mentionAfterCaret() {
  const ta = taEl.value
  const pos = ta.selectionStart
  const after = ta.value.slice(pos)
  for (const [name] of mentionNames.value) {
    if (after.startsWith(`@${name}`)) return { start: pos, end: pos + name.length + 1 }
  }
  return null
}

const filteredOptions = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  return props.options.filter(o => !o.previewOnly &&
    (!q || String(o.value).toLowerCase().includes(q) || String(o.label || '').toLowerCase().includes(q)),
  )
})

const groupedFiltered = computed(() => {
  const groups = []
  for (const opt of filteredOptions.value) {
    const name = opt.group || t('components.mention.fallbackGroup')
    const g = groups.find(item => item.group === name)
    if (g) g.options.push(opt)
    else groups.push({ group: name, options: [opt] })
  }
  return groups
})

const flatList = computed(() => groupedFiltered.value.flatMap(g => g.options))

function flatIndex(gi, oi) {
  let idx = 0
  for (let g = 0; g < gi; g++) idx += groupedFiltered.value[g].options.length
  return idx + oi
}

// 下拉为 fixed 定位（Teleport 到 body），坐标基于视口；下方空间不足时翻到光标上方
const mentionStyle = computed(() => ({
  left: `${mention.value.left}px`,
  maxHeight: `${mention.value.maxHeight}px`,
  ...(mention.value.above ? { bottom: `${window.innerHeight - mention.value.top}px` } : { top: `${mention.value.top}px` }),
}))

// 镜像 div 测量 textarea 光标坐标
function getCaretCoordinates(textarea, position) {
  const div = document.createElement('div')
  const style = getComputedStyle(textarea)
  const propsToCopy = [
    'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textIndent',
  ]
  div.style.position = 'absolute'
  div.style.visibility = 'hidden'
  div.style.whiteSpace = 'pre-wrap'
  div.style.wordWrap = 'break-word'
  div.style.top = '0'
  div.style.left = '-9999px'
  for (const p of propsToCopy) div.style[p] = style[p]
  div.textContent = textarea.value.substring(0, position)
  const span = document.createElement('span')
  span.textContent = textarea.value.substring(position) || '.'
  div.appendChild(span)
  document.body.appendChild(div)
  const rect = { top: span.offsetTop, left: span.offsetLeft }
  document.body.removeChild(div)
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.7 || 20
  return { ...rect, lineHeight }
}

function updateMentionState(resetSelection = true) {
  const active = activeMention()
  if (!active) { dismissMention(); return }
  // @后文本已精确等于某个完整引用名时不再弹列表（如删除引用尾部空格后光标落在完整引用上）
  if (mentionNames.value.some(([name]) => name === active.query)) {
    dismissMention()
    return
  }
  const ta = taEl.value
  const caret = getCaretCoordinates(ta, ta.selectionStart)
  const rect = ta.getBoundingClientRect()
  const width = Math.min(DROPDOWN_WIDTH, window.innerWidth - 16)
  const caretTop = rect.top + caret.top - ta.scrollTop
  if (!resetSelection) {
    const top = Math.max(0, caretTop, rect.top)
    const bottom = Math.min(window.innerHeight, caretTop + caret.lineHeight, rect.bottom)
    const x = Math.min(rect.right - 2, Math.max(rect.left + 2, rect.left + caret.left - ta.scrollLeft))
    const target = document.elementFromPoint(x, (top + bottom) / 2)
    if (bottom <= top || (target !== ta && !dropdownEl.value?.contains(target))) {
      dismissMention()
      return
    }
  }
  const belowTop = caretTop + caret.lineHeight + 4
  const aboveBottom = caretTop - 4
  const belowSpace = window.innerHeight - 8 - belowTop
  const aboveSpace = aboveBottom - 8
  const above = belowSpace < DROPDOWN_MAX_HEIGHT && aboveSpace > belowSpace
  const left = rect.left + Math.min(caret.left - ta.scrollLeft, Math.max(0, rect.width - width))
  mention.value = {
    open: true,
    start: active.start,
    end: active.end,
    query: active.query,
    top: above ? aboveBottom : belowTop,
    left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
    maxHeight: Math.max(0, Math.min(DROPDOWN_MAX_HEIGHT, above ? aboveSpace : belowSpace)),
    above,
  }
  if (resetSelection) {
    searchInput.value = null
    resetMentionSelection()
  }
}

function resetMentionSelection() {
  highlightIdx.value = 0
  if (dropdownEl.value) dropdownEl.value.scrollTop = 0
}

function closeMention() {
  mention.value.open = false
  searchInput.value = null
}

function dismissMention() {
  if (dropdownEl.value?.contains(document.activeElement)) taEl.value?.focus({ preventScroll: true })
  closeMention()
}

function setText(next, caret) {
  const ta = taEl.value
  if (ta) {
    ta.value = next
    ta.focus({ preventScroll: true })
    if (caret != null) ta.setSelectionRange(caret, caret)
  }
  text.value = next
  lastEmittedText = next
  closeMention()
  closePreview()
  emit('update:modelValue', next, ta)
  emit('commit', next)
}

function onInput(e) {
  closePreview()
  text.value = e.target.value
  if (e.isComposing) hasComposingInput = true
  if (hasComposingInput) return
  if (text.value !== lastEmittedText) {
    lastEmittedText = text.value
    emit('update:modelValue', text.value, e.target)
  }
  if (document.activeElement === e.target) updateMentionState()
}

function onCompositionStart() {
  hasComposingInput = true
  commitAfterComposition = false
  closeMention()
  closePreview()
}

function onCompositionEnd(event) {
  if (!hasComposingInput) return
  hasComposingInput = false
  onInput(event)
  if (commitAfterComposition) {
    commitAfterComposition = false
    emit('commit', text.value, true)
  }
}

function onScroll() {
  if (backdropEl.value && taEl.value) {
    backdropEl.value.scrollTop = taEl.value.scrollTop
    backdropEl.value.scrollLeft = taEl.value.scrollLeft
  }
  if (mention.value.open) updateMentionState(false)
  closePreview()
}

function onKeydown(e) {
  if (e.isComposing || e.keyCode === 229) return
  if (e.altKey && e.key === 'Enter' && previewAudioAtCaret()) {
    e.preventDefault()
    return
  }
  closePreview()
  const ta = taEl.value
  // @引用整体删除：光标在完整引用后按退格 / 在完整引用前按 Delete，整段一次删除
  if (ta && (e.key === 'Backspace' || e.key === 'Delete') && ta.selectionStart === ta.selectionEnd) {
    const hit = e.key === 'Backspace' ? mentionBeforeCaret() : mentionAfterCaret()
    if (hit) {
      e.preventDefault()
      const next = ta.value.slice(0, hit.start) + ta.value.slice(hit.end)
      setText(next, hit.start)
      return
    }
  }
  if (!mention.value.open) return
  if (e.altKey && e.key === 'ArrowDown' && searchEl.value) {
    e.preventDefault()
    searchEl.value.focus({ preventScroll: true })
    return
  }
  onMentionKeydown(e)
}

function onMentionKeydown(e) {
  if (e.isComposing || e.keyCode === 229) return
  const total = flatList.value.length
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (total) highlightOption((highlightIdx.value + 1) % total)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (total) highlightOption((highlightIdx.value - 1 + total) % total)
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    if (total) {
      e.preventDefault()
      pick(flatList.value[highlightIdx.value] || flatList.value[0])
    }
  } else if (e.key === 'Escape') {
    e.preventDefault()
    dismissMention()
  }
}

function pick(opt) {
  const ta = taEl.value
  if (!ta) return
  const before = ta.value.slice(0, mention.value.start)
  const after = ta.value.slice(mention.value.end)
  const insert = `@${opt.value} `
  const next = before + insert + after
  setText(next, before.length + insert.length)
}

function onBlur(e) {
  if (mention.value.open && dropdownEl.value?.contains(e.relatedTarget)) return
  finishBlur(e)
}

function onDropdownFocusOut(e) {
  if (e.relatedTarget === taEl.value || dropdownEl.value?.contains(e.relatedTarget)) return
  finishBlur(e)
}

function finishBlur(e) {
  closeMention()
  if (!pointerInPreview && !previewEl.value?.contains(e.relatedTarget)) closePreview()
  if (hasComposingInput) {
    commitAfterComposition = true
    return
  }
  emit('commit', text.value, true)
}

function syncDisplay(value, start, end, direction) {
  const ta = taEl.value
  const focus = document.activeElement
  if (!ta || hasComposingInput || (focus !== ta && !dropdownEl.value?.contains(focus))) return
  text.value = value
  lastEmittedText = value
  if (ta.value !== value) ta.value = value
  ta.setSelectionRange(start, end, direction)
  updateMentionState(focus === ta)
}
defineExpose({ syncDisplay })
</script>

<style scoped>
.mention-textarea {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
  min-height: 0;
}
/* 高亮镜像层：与 textarea 同款类名保证排版一致，仅背景/边框透明 */
.mention-backdrop {
  position: absolute;
  inset: 0;
  z-index: 0;
  background: transparent;
  border-color: transparent;
  box-shadow: none;
  overflow: hidden;
  pointer-events: none;
}
.mention-backdrop-content {
  white-space: pre-wrap;
  word-wrap: break-word;
  overflow-wrap: break-word;
}
/* textarea 文本透明，只显示光标；高亮由镜像层透出 */
.mention-input {
  position: relative;
  z-index: 1;
  flex: 1;
  min-height: 0;
  width: 100%;
  resize: none;
  background: transparent;
  color: transparent;
  caret-color: var(--text-0);
}
.mention-input::placeholder {
  color: var(--text-3);
}
/* @引用 着色：不改字距/内边距，保证与透明文本逐字对齐 */
.mention-backdrop :deep(.mention-token) {
  border-radius: 4px;
  font-weight: 600;
}
.mention-hover-preview .mention-backdrop,
.mention-hover-preview .mention-input {
  scrollbar-gutter: stable;
}
.mention-hover-preview .mention-backdrop :deep(.mention-token) {
  font-weight: inherit;
}
/* Position the display-only @ in the line leading. It takes no inline space,
   so hover bounds and native caret offsets match even after wrapping. */
.mention-backdrop :deep(.mention-virtual) { position: relative; }
.mention-backdrop :deep(.mention-virtual)::before {
  content: '@';
  position: absolute;
  left: 0;
  top: -.5em;
  font-size: .65em;
  line-height: 1;
}
.mention-backdrop :deep(.mention-token-role) {
  color: var(--accent-text);
  background: var(--accent-bg);
}
.mention-backdrop :deep(.mention-token-scene) {
  color: var(--tag-success-text);
  background: var(--success-bg);
}
.mention-dropdown {
  position: fixed;
  z-index: var(--z-menu);
  box-sizing: border-box;
  width: 240px;
  max-width: calc(100vw - 16px);
  max-height: 220px;
  overflow-y: auto;
  overscroll-behavior-y: contain;
  padding: 5px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface-raised);
  box-shadow: var(--shadow-lg);
}
.mention-search {
  position: sticky;
  top: 0;
  z-index: 1;
  padding-bottom: 5px;
  background: var(--surface-raised);
}
.mention-search input {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: 28px;
  padding: 3px 7px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-2);
  color: var(--text-0);
  font: inherit;
  font-size: 12px;
}
.mention-search input::placeholder { color: var(--text-3); }
.mention-search input:focus-visible {
  outline: 1px solid var(--accent-text);
  outline-offset: -1px;
}
.mention-preview {
  position: fixed;
  z-index: var(--z-tooltip, 1200);
  box-sizing: border-box;
  width: 216px;
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 16px);
  overflow: hidden;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface-raised);
  color: var(--text-0);
  box-shadow: var(--shadow-lg);
  pointer-events: none;
}
.mention-preview-image {
  display: grid;
  place-items: center;
  height: 160px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-2);
  color: var(--text-3);
}
.mention-preview-image img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.mention-preview strong {
  display: block;
  margin-top: 8px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  line-height: 18px;
}
.mention-preview > span {
  display: block;
  color: var(--text-3);
  font-size: 11px;
  line-height: 17px;
}
.mention-preview-audio { width: 280px; pointer-events: auto; }
.mention-preview-audio strong { margin-top: 0; }
.mention-preview-audio audio { display: block; width: 100%; height: 32px; margin-top: 5px; }
.mention-group-label {
  padding: 6px 8px 3px;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-3);
  letter-spacing: 0.02em;
}
.mention-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  cursor: pointer;
  text-align: left;
}
.mention-option.highlighted {
  background: var(--accent-bg);
}
.mention-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--bg-2);
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  overflow: hidden;
  flex-shrink: 0;
}
.mention-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
/* 无图时按分组着色图标底色 */
.mention-avatar-role { color: var(--accent-text); background: var(--accent-bg); }
.mention-avatar-scene { color: var(--tag-success-text); background: var(--success-bg); }
.mention-avatar-prop { color: var(--text-2); background: var(--bg-2); }
.mention-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 550;
  color: var(--text-0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mention-type {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-3);
}
.mention-empty {
  padding: 10px;
  font-size: 12px;
  color: var(--text-3);
  text-align: center;
}
</style>
