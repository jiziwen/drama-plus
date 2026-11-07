<template>
  <div class="cinematic-shell">
    <div ref="sky" class="cinematic-sky" aria-hidden="true" />
    <div class="cinematic-aurora" aria-hidden="true" />
    <header class="cine-header">
      <NuxtLink :to="interfaceLink('/')" class="cine-brand" aria-label="小李短剧 创作空间">
        <span class="cine-brand-mark"><Clapperboard :size="20" /><i /></span>
        <span>小李短剧<small>A DIRECTOR’S UNIVERSE</small></span>
      </NuxtLink>
      <nav class="cine-navigation" aria-label="工作空间导航">
        <NuxtLink :to="interfaceLink('/')" :class="{ selected: route.path === '/' && route.query.view !== 'library' }"><span>01</span>创作空间</NuxtLink>
        <NuxtLink :to="interfaceLink('/?view=library')" :class="{ selected: route.query.view === 'library' || route.path.startsWith('/drama/') }"><span>02</span>故事档案</NuxtLink>
        <NuxtLink :to="interfaceLink('/assets')" :class="{ selected: route.path === '/assets' }"><span>03</span>资产画廊</NuxtLink>
        <NuxtLink :to="interfaceLink('/settings')" :class="{ selected: route.path === '/settings' }"><span>04</span>工作室</NuxtLink>
      </nav>
      <div class="cine-header-actions">
        <span class="cine-preview-badge" title="星光导演界面">导演模式<i /></span>
        <button class="global-settings-trigger cine-icon" aria-label="打开设置" @click="openSettings()"><SlidersHorizontal :size="17" /></button>
        <ThemeToggle />
        <NuxtLink :to="interfaceTarget('classic')" class="cine-original" title="切换为旧版">旧版<ArrowUpRight :size="13" /></NuxtLink>
      </div>
    </header>
    <div v-if="missing.length" class="cine-config-notice" role="status"><TriangleAlert :size="13" /><span>{{ missing.join('、') }}模型尚未启用</span><button @click="openSettings('ai')">配置生成服务 <ArrowUpRight :size="12" /></button></div>
    <main class="cine-content"><slot /></main>
  </div>
</template>
<script setup lang="ts">
import { ArrowUpRight, Clapperboard, SlidersHorizontal, TriangleAlert } from 'lucide-vue-next'
import { aiConfigAPI } from '~/composables/useApi'

const route = useRoute()
const { interfaceLink, interfaceTarget } = useStudioInterface()
const { open: openSettings, isOpen, revision } = useSettingsPanel()
useHead({ link: [{ rel: 'stylesheet', href: '/studio/vendor/fonts.css' }] })
const sky = ref<HTMLElement | null>(null)
const missing = ref<string[]>([])
let field: any
let alive = true
let screeningOpen = false
async function checkConfigs() {
  try {
    const configs = await aiConfigAPI.list()
    if (alive) missing.value = Object.entries({ text: '文本', image: '图片', video: '视频' }).filter(([type]) => !configs.some((c: any) => c.service_type === type && c.is_active)).map(([, label]) => label)
  } catch { /* Existing pages show API failures in their own context. */ }
}
function visibility() { field?.setPaused(document.hidden || isOpen.value || screeningOpen) }
function screeningChange(event: Event) { screeningOpen = Boolean((event as CustomEvent).detail?.open); visibility() }
onMounted(async () => {
  void checkConfigs()
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('cinematic-screening-change', screeningChange)
  // Public ES modules are shared with the approved visual preview; no duplicate render loop.
  const source = '/studio/starfield.js'
  const { createStarfield } = await import(/* @vite-ignore */ source)
  if (!alive || !sky.value) return
  field = createStarfield(sky.value, { intensity: .8, density: .9 })
  visibility()
})
watch(isOpen, visibility)
watch(revision, checkConfigs)
onBeforeUnmount(() => { alive = false; document.removeEventListener('visibilitychange', visibility); window.removeEventListener('cinematic-screening-change', screeningChange); field?.destroy() })
</script>
