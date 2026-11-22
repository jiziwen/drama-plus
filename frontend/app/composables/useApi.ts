import type { ScriptVideoPromptMode } from '../../../backend/src/services/video-prompt-mode'

const BASE = '/api/v1'

export function apiErrorMessage(payload: unknown, status: number): string {
  if (!payload || typeof payload !== 'object') return `请求失败（HTTP ${status}）`
  const data = payload as Record<string, any>
  const candidates = [data.message, data.error?.message, data.error?.error_msg, data.error_msg,
    typeof data.error === 'string' ? data.error : undefined, data.detail?.message, typeof data.detail === 'string' ? data.detail : undefined]
  return candidates.find(value => typeof value === 'string' && value.trim())?.trim() || `请求失败（HTTP ${status}）`
}

async function req<T = any>(method: string, path: string, body?: any, logBody = true): Promise<T> {
  const opts: RequestInit = body instanceof FormData
    ? { method, body }
    : { method, headers: { 'Content-Type': 'application/json' }, ...(body && { body: JSON.stringify(body) }) }

  const start = performance.now()
  console.log(`%c[API] %c${method} %c${path}`, 'color:#888', 'color:#4fc3f7;font-weight:bold', 'color:#ccc', logBody ? body || '' : '')

  try {
    const resp = await fetch(`${BASE}${path}`, opts)
    const json = await resp.json()
    const ms = Math.round(performance.now() - start)

    if (!resp.ok || (json.code && json.code >= 400)) {
      console.log(`%c[API] %c${method} ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold', 'color:#888', logBody ? json.message || '' : '')
      throw Object.assign(new Error(apiErrorMessage(json, resp.status)), { status: resp.status, reason: json.reason })
    }

    console.log(`%c[API] %c${method} ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#66bb6a', 'color:#66bb6a;font-weight:bold', 'color:#888')
    return json.data ?? json
  } catch (err: any) {
    if (!err.message?.match(/^\d{3}$/)) {
      const ms = Math.round(performance.now() - start)
      console.log(`%c[API] %c${method} ${path} %cERROR %c${ms}ms`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold', 'color:#888', logBody ? err.message : '')
    }
    throw err
  }
}

export const api = {
  get: <T = any>(p: string) => req<T>('GET', p),
  post: <T = any>(p: string, b?: any) => req<T>('POST', p, b),
  put: <T = any>(p: string, b?: any) => req<T>('PUT', p, b),
  del: <T = any>(p: string) => req<T>('DELETE', p),
}

export const promptModeAPI = {
  get: () => api.get<{ mode: ScriptVideoPromptMode }>('/settings/video-prompt-mode'),
  save: (mode: ScriptVideoPromptMode) => api.put<{ mode: ScriptVideoPromptMode }>('/settings/video-prompt-mode', { mode }),
}

export const libtvPhoneAPI = {
  send: (phone: string, accountId?: string) => req<{ challenge_id: string; expires_at: number }>(
    'POST', `/libtv/auth/phone/send${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''}`, { phone }, false,
  ),
  verify: <T>(challengeId: string, code: string, accountId?: string) => req<T>(
    'POST', `/libtv/auth/phone/verify${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''}`, { challenge_id: challengeId, code }, false,
  ),
}

export const apiCallLogAPI = {
  list: (query: URLSearchParams) => api.get(`/api-call-logs?${query}`),
  detail: (id: number, grouped = false) => api.get(`/api-call-logs/${id}?grouped=${grouped ? '1' : '0'}`),
}

export type FeedbackStatus = 'open' | 'in_progress' | 'resolved'

export interface FeedbackEntry {
  id: number
  title: string
  description: string
  contact: string
  pagePath: string
  submittedBy: string
  status: FeedbackStatus
  operatorNote: string
  revision: number
  createdAt: string
  screenshotCount: number
}

export const feedbackAPI = {
  access: () => api.get<{ canManage: boolean }>('/settings/feedback/access'),
  submit: (body: Pick<FeedbackEntry, 'title' | 'description' | 'contact' | 'pagePath'>, screenshots: readonly File[] = []) => {
    if (!screenshots.length) return req<{ id: number }>('POST', '/settings/feedback', body, false)
    const form = new FormData()
    for (const [name, value] of Object.entries(body)) form.set(name, value)
    for (const screenshot of screenshots) form.append('screenshots', screenshot)
    return req<{ id: number }>('POST', '/settings/feedback', form, false)
  },
  screenshotUrl: (id: number, position: number) => `${BASE}/settings/feedback/${id}/screenshots/${position}`,
  list: (params: URLSearchParams) => api.get<{ items: FeedbackEntry[]; total: number; pageSize: number }>(`/settings/feedback/manage?${params}`),
  save: (id: number, body: Pick<FeedbackEntry, 'status' | 'operatorNote' | 'revision'>) => req<FeedbackEntry>('PUT', `/settings/feedback/manage/${id}`, body, false),
}

export interface ReleaseNote {
  id: number
  title: string
  changes: string[]
  publishedAt: string
}

export const releaseNotesAPI = {
  list: () => api.get<{ items: ReleaseNote[] }>('/settings/release-notes'),
  access: () => api.get<{ canPublish: boolean }>('/settings/release-notes/access'),
  publish: (body: Pick<ReleaseNote, 'title' | 'changes'> & { requestId: string }) =>
    req<ReleaseNote>('POST', '/settings/release-notes', body, false),
}

export const localRuntimeAPI = {
  status: () => api.get('/local-runtime'),
  configure: (enabled: boolean) => api.put('/local-runtime', { enabled }),
  ensureComfyui: () => api.post('/local-runtime/ensure-comfyui', {}),
}

export const dramaAPI = {
  list: (page = 1) => api.get<{ items: any[]; pagination?: { total_pages: number } }>(page === 1 ? '/dramas' : `/dramas?page=${page}`),
  get: (id: number) => api.get(`/dramas/${id}`),
  create: (data: any) => api.post('/dramas', data),
  update: (id: number, data: any) => api.put(`/dramas/${id}`, data),
  del: (id: number) => api.del(`/dramas/${id}`),
}

/** Follow the existing paginated endpoint for workspaces that show every project. */
export async function listAllDramas(): Promise<any[]> {
  const first = await dramaAPI.list()
  const items = [...first.items]
  for (let page = 2; page <= (first.pagination?.total_pages || 1); page++) {
    items.push(...(await dramaAPI.list(page)).items)
  }
  return items
}

export const episodeAPI = {
  create: (data: any) => api.post('/episodes', data),
  update: (id: number, data: any) => api.put(`/episodes/${id}`, data),
  del: (id: number) => api.del(`/episodes/${id}`),
  characters: (id: number) => api.get(`/episodes/${id}/characters`),
  scenes: (id: number) => api.get(`/episodes/${id}/scenes`),
  props: (id: number) => api.get(`/episodes/${id}/props`),
  storyboards: (id: number) => api.get(`/episodes/${id}/storyboards`),
  pipelineStatus: (id: number) => api.get(`/episodes/${id}/pipeline-status`),
  extract: (id: number, target: string, model?: string, configId?: number) => api.post(`/episodes/${id}/extract`, { target, model: model || undefined, config_id: configId || undefined }),
  extractStatus: (id: number) => api.get(`/episodes/${id}/extract-status`),
  generateVideoPrompts: (id: number, model?: string, configId?: number, storyboardIds?: number[]) => api.post(`/episodes/${id}/generate-video-prompts`, { model: model || undefined, config_id: configId || undefined, storyboard_ids: storyboardIds?.length ? storyboardIds : undefined }),
  videoPromptsStatus: (id: number) => api.get(`/episodes/${id}/video-prompts-status`),
}

export const storyboardAPI = {
  create: (data: any) => api.post('/storyboards', data),
  update: (id: number, data: any) => api.put(`/storyboards/${id}`, data),
  del: (id: number) => api.del(`/storyboards/${id}`),
  trash: (episodeId: number) => api.get(`/storyboards/trash?episode_id=${episodeId}`),
  restore: (id: number) => api.post(`/storyboards/${id}/restore`),
}

export interface AssetImageOptions {
  generation_mode?: 'text' | 'reference'
  reference_images?: string[]
  edit_prompt?: string
}

export const characterAPI = {
  create: (data: any) => api.post('/characters', data),
  update: (id: number, data: any) => api.put(`/characters/${id}`, data),
  del: (id: number) => api.del(`/characters/${id}`),
  generatePrompt: (id: number, episodeId: number, force = false, textModel?: string, textConfigId?: number) => api.post(`/characters/${id}/generate-prompt`, { episode_id: episodeId, force, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  generateImage: (id: number, episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number, options: AssetImageOptions = {}) => api.post(`/characters/${id}/generate-image`, { episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined, ...options }),
  batchImages: (ids: number[], episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number) => api.post('/characters/batch-generate-images', { character_ids: ids, episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
}

export const sceneAPI = {
  create: (data: any) => api.post('/scenes', data),
  update: (id: number, data: any) => api.put(`/scenes/${id}`, data),
  del: (id: number) => api.del(`/scenes/${id}`),
  generatePrompt: (id: number, episodeId: number, force = false, textModel?: string, textConfigId?: number) => api.post(`/scenes/${id}/generate-prompt`, { episode_id: episodeId, force, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  generateImage: (id: number, episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number, options: AssetImageOptions = {}) => api.post(`/scenes/${id}/generate-image`, { episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined, ...options }),
}

export const propAPI = {
  create: (data: any) => api.post('/props', data),
  update: (id: number, data: any) => api.put(`/props/${id}`, data),
  del: (id: number) => api.del(`/props/${id}`),
  generatePrompt: (id: number, episodeId: number, force = false, textModel?: string, textConfigId?: number) => api.post(`/props/${id}/generate-prompt`, { episode_id: episodeId, force, text_model: textModel || undefined, text_config_id: textConfigId || undefined }),
  generateImage: (id: number, episodeId: number, model?: string, configId?: number, textModel?: string, textConfigId?: number, options: AssetImageOptions = {}) => api.post(`/props/${id}/generate-image`, { episode_id: episodeId, model: model || undefined, config_id: configId || undefined, text_model: textModel || undefined, text_config_id: textConfigId || undefined, ...options }),
}

// 统一生成任务（图片/视频）：POST 带 type 字段，列表按 type 过滤
export const taskAPI = {
  generate: (d: any) => api.post('/tasks', d),
  recover: (id: number) => api.post(`/tasks/${id}/recover`),
  diagnostics: (id: number) => api.get(`/tasks/${id}/diagnostics`),
  get: (id: number) => api.get(`/tasks/${id}`),
  del: (id: number) => api.del(`/tasks/${id}`),
  list: (params?: { type?: 'image' | 'video'; drama_id?: number; storyboard_id?: number; character_id?: number; scene_id?: number; prop_id?: number }) => {
    const query = new URLSearchParams()
    if (params?.type) query.set('type', params.type)
    if (params?.drama_id) query.set('drama_id', String(params.drama_id))
    if (params?.storyboard_id) query.set('storyboard_id', String(params.storyboard_id))
    for (const key of ['character_id', 'scene_id', 'prop_id'] as const) if (params?.[key]) query.set(key, String(params[key]))
    return api.get(`/tasks${query.size ? `?${query.toString()}` : ''}`)
  },
  // 按集聚合生成任务（sys_task + video_merges）
  listByEpisode: (episodeId: number) => api.get<{ tasks: any[]; merges: any[] }>(`/episodes/${episodeId}/generation-tasks`),
}

async function uploadReq<T = any>(path: string, file: File): Promise<T> {
  const fd = new FormData()
  fd.append('file', file)
  console.log(`%c[API] %cPOST %c${path} %c${file.name}`, 'color:#888', 'color:#4fc3f7;font-weight:bold', 'color:#ccc', 'color:#888')
  const resp = await fetch(`${BASE}${path}`, { method: 'POST', body: fd })
  const json = await resp.json()
  if (!resp.ok || (json.code && json.code >= 400)) {
    console.log(`%c[API] %cPOST ${path} %c${resp.status}`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold')
    throw new Error(json.message || `${resp.status}`)
  }
  return json.data ?? json
}

export const uploadAPI = {
  image: (f: File) => uploadReq<{ url: string; path: string }>('/upload/image', f),
  video: (f: File) => uploadReq<{ url: string; path: string }>('/upload/video', f),
  audio: (f: File) => uploadReq<{ url: string; path: string }>('/upload/audio', f),
}
export const mergeAPI = {
  merge: (epId: number, storyboardIds?: number[]) => api.post(`/merge/episodes/${epId}/merge`, storyboardIds?.length ? { storyboard_ids: storyboardIds } : {}),
  status: (epId: number) => api.get(`/merge/episodes/${epId}/merge`),
  list: (epId: number) => api.get<any[]>(`/merge/episodes/${epId}/merges`),
}
export const aiConfigAPI = {
  list: (t?: string) => api.get(`/ai-configs${t ? `?service_type=${t}` : ''}`),
  create: (d: any) => api.post('/ai-configs', d),
  update: (id: number, d: any) => api.put(`/ai-configs/${id}`, d),
  del: (id: number) => api.del(`/ai-configs/${id}`),
  test: (d: any) => api.post('/ai-configs/test', d),
}

export const promptAPI = {
  list: () => api.get('/prompts'),
  get: (type: string) => api.get(`/prompts/${type}`),
  update: (type: string, d: any) => api.put(`/prompts/${type}`, d),
  reset: (type: string) => api.post(`/prompts/${type}/reset`),
}

export const skillsAPI = {
  list: () => api.get(`/skills`),
  get: (id: string) => api.get(`/skills/${id}`),
  create: (data: { id: string; name: string; description?: string }) => api.post('/skills', data),
  update: (id: string, content: string) => api.put(`/skills/${id}`, { content }),
  del: (id: string) => api.del(`/skills/${id}`),
}

export const stylePresetAPI = {
  list: (all = false) => api.get(`/style-presets${all ? '?all=1' : ''}`),
  create: (d: any) => api.post('/style-presets', d),
  update: (id: number, d: any) => api.put(`/style-presets/${id}`, d),
  del: (id: number) => api.del(`/style-presets/${id}`),
}

export const storageAPI = {
  info: () => api.get('/storage'),
}
