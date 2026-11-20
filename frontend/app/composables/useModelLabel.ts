import { useI18n } from 'vue-i18n'

export function useModelLabel() {
  const { t } = useI18n()
  const keys: Record<string, string> = {
    'wf-image': 'settings.comfyui.autoImage', 'wf-z-image': 'settings.comfyui.zImage',
    'wf-z-scene': 'settings.comfyui.sceneImage',
    'wf-qwen-image': 'settings.comfyui.qwenImage', 'wf-minimax-h3': 'settings.comfyui.h3Video',
    'jimeng-seedance-2.5': 'settings.jimeng.seedance25',
    'jimeng-seedance-2.5-draft': 'settings.jimeng.seedance25Draft',
    'jimeng-seedance-2.5-flash': 'settings.jimeng.seedance25Flash',
    'jimeng-seedance-2.0': 'settings.jimeng.seedance20',
    'star-video2.5': 'settings.libtv.standard',
    'star-video2.5-draft': 'settings.libtv.draft',
    'star-video2.5-flash': 'settings.libtv.flash',
  }
  return (model: string) => keys[model] ? t(keys[model]) : model
}
