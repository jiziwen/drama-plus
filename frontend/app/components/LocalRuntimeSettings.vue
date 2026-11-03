<template>
  <section v-if="state.supported" class="card runtime-card">
    <div><h3>本地 ComfyUI 联动启动</h3><p class="dim">开启后，每次打开火宝页面会通知 Windows 本机助手启动整合包；已运行时直接复用。</p></div>
    <label class="runtime-toggle"><input type="checkbox" :checked="state.enabled" :disabled="saving" @change="toggle($event.target.checked)" />打开火宝时自动启动 ComfyUI</label>
    <div class="runtime-actions"><span class="tag" :class="state.available && state.status === 'ready' ? 'tag-success' : ''">{{ label }}</span><button class="btn btn-sm" :disabled="starting || !state.available || !state.enabled" @click="start">立即启动</button><button class="btn btn-sm" @click="refresh">刷新状态</button><a class="btn btn-sm" :href="`http://127.0.0.1:${state.port || 8188}`" target="_blank" rel="noopener">打开 ComfyUI</a></div>
    <p v-if="!state.available" class="dim">本机助手未运行，请使用桌面的“火宝短剧”快捷方式启动。</p>
    <p v-if="error || state.error" role="alert" class="runtime-error">{{ error || state.error }}</p>
  </section>
</template>
<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { localRuntimeAPI } from '~/composables/useApi'
const state = ref({}), saving = ref(false), starting = ref(false), error = ref('')
const label = computed(() => {
  if (!state.value.available) return '助手离线'
  return { ready: 'ComfyUI 已运行', starting: '正在启动整合包', idle: '整合包未运行', error: '启动失败' }[state.value.status] || '等待状态'
})
async function refresh() { try { state.value = await localRuntimeAPI.status(); error.value = '' } catch (e) { error.value = e.message } }
async function toggle(value) { saving.value = true; try { await localRuntimeAPI.configure(value); await refresh() } catch (e) { error.value = e.message } finally { saving.value = false } }
async function start() { starting.value = true; try { const result = await localRuntimeAPI.ensureComfyui(); if (result.message) error.value = result.message; await refresh() } catch (e) { error.value = e.message } finally { starting.value = false } }
let timer
onMounted(() => { refresh(); timer = setInterval(refresh, 5000) })
onUnmounted(() => clearInterval(timer))
</script>
<style scoped>
.runtime-card { margin-top:16px; padding:20px; }
h3 { margin:0 0 8px; font-size:15px; }
.dim { color:var(--text-3); font-size:12px; line-height:1.6; }
.runtime-toggle { display:flex; gap:8px; align-items:center; margin:16px 0; font-size:13px; cursor:pointer; }
.runtime-actions { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.runtime-error { color:var(--danger, #c43c35); font-size:12px; overflow-wrap:anywhere; }
</style>
