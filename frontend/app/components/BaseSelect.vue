<template>
  <div class="base-select">
    <AppMenu v-model:open="isOpen" :disabled="disabled" block match-width :min-width="132" :max-height="380">
      <template #trigger>
        <button :id="inputId || undefined" ref="triggerEl" type="button" class="base-select-trigger" :class="{ open: isOpen }" :disabled="disabled" :aria-label="ariaLabel || undefined" :aria-expanded="isOpen" aria-haspopup="menu" @keydown="onTriggerKeydown">
          <span :class="selectedLabel ? '' : 'placeholder'" class="base-select-label" :title="selectedLabel || effectivePlaceholder">{{ selectedLabel || effectivePlaceholder }}</span>
          <ChevronDown :size="13" class="base-select-arrow" :class="{ open: isOpen }" />
        </button>
      </template>

      <!-- Search（slot 内容随父作用域，scoped 样式可达 Teleport 面板内） -->
      <div v-if="searchable" class="base-select-search">
        <Search :size="12" />
        <input
          ref="searchInputEl"
          v-model="searchQuery"
          class="base-select-search-input"
          :placeholder="t('components.baseSelect.search')"
          @keydown="onSearchKeydown"
        />
      </div>

      <!-- Options -->
      <div ref="optionsEl" class="base-select-options" @keydown="onOptionsKeydown">
        <template v-if="flatOptions.length">
          <template v-for="(group, gi) in filteredGroups" :key="gi">
            <div v-if="group.label" class="app-menu-group-label">{{ group.label }}</div>
            <button
              v-for="(opt, oi) in group.options"
              :key="opt.value"
              type="button"
              class="app-menu-item"
              :class="{ selected: opt.value === modelValue, highlighted: highlightedIdx === getGlobalIdx(gi, oi) }"
              role="menuitem"
              :disabled="opt.disabled"
              :tabindex="opt.disabled || (!searchable && highlightedIdx !== getGlobalIdx(gi, oi)) ? -1 : 0"
              @click="pick(opt)"
              @mousemove="!opt.disabled && (highlightedIdx = getGlobalIdx(gi, oi))"
            >{{ opt.label }}</button>
          </template>
        </template>
        <div v-else class="base-select-empty">{{ t('components.baseSelect.noMatch') }}</div>
      </div>
    </AppMenu>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, Search } from 'lucide-vue-next'

const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  options: { type: Array, default: () => [] }, // [{ label, value, group? }, ...] or [{ label, group, options: [] }]
  placeholder: { type: String, default: '' },  // 缺省回退 t('components.baseSelect.placeholder')
  searchable: { type: Boolean, default: true },
  ariaLabel: { type: String, default: '' },
  inputId: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue'])

const { t } = useI18n()
const effectivePlaceholder = computed(() => props.placeholder || t('components.baseSelect.placeholder'))

const isOpen = ref(false)
const searchQuery = ref('')
const searchInputEl = ref()
const triggerEl = ref()
const optionsEl = ref()
const highlightedIdx = ref(-1)

// Normalize options: support both flat list and grouped format
const normalizedGroups = computed(() => {
  if (!props.options.length) return []
  // Check if already grouped
  if (props.options[0]?.options) {
    return props.options.map(g => ({
      label: g.label || '',
      options: g.options.map(o => ({ label: String(o.label ?? o), value: o.value ?? o, disabled: !!o.disabled })),
    }))
  }
  // Flat list with optional group property
  const map = new Map()
  for (const o of props.options) {
    const label = o.group || ''
    if (!map.has(label)) map.set(label, [])
    map.get(label).push({ label: String(o.label ?? o), value: o.value ?? o, disabled: !!o.disabled })
  }
  return Array.from(map.entries()).map(([label, options]) => ({ label, options }))
})

// Filter by search query
const filteredGroups = computed(() => {
  if (!searchQuery.value) return normalizedGroups.value
  const q = searchQuery.value.toLowerCase()
  return normalizedGroups.value
    .map(g => ({
      label: g.label,
      options: g.options.filter(o => o.label.toLowerCase().includes(q)),
    }))
    .filter(g => g.options.length > 0)
})

// Flatten for keyboard nav
const flatOptions = computed(() => filteredGroups.value.flatMap(g => g.options))

function getGlobalIdx(gi, oi) {
  let idx = 0
  for (let i = 0; i < gi; i++) idx += filteredGroups.value[i].options.length
  return idx + oi
}

const selectedLabel = computed(() => {
  for (const g of normalizedGroups.value) {
    const found = g.options.find(o => o.value === props.modelValue)
    if (found) return found.label
  }
  return ''
})

function pick(opt) {
  if (props.disabled || opt.disabled) return
  emit('update:modelValue', opt.value)
  isOpen.value = false
  triggerEl.value?.focus()
}

function focusOption() {
  optionsEl.value?.querySelectorAll('[role="menuitem"]')[highlightedIdx.value]?.focus()
}
function onTriggerKeydown(event) {
  if (props.disabled) return
  if (event.key === 'Escape' && isOpen.value) {
    closeFromKeyboard(event)
    return
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  event.preventDefault()
  if (!isOpen.value) isOpen.value = true
  else focusOption()
}
function onOptionsKeydown(event) {
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    moveHighlight(event.key)
    nextTick(focusOption)
  } else if (event.key === 'Escape') {
    closeFromKeyboard(event)
  }
}

function closeFromKeyboard(event) {
  event.preventDefault()
  event.stopPropagation()
  isOpen.value = false
  triggerEl.value?.focus()
}

function moveHighlight(key) {
  const enabled = flatOptions.value.flatMap((option, index) => option.disabled ? [] : [index])
  const current = highlightedIdx.value
  highlightedIdx.value = key === 'Home' ? (enabled[0] ?? -1) : key === 'End' ? (enabled.at(-1) ?? -1)
    : key === 'ArrowDown' ? (enabled.find(index => index > current) ?? enabled.at(-1) ?? -1)
      : (enabled.filter(index => index < current).at(-1) ?? enabled[0] ?? -1)
}
watch(searchQuery, () => { highlightedIdx.value = flatOptions.value.findIndex(option => !option.disabled) })

// 打开时初始化键盘高亮并聚焦搜索框（定位/关闭由 AppMenu 负责）
watch(isOpen, async (val) => {
  if (val) {
    searchQuery.value = ''
    await nextTick()
    highlightedIdx.value = flatOptions.value.findIndex(o => o.value === props.modelValue && !o.disabled)
    if (props.searchable) searchInputEl.value?.focus()
    else {
      if (highlightedIdx.value < 0) highlightedIdx.value = flatOptions.value.findIndex(option => !option.disabled)
      await nextTick()
      focusOption()
    }
  } else {
    searchQuery.value = ''
  }
})

function onSearchKeydown(e) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    moveHighlight('ArrowDown')
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    moveHighlight('ArrowUp')
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (highlightedIdx.value >= 0 && flatOptions.value[highlightedIdx.value]) {
      pick(flatOptions.value[highlightedIdx.value])
    }
  } else if (e.key === 'Escape') {
    closeFromKeyboard(e)
  }
}
</script>

<style scoped>
.base-select {
  display: flex;
  width: 100%;
  min-width: 0;
}

.base-select-trigger {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-height: var(--button-height);
  padding: 0 30px 0 12px;
  font-size: 12px;
  font-weight: 600;
  font-family: var(--font-body);
  color: var(--button-text);
  background: var(--button-bg);
  border: 1px solid var(--button-border);
  border-radius: var(--button-radius);
  cursor: pointer;
  transition: all 0.18s var(--ease-out);
  white-space: nowrap;
  min-width: 0;
  width: 100%;
  max-width: none;
  flex-shrink: 0;
  box-shadow: var(--button-shadow);
}
.base-select-trigger:hover {
  border-color: var(--button-border-hover);
  background: var(--button-bg-hover);
  color: var(--button-text-hover);
  box-shadow: var(--button-shadow-hover);
}
.base-select-trigger:disabled { opacity: .55; cursor: not-allowed; box-shadow: none; }
.base-select-options .app-menu-item:disabled { opacity: .45; cursor: not-allowed; background: transparent; }
.base-select-trigger.open {
  border-color: var(--action-primary);
  box-shadow: 0 0 0 3px var(--button-focus), var(--button-shadow-hover);
  background: var(--button-bg-hover);
}
.base-select-trigger:focus-visible {
  outline: none;
  border-color: var(--action-primary);
  box-shadow: 0 0 0 3px var(--button-focus), var(--button-shadow-hover);
}
.base-select-trigger .placeholder {
  color: var(--text-3);
  font-weight: 300;
}
.base-select-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
  text-align: left;
}

.base-select-arrow {
  margin-left: auto;
  color: var(--text-2);
  transition: transform 0.2s var(--ease-out);
  flex-shrink: 0;
}
.base-select-arrow.open {
  transform: rotate(180deg);
}

/* Search（Teleport 面板内的 slot 内容，随父作用域） */
.base-select-search {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: -5px -5px 0;   /* 抵消面板 padding，搜索框通栏 */
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  color: var(--text-2);
}
.base-select-search-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 13px;
  font-family: var(--font-body);
  color: var(--text-0);
}
.base-select-search-input::placeholder {
  color: var(--text-3);
}

.base-select-options {
  overflow-y: auto;
  max-height: 260px;
}

.base-select-empty {
  padding: 16px 12px;
  font-size: 13px;
  color: var(--text-3);
  text-align: center;
}
</style>
