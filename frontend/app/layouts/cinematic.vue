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
        <NuxtLink :to="interfaceLink('/novel-to-script')" :class="{ selected: route.path === '/novel-to-script' }"><span>04</span>小说转剧本</NuxtLink>
        <NuxtLink :to="interfaceLink('/script-to-video')" :class="{ selected: route.path.includes('script-to-video') }" title="剧本转视频"><span>05</span>剧本转视频</NuxtLink>
        <NuxtLink :to="interfaceLink('/downmarket-drama')" :class="{ selected: route.path === '/downmarket-drama' }"><span>06</span>一键下沉</NuxtLink>
        <NuxtLink :to="interfaceLink('/ai-chat')" :class="{ selected: route.path === '/ai-chat' }"><span>07</span>AI 聊天</NuxtLink>
      </nav>
      <div class="cine-header-actions">
        <ReleaseNotesBell />
        <span class="cine-preview-badge" title="星光导演界面">导演模式<i /></span>
        <button class="global-settings-trigger cine-icon" aria-label="打开设置" @click="openSettings()"><SlidersHorizontal :size="17" /></button>
        <ThemeToggle />
        <NuxtLink :to="interfaceTarget('classic')" class="cine-original" title="切换为旧版">旧版<ArrowUpRight :size="13" /></NuxtLink>
        <SiteSessionMenu />
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

<style scoped>
@media (max-width: 900px) {
  .cine-header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-rows: auto auto;
    height: auto;
    gap: 3px 8px;
    padding: 7px clamp(10px, 3vw, 22px) 0;
  }
  .cine-header-actions { grid-column: 2; grid-row: 1; }
  .cine-navigation {
    grid-column: 1 / -1;
    grid-row: 2;
    min-width: 0;
    height: 44px;
    justify-content: flex-start;
    gap: 16px;
    overflow-x: auto;
    overscroll-behavior-inline: contain;
    scrollbar-width: thin;
  }
  .cine-navigation a { flex: 0 0 auto; }
  .cine-navigation a::after { bottom: 4px; }
}
@media (max-width: 650px) {
  .cine-header { padding: 5px 12px 0; gap: 2px 8px; }
  .cine-navigation { height: 34px; gap: 12px; scroll-snap-type: inline proximity; scrollbar-width: none; }
  .cine-navigation a { font-size: 10.5px; scroll-snap-align: start; }
  .cine-icon, .cine-original { min-height: 32px; }
  .cine-header :deep(.theme-toggle), .cine-header :deep(.site-account-menu summary) { min-height: 32px; }
  .cine-config-notice { padding-inline: 12px; }
  .cine-config-notice > svg { flex: none; }
  .cine-config-notice > span { min-width: 0; overflow-wrap: anywhere; }
  .cine-config-notice > button { flex: none; min-height: 36px; }
}
@media (max-width: 400px) {
  .cine-header :deep(.site-account-menu summary) { width: 34px; justify-content: center; padding: 0; }
  .cine-header :deep(.site-account-menu summary span),
  .cine-header :deep(.site-account-menu summary svg:last-child) { display: none; }
}
</style>
