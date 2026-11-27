<template>
 <div class="shell soft-shell">
  <header class="soft-header">
   <NuxtLink to="/" class="soft-brand"><span><Clapperboard :size="22"/></span><div>小李短剧<small>little things. big stories.</small></div></NuxtLink>
   <nav class="soft-navigation" aria-label="工作空间导航">
    <NuxtLink to="/" :class="{selected:route.path==='/'&&route.query.view!=='library'}"><LayoutGrid :size="15"/>创作台</NuxtLink>
    <NuxtLink to="/?view=library" :class="{selected:route.query.view==='library'||route.path.startsWith('/drama/')}"><FolderKanban :size="15"/>项目书架</NuxtLink>
    <NuxtLink to="/assets" :class="{selected:route.path==='/assets'}"><Images :size="15"/>资产画廊</NuxtLink>
    <NuxtLink to="/novel-to-script" :class="{ selected: route.path === '/novel-to-script' }"><BookOpen :size="15"/>小说转剧本</NuxtLink>
    <NuxtLink to="/script-to-video" :class="{ selected: route.path.includes('script-to-video') }" title="剧本转视频"><Film :size="15"/>剧本转视频</NuxtLink>
    <NuxtLink to="/downmarket-drama" :class="{selected:route.path==='/downmarket-drama'}"><PenLine :size="15"/>一键下沉</NuxtLink>
    <NuxtLink to="/ai-chat" :class="{selected:route.path==='/ai-chat'}"><MessageSquare :size="15"/>AI 聊天</NuxtLink>
   </nav>
   <div class="soft-header-actions"><NuxtLink class="btn interface-version-switch" :to="interfaceTarget('cinematic')" title="切换为新版">新版 <ArrowUpRight :size="13"/></NuxtLink><button class="global-settings-trigger soft-icon" :aria-label="t('layout.nav.settings')" @click="openSettings()"><SlidersHorizontal :size="18"/></button><ThemeToggle /><SiteSessionMenu /></div>
  </header>
  <div v-if="missingConfigLabels.length" class="config-banner"><TriangleAlert :size="14"/><span>{{t('layout.banner.missing',{types:missingConfigLabels.join(t('common.listJoin'))})}}</span><button class="config-banner-link" @click="openSettings()">{{t('layout.banner.goSettings')}}</button></div>
  <main class="content"><slot/></main>
 </div>
</template>
<script setup>
import {BookOpen,Clapperboard,LayoutGrid,FolderKanban,Images,Film,MessageSquare,PenLine,SlidersHorizontal,TriangleAlert,ArrowUpRight} from 'lucide-vue-next'
import {useI18n} from 'vue-i18n'
import {aiConfigAPI} from '~/composables/useApi'
const {t}=useI18n(),route=useRoute()
const {open:openSettings,revision:settingsRevision}=useSettingsPanel()
const {interfaceTarget}=useStudioInterface()
const missingConfigLabels=ref([])
async function checkAiConfigs(){try{const configs=await aiConfigAPI.list();missingConfigLabels.value=Object.entries({text:t('common.serviceType.text'),image:t('common.serviceType.image'),video:t('common.serviceType.video')}).filter(([type])=>!configs.some(c=>c.service_type===type&&c.is_active)).map(([,label])=>label)}catch{/* Keep navigation available if the server is temporarily offline. */}}
onMounted(checkAiConfigs)
watch(settingsRevision,checkAiConfigs)
watch(()=>route.path,checkAiConfigs)
</script>
<style scoped>
@media (max-width: 900px) {
  html:root body .soft-header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-rows: auto auto;
    height: auto;
    gap: 4px 8px;
    padding: 6px clamp(10px, 3vw, 22px) 7px;
  }
  html:root body .soft-header-actions { grid-column: 2; grid-row: 1; }
  html:root body .soft-navigation {
    grid-column: 1 / -1;
    grid-row: 2;
    justify-content: flex-start;
    min-width: 0;
    margin: 0;
    padding: 2px 4px;
    overflow-x: auto;
    overscroll-behavior-inline: contain;
    scrollbar-width: thin;
  }
  html:root body .soft-navigation > a { flex: 0 0 auto; min-height: 40px; }
}
@media (max-width: 650px) {
  html:root body .soft-header { padding: 5px 12px; }
  html:root body .soft-navigation { scroll-snap-type: inline proximity; scrollbar-width: none; }
  html:root body .soft-navigation > a { min-height: 32px; padding: 4px 9px; font-size: 10.5px; scroll-snap-align: start; }
  .soft-header .soft-header-actions { gap: 6px; }
  .soft-header .interface-version-switch { padding: 0 8px; min-height: 32px; font-size: 11px; gap: 4px; }
  .soft-header .soft-icon { min-height: 32px; }
  .soft-header :deep(.theme-toggle), .soft-header :deep(.site-account-menu summary) { min-height: 32px; }
  .config-banner > svg { flex: none; }
  .config-banner > span { min-width: 0; overflow-wrap: anywhere; }
}
@media (max-width: 400px) {
  .soft-header .soft-brand { font-size: 15px; gap: 7px; }
  .soft-header .soft-brand > span { width: 30px; height: 32px; }
  .soft-header .soft-brand small { font-size: 6px; letter-spacing: 0; }
  .soft-header :deep(.site-account-menu summary) { width: 34px; justify-content: center; padding: 0; }
  .soft-header :deep(.site-account-menu summary span),
  .soft-header :deep(.site-account-menu summary svg:last-child) { display: none; }
}
</style>
