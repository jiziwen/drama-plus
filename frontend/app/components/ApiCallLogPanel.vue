<template>
  <section class="call-panel">
    <div class="settings-head call-heading">
      <div><h2 class="settings-title">接口调用记录</h2><p class="settings-desc">查看文本、图片、视频和 ComfyUI 的请求与响应。相同请求默认合并展示，保留最近 5000 次原始调用。</p></div>
      <button class="btn" :disabled="loading" @click="load"><RefreshCw :size="14" :class="{ 'animate-spin': loading }" />刷新</button>
    </div>
    <form class="call-filters" @submit.prevent="search">
      <label class="field"><span class="field-label">服务商</span><select v-model="provider" class="input" @change="search"><option value="">全部</option><option v-for="p in providers" :key="p" :value="p">{{ p }}</option></select></label>
      <label class="field"><span class="field-label">状态</span><select v-model="status" class="input" @change="search"><option value="">全部</option><option value="success">成功</option><option value="error">失败</option><option value="pending">进行中</option></select></label>
      <label class="field"><span class="field-label">任务编号</span><input v-model="taskId" class="input" type="number" min="1" placeholder="全部任务" /></label>
      <label class="field call-keyword"><span class="field-label">接口地址</span><input v-model="keyword" class="input" placeholder="搜索接口路径，例如 /prompt" /></label>
      <button class="btn btn-primary" :disabled="loading">查询</button>
      <label class="call-group-toggle"><input v-model="grouped" type="checkbox" @change="search" />合并相同请求</label>
    </form>
    <p v-if="error" class="call-error" role="alert">{{ error }} <button class="btn btn-sm" @click="load">重试</button></p>
    <div class="call-table-wrap" :aria-busy="loading">
      <table class="call-table">
        <thead><tr><th>时间 / 服务</th><th>接口</th><th>任务</th><th>结果 / 耗时</th><th><span class="sr-only">操作</span></th></tr></thead>
        <tbody>
          <tr v-for="row in items" :key="row.id">
            <td><div>{{ formatTime(row.lastAt || row.createdAt) }}</div><span class="dim">{{ row.provider }} · {{ row.model || row.category }}</span><div v-if="row.callCount > 1" class="dim">首次 {{ formatTime(row.firstAt) }}</div></td>
            <td class="call-address"><span class="tag">{{ row.method }}</span><span :title="row.url">{{ shortUrl(row.url) }}</span><span v-if="row.callCount > 1" class="tag call-count">合并 {{ row.callCount }} 次</span></td>
            <td>{{ row.taskId ? `#${row.taskId}` : '—' }}</td>
            <td><span class="tag" :class="row.status === 'success' ? 'tag-success' : row.status === 'error' ? 'tag-error' : ''">{{ row.callCount > 1 ? '最新 ' : '' }}{{ statusLabel(row.status) }}{{ row.statusCode ? ` · ${row.statusCode}` : '' }}</span><div class="dim">{{ row.durationMs == null ? '等待响应' : `${(row.durationMs / 1000).toFixed(2)} 秒` }}</div><div v-if="row.callCount > 1" class="dim">成功 {{ row.successCount }} · 失败 {{ row.errorCount }}<template v-if="row.pendingCount"> · 进行中 {{ row.pendingCount }}</template></div></td>
            <td><button class="btn btn-sm" @click="openDetail(row, grouped)">查看详情</button></td>
          </tr>
          <tr v-if="!items.length"><td colspan="5" class="call-empty">{{ loading ? '正在加载调用记录…' : '暂无匹配的调用记录。发起生成或测试配置后，点击刷新查看。' }}</td></tr>
        </tbody>
      </table>
    </div>
    <div class="call-pagination"><span class="dim">{{ grouped ? `共 ${total} 组 · ${totalCalls} 次调用` : `共 ${total} 次调用` }} · 第 {{ page }} / {{ pages }} 页</span><button class="btn btn-sm" :disabled="page <= 1 || loading" @click="changePage(-1)">上一页</button><button class="btn btn-sm" :disabled="page >= pages || loading" @click="changePage(1)">下一页</button></div>
    <dialog ref="dialog" class="call-dialog" aria-labelledby="call-detail-title" @click="closeOnBackdrop" @close="detail = null">
      <div class="call-dialog-head"><div><h3 id="call-detail-title">调用详情 #{{ detail?.id }}<span v-if="detail?.group?.callCount > 1" class="tag call-count">相同请求 {{ detail.group.callCount }} 次</span></h3><p class="dim">{{ detail?.provider }} · {{ detail?.method }} · {{ detail?.operation || '' }} · {{ detail?.statusCode || statusLabel(detail?.status) }}</p></div><button class="btn btn-icon" aria-label="关闭调用详情" @click="dialog.close()"><X :size="18" /></button></div>
      <div class="call-detail-body">
        <p class="call-detail-url">{{ detail?.url }}</p>
        <p class="dim">{{ formatTime(detail?.createdAt) }} · {{ detail?.durationMs == null ? '请求进行中' : `${detail.durationMs} ms` }}{{ detail?.taskId ? ` · 生成任务 #${detail.taskId}` : '' }}</p>
        <p v-if="detailLoading" role="status">正在加载详情…</p>
        <p v-if="detailError" class="call-error" role="alert">{{ detailError }}</p>
        <p v-if="detail?.error" class="call-error">{{ detail.error }}</p>
        <p v-if="detail?.requestNote" class="call-request-note">{{ detail.requestNote }}</p>
        <div v-if="detail?.generationRequest" class="call-generation">
          <div class="call-generation-heading"><strong>关联的原始生成请求</strong><button v-if="detail.generationRequest.id" class="btn btn-sm" @click="openDetail(detail.generationRequest, false)">查看生成入参和响应</button></div>
          <p v-if="detail.generationRequest.prompt" class="call-prompt-preview">{{ detail.generationRequest.prompt }}</p>
          <template v-if="detail.generationRequest.source === 'task'"><p class="dim">原始提交记录已不在保留范围，以下为任务中保存的生成参数。</p><pre tabindex="0">{{ pretty(detail.generationRequest) }}</pre></template>
        </div>
        <div v-if="!detailLoading" class="call-payloads">
          <section><h4>入参 · 路径、查询参数与请求体</h4><pre tabindex="0">{{ pretty(detail?.request) }}</pre></section>
          <section><h4>出参 · 响应头与响应体</h4><pre tabindex="0">{{ pretty(detail?.response) }}</pre></section>
        </div>
        <details v-if="detail?.group?.callCount > 1" class="call-attempts">
          <summary>查看每次调用（{{ detail.group.callCount }} 次，展示最近 {{ detail.group.attempts.length }} 次）</summary>
          <p class="dim">首次 {{ formatTime(detail.group.firstAt) }} · 最近 {{ formatTime(detail.group.lastAt) }}；当前显示 #{{ detail.id }} 的响应。</p>
          <div v-for="attempt in detail.group.attempts" :key="attempt.id" class="call-attempt"><span>#{{ attempt.id }} · {{ formatTime(attempt.createdAt) }} · {{ statusLabel(attempt.status) }} {{ attempt.statusCode || '' }} · {{ attempt.durationMs ?? '—' }} ms</span><button class="btn btn-sm" :disabled="detailLoading" @click="openDetail(attempt, false)">查看本次</button></div>
        </details>
        <p class="dim">鉴权信息已隐藏。图片、音视频和 Base64 内容显示文件元信息；超过 1MB 的详情会标记截断。</p>
      </div>
    </dialog>
  </section>
</template>

<script setup>
import { computed, nextTick, onMounted, ref } from 'vue'
import { RefreshCw, X } from 'lucide-vue-next'
import { apiCallLogAPI } from '~/composables/useApi'
const providers = ['comfyui', 'openai', 'gemini', 'volcengine', 'minimax', 'aliyun']
const provider = ref(''), status = ref(''), keyword = ref(''), taskId = ref(''), page = ref(1)
const grouped = ref(true)
const items = ref([]), total = ref(0), totalCalls = ref(0), loading = ref(false), error = ref('')
const detail = ref(null), dialog = ref(null), detailLoading = ref(false), detailError = ref('')
const pages = computed(() => Math.max(1, Math.ceil(total.value / 25)))
const statusLabel = value => ({ success: '成功', error: '失败', pending: '进行中' }[value] || '—')
const pretty = value => value == null ? '暂无数据' : JSON.stringify(value, null, 2)
const formatTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : ''
function shortUrl(value) { try { const u = new URL(value); return u.pathname + u.search } catch { return value } }
let version = 0
let detailVersion = 0
async function load() {
  const current = ++version
  loading.value = true; error.value = ''
  try {
    const query = new URLSearchParams({ page: String(page.value), page_size: '25', grouped: grouped.value ? '1' : '0' })
    if (provider.value) query.set('provider', provider.value)
    if (status.value) query.set('status', status.value)
    if (keyword.value.trim()) query.set('keyword', keyword.value.trim())
    if (taskId.value) query.set('task_id', taskId.value)
    const result = await apiCallLogAPI.list(query)
    if (current !== version) return
    items.value = result.items; total.value = result.total; totalCalls.value = result.totalCalls
  } catch (e) { if (current === version) error.value = e.message }
  finally { if (current === version) loading.value = false }
}
function search() { page.value = 1; load() }
function changePage(delta) { page.value += delta; load() }
async function openDetail(row, merge = false) {
  detail.value = row; detailLoading.value = true; detailError.value = ''
  const current = ++detailVersion
  await nextTick(); if (!dialog.value.open) dialog.value.showModal()
  try { const result = await apiCallLogAPI.detail(row.id, merge); if (current === detailVersion) detail.value = result }
  catch (e) { if (current === detailVersion) detailError.value = e.message }
  finally { if (current === detailVersion) detailLoading.value = false }
}
function closeOnBackdrop(event) {
  if (event.target !== dialog.value) return
  const rect = dialog.value.getBoundingClientRect()
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.value.close()
}
onMounted(load)
</script>

<style scoped>
.call-panel { max-width: 1200px; }
.call-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
.call-heading h2 { margin:0; font-size:22px; }
.settings-desc,.dim { color:var(--text-3); font-size:12px; line-height:1.6; }
.call-filters { display:flex; gap:12px; align-items:end; margin:20px 0; flex-wrap:wrap; }
.call-filters .field { flex:1; min-width:120px; margin:0; }
.call-filters .call-keyword { flex:2; }
.call-group-toggle { display:flex; align-items:center; gap:7px; font-size:12px; min-height:36px; cursor:pointer; }
.call-count { margin-left:8px; white-space:nowrap; }
.call-table-wrap { overflow-x:auto; border:1px solid var(--border); border-radius:var(--radius-lg); background:var(--bg-1); }
.call-table { width:100%; border-collapse:collapse; text-align:left; font-size:12px; }
th,td { padding:13px 14px; border-bottom:1px solid var(--border); vertical-align:middle; }
th { color:var(--text-3); font-weight:600; background:var(--bg-2); }
td:first-child { min-width:150px; }
.call-address { max-width:430px; word-break:break-all; }
.call-address .tag { margin-right:8px; }
.call-empty { text-align:center; padding:40px 20px; color:var(--text-3); }
.call-pagination { display:flex; gap:10px; align-items:center; justify-content:flex-end; margin-top:16px; }
.call-pagination span { margin-right:auto; }
.call-error { color:var(--danger, #c43c35); overflow-wrap:anywhere; }
.call-dialog { width:min(1100px,94vw); max-height:90vh; margin:auto; padding:0; border:1px solid var(--border); border-radius:var(--radius-lg); color:var(--text-1); background:var(--bg-1); box-shadow:var(--shadow-elevated); }
.call-dialog::backdrop { background:var(--scrim, rgb(0 0 0 / .4)); backdrop-filter:blur(3px); }
.call-dialog-head { display:flex; align-items:center; justify-content:space-between; padding:18px 22px; border-bottom:1px solid var(--border); }
.call-dialog-head h3 { margin:0; font-size:17px; }
.call-dialog-head p { margin:4px 0 0; }
.call-detail-body { padding:18px 22px; overflow:auto; }
.call-detail-url { font-family:var(--font-mono,monospace); overflow-wrap:anywhere; }
.call-request-note { padding:10px 12px; border-radius:8px; background:var(--accent-bg); color:var(--text-1); font-size:12px; }
.call-generation { padding:14px; border:1px solid var(--border); border-radius:10px; margin:14px 0; }
.call-generation-heading,.call-attempt { display:flex; align-items:center; justify-content:space-between; gap:12px; font-size:12px; }
.call-prompt-preview { font-size:12px; line-height:1.7; max-height:110px; overflow:auto; white-space:pre-wrap; margin:10px 0 0; }
.call-attempts { margin-top:18px; font-size:12px; }
.call-attempts summary { cursor:pointer; padding:10px 0; font-weight:600; }
.call-attempt { padding:9px 0; border-bottom:1px solid var(--border); flex-wrap:wrap; }
.call-payloads { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
.call-payloads section { min-width:0; }
.call-payloads h4 { font-size:13px; }
pre { max-height:48vh; overflow:auto; padding:16px; background:var(--bg-2); border:1px solid var(--border); border-radius:10px; font-size:12px; line-height:1.6; white-space:pre-wrap; overflow-wrap:anywhere; }
@media(max-width:800px) { .call-payloads { grid-template-columns:1fr; } .call-filters .field { min-width:40%; } }
</style>
