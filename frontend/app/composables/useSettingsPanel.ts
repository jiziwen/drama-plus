export function useSettingsPanel() {
  const isOpen = useState('settings-panel-open', () => false)
  const initialTab = useState('settings-panel-tab', () => 'ai')
  const configId = useState<number | undefined>('settings-panel-config', () => undefined)
  const revision = useState('settings-panel-revision', () => 0)
  function open(tab = 'ai', config?: number) {
    initialTab.value = tab
    configId.value = config
    isOpen.value = true
  }
  function close() { isOpen.value = false; revision.value++ }
  return { isOpen, initialTab, configId, revision, open, close }
}
