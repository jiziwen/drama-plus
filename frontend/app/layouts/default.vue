<template>
 <div class="shell soft-shell">
  <header class="soft-header">
   <NuxtLink to="/" class="soft-brand"><span><Clapperboard :size="22"/></span><div>小李短剧<small>little things. big stories.</small></div></NuxtLink>
   <nav class="soft-navigation" aria-label="工作空间导航"><NuxtLink to="/" :class="{selected:route.path==='/'&&route.query.view!=='library'}"><LayoutGrid :size="15"/>创作台</NuxtLink><NuxtLink to="/?view=library" :class="{selected:route.query.view==='library'||route.path.startsWith('/drama/')}"><FolderKanban :size="15"/>项目书架</NuxtLink><NuxtLink to="/assets" :class="{selected:route.path==='/assets'}"><Images :size="15"/>资产画廊</NuxtLink><NuxtLink to="/settings" :class="{selected:route.path==='/settings'}"><Settings :size="15"/>工作室</NuxtLink></nav>
   <div class="soft-header-actions"><button class="global-settings-trigger soft-icon" :aria-label="t('layout.nav.settings')" @click="openSettings()"><SlidersHorizontal :size="18"/></button><ThemeToggle /></div>
  </header>
  <div v-if="missingConfigLabels.length" class="config-banner"><TriangleAlert :size="14"/><span>{{t('layout.banner.missing',{types:missingConfigLabels.join(t('common.listJoin'))})}}</span><button class="config-banner-link" @click="openSettings()">{{t('layout.banner.goSettings')}}</button></div>
  <main class="content"><slot/></main>
 </div>
</template>
<script setup>
import {Clapperboard,LayoutGrid,FolderKanban,Images,Settings,SlidersHorizontal,TriangleAlert} from 'lucide-vue-next'
import {useI18n} from 'vue-i18n'
import {aiConfigAPI} from '~/composables/useApi'
const {t}=useI18n(),route=useRoute()
const {open:openSettings,revision:settingsRevision}=useSettingsPanel()
const missingConfigLabels=ref([])
async function checkAiConfigs(){try{const configs=await aiConfigAPI.list();missingConfigLabels.value=Object.entries({text:t('common.serviceType.text'),image:t('common.serviceType.image'),video:t('common.serviceType.video')}).filter(([type])=>!configs.some(c=>c.service_type===type&&c.is_active)).map(([,label])=>label)}catch{/* Keep navigation available if the server is temporarily offline. */}}
onMounted(checkAiConfigs)
watch(settingsRevision,checkAiConfigs)
watch(()=>route.path,checkAiConfigs)
</script>
