import { useI18n } from 'vue-i18n'

export function useModelLabel() {
  const { t } = useI18n()
  const keys: Record<string, string> = {
    'wf-image': 'autoImage', 'wf-z-image': 'zImage',
    'wf-z-scene': 'sceneImage',
    'wf-qwen-image': 'qwenImage', 'wf-minimax-h3': 'h3Video',
  }
  return (model: string) => keys[model] ? t(`settings.comfyui.${keys[model]}`) : model
}
