<template>
  <section class="sv-style-editor" :aria-labelledby="headingId">
    <h3 :id="headingId">项目统一风格</h3>
    <div class="sv-style-toolbar">
      <div class="sv-style-options" role="radiogroup" :aria-labelledby="headingId">
        <label
          v-for="preset in options"
          :key="preset.id"
          class="sv-style-option"
          :class="{ selected: modelValue.id === preset.id }"
        >
          <input
            type="radio"
            :name="groupId"
            :value="preset.id"
            :checked="modelValue.id === preset.id"
            :disabled="disabled"
            @change="selectPreset(preset)"
          />
          <span class="sv-style-swatch" :data-style="preset.id" aria-hidden="true" />
          <span>{{ preset.name.trim() || '未命名风格' }}</span>
        </label>
      </div>
      <button v-if="customPresets" type="button" class="btn btn-sm sv-style-add" :disabled="disabled || customLimitReached" @click="addCustomPreset">
        <span aria-hidden="true">＋</span> 新增自定义风格
      </button>
      <small v-if="customLimitReached">已达到本项目的自定义风格数量上限。</small>
    </div>
    <div v-if="latestPreset" class="sv-style-update">
      <span>已保存的前缀与当前预设内容不同。</span>
      <button type="button" :disabled="disabled" @click="useLatestPreset">使用最新预设</button>
    </div>
    <div v-if="editingCustomPreset" class="sv-style-custom">
      <label>
        风格名称
        <input ref="nameInput" class="input" :value="modelValue.name" :disabled="disabled" :maxlength="SCRIPT_VIDEO_CUSTOM_STYLE_NAME_LIMIT" placeholder="例如 水墨动画" @input="editCustomPreset('name', $event)" />
      </label>
      <label>
        风格提示词
        <textarea class="input" :value="modelValue.prefix" :disabled="disabled" maxlength="20000" rows="5" placeholder="填写统一的画风、色调、光影和材质要求" @input="editCustomPreset('prefix', $event)" />
      </label>
      <button type="button" class="btn btn-sm sv-style-remove" :disabled="disabled" @click="removeCustomPreset">删除此风格</button>
    </div>
    <details v-else class="sv-style-preview">
      <summary>查看完整前缀原文</summary>
      <pre aria-label="完整前缀原文" v-text="prefix"></pre>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue'
import { formatScriptVideoStylePreset, SCRIPT_VIDEO_CUSTOM_STYLE_LIMIT, SCRIPT_VIDEO_CUSTOM_STYLE_NAME_LIMIT, type ScriptVideoStylePreset } from '../../../backend/src/services/script-video-style'
import { createScriptVideoUuid } from '../utils/scriptVideoClient'

const props = defineProps<{
  modelValue: ScriptVideoStylePreset
  presets: readonly ScriptVideoStylePreset[]
  customPresets?: Readonly<Record<string, ScriptVideoStylePreset>>
  disabled?: boolean
}>()
const emit = defineEmits<{
  'update:modelValue': [value: ScriptVideoStylePreset]
  'update:customPresets': [value: Record<string, ScriptVideoStylePreset>]
}>()

const groupId = useId()
const headingId = groupId + '-heading'
const nameInput = ref<HTMLInputElement>()
const options = computed(() => [...props.presets, ...Object.values(props.customPresets ?? {})])
const customLimitReached = computed(() => Object.keys(props.customPresets ?? {}).length >= SCRIPT_VIDEO_CUSTOM_STYLE_LIMIT)
const editingCustomPreset = computed(() => !!props.customPresets && Object.hasOwn(props.customPresets, props.modelValue.id))
const prefix = computed(() => formatScriptVideoStylePreset(props.modelValue))
const latestPreset = computed(() => {
  if (props.modelValue.id !== 'cool' && props.modelValue.id !== 'warm') return
  const preset = props.presets.find(item => item.id === props.modelValue.id)
  return preset && preset.prefix !== props.modelValue.prefix ? preset : undefined
})
function selectPreset(preset: ScriptVideoStylePreset) {
  emit('update:modelValue', { ...preset })
}
function useLatestPreset() {
  if (latestPreset.value) selectPreset(latestPreset.value)
}
function writeCustomPreset(preset: ScriptVideoStylePreset) {
  emit('update:customPresets', { ...props.customPresets, [preset.id]: preset })
  selectPreset(preset)
}
async function addCustomPreset() {
  writeCustomPreset({ id: `custom-${createScriptVideoUuid()}`, name: '', prefix: '' })
  await nextTick()
  nameInput.value?.focus()
}
function editCustomPreset(field: 'name' | 'prefix', event: Event) {
  const input = event.target as HTMLInputElement | HTMLTextAreaElement
  writeCustomPreset({ ...props.modelValue, [field]: input.value })
}
function removeCustomPreset() {
  const fallback = props.presets.find(preset => preset.id === 'cool') ?? props.presets[0]
  if (!fallback) return
  const drafts = { ...props.customPresets }
  delete drafts[props.modelValue.id]
  emit('update:customPresets', drafts)
  selectPreset(fallback)
}
</script>

<style scoped>
.sv-style-editor { min-width: 0; color: var(--text-1); }
.sv-style-editor h3 {
  margin: 0 0 9px;
  color: var(--text-0);
  font-size: 13px;
  font-weight: 600;
}
.sv-style-toolbar, .sv-style-options { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.sv-style-option {
  display: inline-flex;
  position: relative;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 3px 13px 3px 6px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface-raised, var(--surface-1));
  font-size: 13px;
  cursor: pointer;
  max-width: 100%;
}
.sv-style-option > span:last-child { overflow-wrap: anywhere; }
.sv-style-option.selected {
  border-color: var(--accent);
  background: var(--accent-bg);
  color: var(--accent-text, var(--accent));
}
.sv-style-option input[type="radio"] { position: absolute; width: 1px; height: 1px; opacity: 0; }
.sv-style-option:focus-within, .sv-style-preview summary:focus-visible,
.sv-style-add:focus-visible, .sv-style-remove:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.sv-style-swatch { width: 36px; height: 24px; flex: none; border-radius: 4px; }
.sv-style-swatch[data-style="cool"] { background: linear-gradient(130deg, #23384b, #7599b3); }
.sv-style-swatch[data-style="warm"] { background: linear-gradient(130deg, #a4663f, #efd299); }
.sv-style-swatch:not([data-style="cool"], [data-style="warm"]) { background: linear-gradient(130deg, #454767, #9c8cba); }
.sv-style-custom {
  display: grid;
  gap: 12px;
  margin-top: 14px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface-raised, var(--surface-1));
}
.sv-style-custom label { display: grid; gap: 6px; min-width: 0; font-size: 13px; }
.sv-style-custom .input { width: 100%; }
.sv-style-custom textarea { min-height: 7em; resize: vertical; line-height: 1.65; }
.sv-style-remove { justify-self: start; color: var(--danger); }
.sv-style-update {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  color: var(--text-2);
  font-size: 12px;
}
.sv-style-update button {
  padding: 5px 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-raised, var(--surface-1));
  color: var(--accent-text, var(--accent));
  font: inherit;
  cursor: pointer;
}
.sv-style-update button:hover { border-color: var(--accent); }
.sv-style-update button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.sv-style-preview { margin-top: 10px; }
.sv-style-preview summary {
  width: fit-content;
  color: var(--accent-text, var(--accent));
  font-size: 12px;
  cursor: pointer;
}
.sv-style-preview pre {
  max-height: 17rem;
  max-height: min(17rem, 40vh);
  margin: 8px 0 0;
  overflow: auto;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface-input, var(--bg-2));
  color: var(--text-1);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  font-size: 12px;
  line-height: 1.7;
}
</style>
