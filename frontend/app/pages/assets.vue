<template>
 <div class="page asset-gallery-page">
  <div class="welcome-heading"><div><span class="soft-eyebrow">YOUR VISUAL WORLDS</span><h1>故事里的每个细节，都在这里。</h1><p>浏览项目的角色、场景与道具，进入项目继续编辑和生成。</p></div><BaseSelect class="gallery-project-select" v-model="selectedProject" :options="projects.map(p => ({ value: p.id, label: p.title }))" :disabled="!projects.length" aria-label="选择资产所属项目" /></div>
  <div class="gallery-controls"><div class="seg"><button v-for="kind in kinds" :key="kind.key" class="seg-item" :class="{on:filter===kind.key}" :aria-pressed="filter===kind.key" @click="filter=kind.key">{{kind.label}}</button></div><label class="gallery-search"><Search :size="16"/><input class="input" v-model.trim="search" placeholder="搜索资产…" aria-label="搜索资产"/></label><NuxtLink v-if="selectedProject" class="btn btn-primary" :to="`/drama/${selectedProject}?tab=assets`"><Pencil :size="14"/>管理项目资产</NuxtLink></div>
  <div v-if="loading" class="empty-state"><LoaderCircle class="animate-spin" :size="28"/><p>正在打开你的视觉世界…</p></div>
  <div v-else-if="error" class="empty-state" role="alert"><p>{{error}}</p><button class="btn" @click="loadProjects">重新加载</button></div>
  <div v-else-if="!projects.length" class="empty-state"><FolderKanban :size="32"/><h2>先为故事创建一个家。</h2><p>创建项目并提取资产后，角色和场景就会出现在这里。</p><NuxtLink class="btn btn-primary" to="/">前往创作台</NuxtLink></div>
  <div v-else-if="!visibleAssets.length" class="empty-state"><Images :size="32"/><h2>{{search?'没有找到匹配的资产':'这个世界，还等你来创造。'}}</h2><p>进入项目，提取角色、场景和道具，或手动添加资产。</p><NuxtLink class="btn" :to="`/drama/${selectedProject}?tab=assets`">进入项目资产</NuxtLink></div>
  <div v-else class="gallery-grid"><NuxtLink v-for="a in visibleAssets" :key="`${a.kind}-${a.id}`" :to="`/drama/${selectedProject}?tab=assets`" class="gallery-card card"><div class="gallery-art"><img v-if="imageOf(a)" :src="thumbOf(imageOf(a))" :alt="a.name" loading="lazy" @error="thumbFallback($event,imageOf(a))"/><span v-else class="gallery-initial">{{a.name?.slice(0,1)||'·'}}</span><span class="gallery-kind">{{a.kindLabel}}</span></div><div class="gallery-copy"><h2>{{a.name}}<ArrowUpRight :size="17"/></h2><p>{{a.appearance||a.description||a.prompt||'尚未填写视觉描述'}}</p><span>{{imageOf(a)?'图片已就绪':'等待生成'}}</span></div></NuxtLink></div>
 </div>
</template>
<script setup lang="ts">
import {Search,Pencil,LoaderCircle,FolderKanban,Images,ArrowUpRight} from 'lucide-vue-next'
import {dramaAPI,listAllDramas} from '~/composables/useApi'
import {thumbOf,thumbFallback} from '~/composables/useMedia'
const projects=ref<any[]>([]),selectedProject=ref<number|null>(null),detail=ref<any>(null),loading=ref(true),error=ref(''),filter=ref('all'),search=ref('')
const kinds=[{key:'all',label:'全部资产'},{key:'characters',label:'角色'},{key:'scenes',label:'场景'},{key:'props',label:'道具'}]
const visibleAssets=computed(()=>kinds.slice(1).flatMap(kind=>(detail.value?.[kind.key]||[]).map((a:any)=>({...a,name:a.name||a.location||'未命名资产',kind:kind.key,kindLabel:kind.label}))).filter(a=>(filter.value==='all'||a.kind===filter.value)&&[a.name,a.description,a.appearance].join(' ').includes(search.value)))
function imageOf(a:any){const src=a.image_url||a.imageUrl||a.local_path||a.localPath||'';return src&&!src.startsWith('/')&&!/^https?:\/\//i.test(src)?`/${src}`:src}
let requestId=0
async function loadDetail(id:number|null){const request=++requestId;if(!id){detail.value=null;loading.value=false;return}loading.value=true;error.value='';try{const result=await dramaAPI.get(id);if(request===requestId)detail.value=result}catch(e:any){if(request===requestId)error.value=e.message||'加载资产失败'}finally{if(request===requestId)loading.value=false}}
async function loadProjects(){loading.value=true;error.value='';try{projects.value=await listAllDramas();const id=projects.value.find(p=>p.id===selectedProject.value)?.id||projects.value[0]?.id||null;if(selectedProject.value===id)await loadDetail(id);else selectedProject.value=id}catch(e:any){error.value=e.message||'加载项目失败';loading.value=false}}
watch(selectedProject,loadDetail)
onMounted(loadProjects)
</script>
