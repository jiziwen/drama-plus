<template>
  <div class="sv-model-select">
    <span class="sv-model-label">视频模型</span>
    <BaseSelect
      :model-value="selected?.key || ''"
      :options="selectOptions"
      :placeholder="loading ? '读取模型中…' : '暂无可用视频模型'"
      :disabled="loading || !options.some(option => option.maxDuration > 0)"
      :searchable="options.length > 8"
      variant="inspector"
      aria-label="视频模型"
      @update:model-value="selectModel"
    >
      <template #label="{ option }">
        <span class="sv-model-option">
          <span>{{ option.displayModel }}</span>
          <small>{{ option.disabled ? '当前适配器不支持' : option.serviceName }}</small>
        </span>
      </template>
    </BaseSelect>
    <span class="sv-model-hint">{{ hint }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { aiConfigAPI } from '~/composables/useApi'
import { scriptVideoCapabilities } from '../../../backend/src/services/script-video-capabilities'

type Selection = {
  provider?: string
  key: string
  label: string
  minDuration: number
  maxDuration: number
  wholeSeconds: boolean
  configId: number
  model: string
  maxAudioReferences: number | null
  maxAudioDuration: number
}
type ModelOption = Selection & { displayModel: string; serviceName: string }
type Config = {
  id: number
  name?: string
  provider: string
  model: string[]
  comfyui?: Parameters<typeof scriptVideoCapabilities>[2]
  is_active?: boolean | number
  priority?: number
}
const props = defineProps<{ modelValue?: string }>()
const emit = defineEmits<{
  'update:modelValue': [key: string]
  change: [selection: Selection]
}>()
const options = ref<ModelOption[]>([])
const selectOptions = computed(() => options.value.map(option => ({
  value: option.key,
  label: option.label,
  displayModel: option.displayModel,
  serviceName: option.serviceName,
  disabled: !option.maxDuration,
})))
const loading = ref(true)
const loadFailed = ref(false)
const { revision: settingsRevision } = useSettingsPanel()
const modelLabel = useModelLabel()
const selectedKey = computed(() => props.modelValue || '')
const selected = computed(() => options.value.find(option => option.key === selectedKey.value && option.maxDuration))
const hint = computed(() => {
  if (loading.value) return '正在读取视频服务配置'
  if (loadFailed.value) return '未能读取模型配置，请检查服务连接'
  if (!selected.value) return '请在设置中启用支持的视频模型'
  if (selected.value.maxAudioReferences === null) return '本流程单段最长 30 秒，实际时长和参考素材限制以所选模型为准。'
  const audioDuration = selected.value.maxAudioDuration > 0 ? `，合计不超过 ${selected.value.maxAudioDuration} 秒` : ''
  const audio = selected.value.maxAudioReferences
    ? `支持最多 ${selected.value.maxAudioReferences} 段角色声音参考${audioDuration}。`
    : '当前模型不支持角色声音参考。'
  return `本流程单段最长 ${selected.value.maxDuration} 秒。${audio}`
})
function selectModel(key: string | number) {
  const option = options.value.find(item => item.key === key && item.maxDuration)
  if (option) emit('update:modelValue', option.key)
}
watch([selected, selectedKey, loading], ([value, key, isLoading]) => {
  if (isLoading) return
  const preferred = value ?? options.value.find(option => option.maxDuration > 0)
  if (preferred && preferred.key !== key) {
    emit('update:modelValue', preferred.key)
  } else if (preferred) {
    emit('change', preferred)
  } else {
    if (key) emit('update:modelValue', '')
    emit('change', { key: '', label: '模型不可用', minDuration: 1, maxDuration: 0, wholeSeconds: true, configId: 0, model: '', maxAudioReferences: 0, maxAudioDuration: 0 })
  }
}, { immediate: true })
let loadVersion = 0
async function loadConfigs() {
  const version = ++loadVersion
  loading.value = true
  loadFailed.value = false
  try {
    const result = await aiConfigAPI.list('video')
    if (version !== loadVersion) return
    const configs = Array.isArray(result) ? result as Config[] : []
    options.value = configs.filter(config => config.is_active && Number.isSafeInteger(config.id) && config.id > 0 && Array.isArray(config.model))
      .sort((a, b) => (b.priority || 0) - (a.priority || 0))
      .flatMap(config => [...new Set(config.model.filter(model => typeof model === 'string' && model.trim()))].map(model => {
        const capabilities = scriptVideoCapabilities(config.provider || '', model, config.comfyui)
        const serviceName = config.name || config.provider
        const name = modelLabel(model)
        const suffix = ` · ${serviceName}`
        const displayModel = name.endsWith(suffix) ? name.slice(0, -suffix.length) : name
        return {
          key: `config:${config.id}:${model}`, configId: config.id, model, provider: config.provider,
          label: `${displayModel} · ${serviceName}`, displayModel, serviceName,
          minDuration: capabilities?.minDuration ?? 1,
          maxDuration: capabilities?.maxDuration ?? 0,
          wholeSeconds: capabilities?.wholeSeconds ?? true,
          maxAudioReferences: capabilities ? capabilities.maxAudioReferences : 0,
          maxAudioDuration: capabilities?.maxAudioDuration ?? 0,
        }
      }))
  } catch { if (version === loadVersion) loadFailed.value = true }
  finally { if (version === loadVersion) loading.value = false }
}
onMounted(loadConfigs)
watch(settingsRevision, loadConfigs)
</script>

<style scoped>
.sv-model-select {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
  color: var(--text-2);
  font-size: 11px;
}
.sv-model-label {
  font-weight: 500;
}
.sv-model-select :deep(.base-select-trigger) {
  min-height: 44px;
}
.sv-model-option {
  display: grid;
  gap: 3px;
  line-height: 1.2;
}
.sv-model-option small {
  color: var(--text-2);
  font-size: 10px;
}
.sv-model-select :deep(.base-select-trigger) .sv-model-option > * {
  overflow: hidden;
  text-overflow: ellipsis;
}
.sv-model-hint {
  color: var(--text-3);
  font-size: 10px;
  line-height: 1.5;
}
</style>
