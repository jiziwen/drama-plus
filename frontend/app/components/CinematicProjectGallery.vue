<template>
  <section class="cine-gallery" aria-label="故事创作空间">
    <div class="cine-gallery-intro"><span class="cine-kicker"><i /> YOUR NEXT WORLD STARTS HERE</span><h1>让想象，<em>开始放映。</em></h1><p>从第一行故事，到最后一束光。<br class="mobile-break" />这里，是你的导演宇宙。</p></div>
    <div ref="stage" class="cine-film-ribbon" aria-label="拖动影像选择故事" />
    <div class="cine-gallery-axis" aria-hidden="true"><span>IMAGINATION, IN MOTION</span><i /><b>∞</b></div>
    <div class="cine-gallery-bottom">
      <div class="cine-selected-story" aria-live="polite">
        <span class="cine-kicker">{{ selected?.project ? 'YOUR STORY / 正在创作' : 'YOUR NEXT STORY / 下一个世界' }}</span>
        <h2>{{ selected?.title || '正在载入你的世界…' }}</h2>
        <p>{{ selected?.project ? `${selected.project.episodes?.length || 0} 集 · ${selected.project.characters?.length || 0} 位角色 · ${selected.project.scenes?.length || 0} 个场景` : selected?.tagline }}</p>
        <small v-if="selected?.assetLabel">{{ selected.assetLabel }}</small><small v-else-if="selected?.project && !projectCover(selected.project)">封面尚未设置 · 当前为氛围占位</small>
      </div>
      <div class="cine-gallery-open"><button class="cine-enter" :disabled="loading || !selected" @click="openSelected"><span>{{ selected?.project ? '进入故事' : '从这里开始' }}<small>{{ selected?.project ? 'OPEN YOUR STORY' : 'CREATE A NEW STORY' }}</small></span><span class="cine-enter-arrow"><ArrowUpRight :size="23" /></span></button><button class="cine-new-text" @click="$emit('create')"><Plus :size="14" /> 开一个新故事</button></div>
    </div>
    <footer class="cine-gallery-footer"><div><span class="cine-live-dot" /><span>{{ loading ? '正在连接你的项目…' : `${projects.length} 个故事 · 你的创作空间` }}</span><NuxtLink :to="interfaceLink('/?view=library')">查看故事档案 <ArrowUpRight :size="12" /></NuxtLink></div><div class="cine-gallery-pagination"><span>{{ String(selectedIndex + 1).padStart(2, '0') }}<i>/ {{ String(items.length).padStart(2, '0') }}</i></span><button aria-label="上一个故事" :disabled="selectedIndex === 0" @click="choose(-1)"><ArrowLeft :size="16" /></button><button aria-label="下一个故事" :disabled="selectedIndex >= items.length - 1" @click="choose(1)"><ArrowRight :size="16" /></button></div><span class="cine-drag-hint">DRAG TO EXPLORE <MoveHorizontal :size="15" /></span></footer>
  </section>
</template>
<script setup lang="ts">
import { ArrowUpRight, ArrowLeft, ArrowRight, Plus, MoveHorizontal } from 'lucide-vue-next'
import { projectCover, projectGalleryImages } from '~/utils/projectPresentation'
const props = defineProps<{ projects: any[]; loading: boolean }>()
const emit = defineEmits<{ open: [project: any]; create: [] }>()
const { interfaceLink } = useStudioInterface()
const { isOpen: settingsOpen } = useSettingsPanel()
const stage = ref<HTMLElement | null>(null)
const selectedId = ref('')
const items = computed(() => {
  const seen = new Set<string>()
  const real = props.projects.flatMap(project => {
    const images = projectGalleryImages(project).filter(image => { const u = new URL(image.src, typeof location === 'undefined' ? 'http://studio.local' : location.origin); const key = u.origin + u.pathname; if (seen.has(key)) return false; seen.add(key); return true })
    const entries = images.length ? images : projectGalleryImages(project).length ? [] : [{ id: 'empty', src: '/studio/assets/story-placeholder.svg', kind: '', name: '' }]
    return entries.map(image => ({ id: `project-${project.id}-${image.id}`, title: project.title, caption: image.kind ? `${project.title} · ${image.kind} / ${image.name}` : project.title, poster: image.src, assetLabel: image.kind ? `${image.kind} · ${image.name}` : '', video: '', project, tagline: '', aspect: 1.7, posterFocus: .5 }))
  })
  return real.length ? real : [{ id: 'create-story', title: '你的第一个故事', caption: '创建一个新故事', poster: '/studio/assets/story-placeholder.svg', video: '', project: null, tagline: '写下第一段文字，创建属于你的故事。', aspect: 1.7, posterFocus: .5 }]
})
const selectedIndex = computed(() => Math.max(0, items.value.findIndex(item => item.id === selectedId.value)))
const selected = computed(() => items.value[selectedIndex.value])
let ribbon: any
let alive = true
let loadedRealProjects = false
function openSelected() {
  if (props.loading) return
  if (selected.value?.project) emit('open', selected.value.project)
  else emit('create')
}
function choose(offset: number) {
  const next = Math.max(0, Math.min(items.value.length - 1, selectedIndex.value + offset))
  selectedId.value = items.value[next].id
  ribbon?.select(selectedId.value)
}
function pause() { ribbon?.setPaused(document.hidden || settingsOpen.value || !!document.querySelector('.soft-home > .overlay')) }
let observer: MutationObserver | undefined
onMounted(async () => {
  selectedId.value = items.value[0]?.id || ''
  const source = '/studio/ribbon.js'
  const { createRibbonV2 } = await import(/* @vite-ignore */ source)
  if (!alive || !stage.value) return
  ribbon = createRibbonV2(stage.value, { items: items.value, loop: false, initialId: selectedId.value, onSelect: (id: string) => { selectedId.value = id }, onOpen: (id: string) => { selectedId.value = id; openSelected() } })
  document.addEventListener('visibilitychange', pause)
  observer = new MutationObserver(pause)
  const page = stage.value.closest('.soft-home')
  if (page) observer.observe(page, { childList: true })
  pause()
})
watch(items, value => {
  const firstReal = value.find(item => item.project)
  if (!loadedRealProjects && firstReal) { selectedId.value = firstReal.id; loadedRealProjects = true }
  else if (!value.some(item => item.id === selectedId.value)) selectedId.value = value[0]?.id || ''
  ribbon?.setItems(value)
  ribbon?.select(selectedId.value)
})
watch(settingsOpen, pause)
onBeforeUnmount(() => { alive = false; observer?.disconnect(); document.removeEventListener('visibilitychange', pause); ribbon?.destroy() })
</script>
