import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import * as vue from 'vue'
import ts from 'typescript'
import { parse, compileScript } from '@vue/compiler-sfc'
import { useVideoCliAccount } from '../app/composables/useVideoCliAccount'
const filename = 'SettingsContent.vue'
const { descriptor } = parse(readFileSync(new URL('../app/components/SettingsContent.vue', import.meta.url), 'utf8'), { filename })
const compiled = compileScript(descriptor, { id: 'cli-actions', inlineTemplate: true })
const { outputText } = ts.transpileModule(compiled.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
type Host = EventTarget & { tag: string; text: string; children: Host[]; props: Record<string, any>; parent?: Host }
const node = (tag: string, text = '') => Object.assign(new EventTarget(), { tag, text, children: [] as Host[], props: {} as Record<string, any> })
const all = (root: Host): Host[] => [root, ...root.children.flatMap(all)]
const text = (root: Host): string => root.text + root.children.map(text).join('')
const settle = async () => { for (let i = 0; i < 35; i++) await vue.nextTick() }
const click = (button: Host) => button.props.onClick?.({ target: button, currentTarget: button, preventDefault() {}, stopPropagation() {} })
async function mount(t: any, provider: 'jimeng' | 'libtv', accountState: Record<string, unknown>, openExisting = true, configOverrides: Record<string, unknown> = {}, promptOptions: { mode?: 'reference-guide' | 'inline'; initialTab?: string; readError?: string; saveError?: string } = {}) {
 const previousFetch = globalThis.fetch
 for (const name of ['Document', 'ShadowRoot']) {
  if (name in globalThis) continue
  Object.defineProperty(globalThis, name, { value: class {}, configurable: true })
  t.after(() => Reflect.deleteProperty(globalThis, name))
 }
 const accounts = [{ id: 'empty-slot', name: '未授权账号' }, { id: 'other-slot', name: '另一个账号' }]
 const configs = [
  { id: 1, provider, name: '视频服务', service_type: 'video', model: [], is_active: true, video_cli_account_id: 'empty-slot', ...configOverrides },
  { id: 2, provider, name: '其他视频服务', service_type: 'video', model: [], is_active: true, video_cli_account_id: 'other-slot' },
 ]
 let cli: ReturnType<typeof useVideoCliAccount>
 const calls: { method: string; path: string }[] = []
 const writes: { method: string; id?: number; payload: Record<string, unknown> }[] = []
 const modeCalls: { method: string; mode?: string }[] = []
 const modeState = { mode: promptOptions.mode || 'reference-guide', readError: promptOptions.readError || '', saveError: promptOptions.saveError || '' }
 const notifications: string[] = []
 globalThis.fetch = async (input, init) => {
  const url = new URL(String(input), 'http://localhost'); const method = init?.method || 'GET'
  calls.push({ method, path: url.pathname + url.search })
  if (url.pathname === `/api/v1/${provider}/accounts`) return Response.json({ data: { accounts, activeAccountId: 'other-slot' } })
  return Response.json({ data: { available: true, authenticated: false, can_authorize: true, ...accountState } })
 }
 const passthrough = { setup(_props: unknown, { slots }: any) { return () => vue.h('span', {}, slots.default?.()) } }
 const baseSelect = vue.defineComponent({
  props: ['modelValue', 'options', 'ariaLabel', 'disabled'], emits: ['update:modelValue'],
  setup(props, { emit }) {
   return () => vue.h('select', { value: props.modelValue, 'aria-label': props.ariaLabel, disabled: props.disabled,
    onChange: (event: any) => emit('update:modelValue', event.target.value) },
   (props.options || []).map((option: any) => vue.h('option', { value: option.value ?? option }, String(option.label ?? option))))
  },
 })
 const readApi = new Proxy({}, { get: (_target, method) => async () => method === 'get' ? {} : [] })
 const imports: Record<string, unknown> = {
  vue, 'lucide-vue-next': new Proxy({}, { get: () => passthrough }),
  '~/components/BaseSelect.vue': { default: baseSelect }, '~/components/FeedbackPanel.vue': { default: passthrough },
  'vue-sonner': { toast: { success(message: string) { notifications.push(message) }, warning() {} } }, '~/composables/useToast': { toastError(error: unknown) { throw error } },
  'vue-i18n': { useI18n: () => ({ t: (key: string) => key }) },
  '~/composables/useApi': { aiConfigAPI: {
   list: async () => [...configs],
   create: async (payload: Omit<(typeof configs)[number], 'id' | 'is_active' | 'video_cli_account_id'>) => {
    assert.equal(payload.provider, provider)
    writes.push({ method: 'POST', payload: structuredClone(payload) })
    const config = { ...payload, id: 3, is_active: true, video_cli_account_id: 'new-slot' }
    accounts.push({ id: 'new-slot', name: '新账号' })
    configs.push(config)
    return config
   },
   update: async (id: number, payload: Record<string, unknown>) => {
    writes.push({ method: 'PUT', id, payload: structuredClone(payload) })
    const config = configs.find(config => config.id === id)!
    Object.assign(config, payload)
    return { ...config }
   },
  }, promptModeAPI: {
   get: async () => {
    modeCalls.push({ method: 'GET' })
    if (modeState.readError) throw new Error(modeState.readError)
    return { mode: modeState.mode }
   },
   save: async (mode: 'reference-guide' | 'inline') => {
    modeCalls.push({ method: 'PUT', mode })
    if (modeState.saveError) throw new Error(modeState.saveError)
    modeState.mode = mode
    return { mode }
   },
  }, api: {}, promptAPI: readApi, skillsAPI: readApi, storageAPI: readApi, stylePresetAPI: readApi, releaseNotesAPI: { access: async () => ({ canPublish: false }) } },
  '~/composables/useVideoCliAccount': { useVideoCliAccount: (...args: Parameters<typeof useVideoCliAccount>) => {
   cli = useVideoCliAccount(...args)
   return cli
  } },
  '~/composables/useDesktopBridge': { useDesktopBridge: () => null }, '~/composables/useMigrateState': { useMigrateState: () => ({}) },
  '~/composables/useSiteSession': { useSiteSession: () => ({ account: vue.ref(null) }) },
  '~/composables/useTheme': { useTheme: () => ({ themeMode: vue.ref('dark'), setThemeMode() {} }) },
  '~/composables/useProviderIcon': { providerIconUrl: () => '' }, '~/composables/useTour': { startTour() {}, autoTour() {} },
  '../../../backend/src/services/libtv-video-models': { libtvVideoModels: [] },
 }
 const exported: { default?: vue.Component } = {}
 runInNewContext(outputText, { ...vue, exports: exported, require(id: string) { assert.ok(id in imports, id); return imports[id] }, useRoute: () => ({ query: {} }), useModelLabel: () => (value: unknown) => value, setTimeout, clearTimeout, setInterval, clearInterval }, { filename })
 const host = node('root')
 const renderer = vue.createRenderer<Host, Host>({
  createElement: tag => Object.assign(node(tag), { tagName: tag.toUpperCase(), value: '', type: 'text', setAttribute() {}, removeAttribute() {}, getRootNode: () => host }),
  createText: value => node('#text', value), createComment: () => node('#comment'),
  setText(element, value) { element.text = value }, setElementText(element, value) { element.text = value; element.children = [] },
  parentNode: element => element.parent || null,
  nextSibling(element) { const siblings = element.parent?.children || []; return siblings[siblings.indexOf(element) + 1] || null },
  insert(element, parent, anchor) {
   if (element.parent) { const old = element.parent.children.indexOf(element); if (old >= 0) element.parent.children.splice(old, 1) }
   const index = anchor ? parent.children.indexOf(anchor) : -1
   if (index < 0) parent.children.push(element); else parent.children.splice(index, 0, element)
   element.parent = parent
  },
  remove(element) { const siblings = element.parent?.children; if (siblings) siblings.splice(siblings.indexOf(element), 1) },
  patchProp(element, key, _before, after) { element.props[key] = after; if (key === 'value') (element as any).value = after },
 })
 const app = renderer.createApp(exported.default!, { embedded: true, configId: openExisting ? 1 : undefined, initialTab: promptOptions.initialTab || 'ai' })
 app.config.warnHandler = () => {}
 for (const name of ['ConfirmDialog', 'LocalRuntimeSettings', 'ApiCallLogPanel', 'ReleaseNotesSettings']) app.component(name, passthrough)
 app.mount(host)
 t.after(() => { app.unmount(); globalThis.fetch = previousFetch })
 await settle()
 const section = () => all(host).find(element => element.props['aria-labelledby'] === 'video-cli-account-label')!
 if (openExisting) assert.ok(section(), '真实设置组件应打开账号面板')
 return { host, calls, writes, configs, modeCalls, modeState, notifications, section, get cli() { return cli! },
  submit: async () => {
   const dialog = all(host).find(element => element.tag === 'form' && element.props.onSubmit)!
   assert.ok(dialog)
   await dialog.props.onSubmit({ preventDefault() {} })
   await settle()
  },
  buttons: () => all(section()).filter(element => element.tag === 'button' || element.tag === 'a') }
}

const promptMode = (host: Host) => all(host).find(element => element.tag === 'select' && element.props['aria-label'] === 'settings.promptMode.mode')

test('LibTV 已有网页授权链接时再次点击仍向服务端确认当前挑战', async t => {
 const component = await mount(t, 'libtv', { authenticated: false, status: 'pending',
  verification_url: 'https://www.liblib.tv/?callback_url=current-challenge', expires_at: Date.now() + 300_000 })
 const authorize = component.buttons().find(button => text(button) === 'settings.cliAccount.authorizeWeb')!
 assert.ok(authorize)
 assert.equal(authorize.tag, 'button', '不能直接重开缓存中的旧挑战链接')
 await click(authorize)
 await settle()
 assert.ok(component.calls.some(call => call.method === 'POST' && call.path === '/api/v1/libtv/auth/start?accountId=empty-slot'))
})

test('提示词入参模式是独立设置菜单，无需账号或视频配置即可读取默认值', async t => {
 const component = await mount(t, 'jimeng', { authenticated: false }, false)
 const menu = all(component.host).find(element => element.tag === 'button' && text(element).trim() === 'settings.tabs.promptMode')!
 assert.ok(menu)
 assert.deepEqual(component.modeCalls, [], '进入独立菜单前不读写全局模式')
 click(menu)
 await settle()
 const select = promptMode(component.host)
 assert.ok(select, '独立面板提供提示词入参模式')
 assert.equal(select.props.value, 'reference-guide')
 assert.deepEqual(select.children.map(option => option.props.value), ['reference-guide', 'inline'])
 assert.match(text(component.host), /settings\.promptMode\.referenceGuideDesc/u)
 assert.deepEqual(component.modeCalls, [{ method: 'GET' }])
 assert.equal(component.section(), undefined, '模式面板不依赖账号面板')
 assert.deepEqual(component.calls, [], '模式面板不访问即梦账号')
 assert.deepEqual(component.writes, [])
})

test('直接打开全局模式菜单可读取已保存模式，修改保存后重新进入仍生效', async t => {
 const component = await mount(t, 'jimeng', { authenticated: false }, false, {}, { mode: 'inline', initialTab: 'prompt-mode' })
 const select = promptMode(component.host)
 assert.equal(select?.props.value, 'inline')
 assert.match(text(component.host), /settings\.promptMode\.inlineDesc/u)
 select!.props.onChange({ target: { value: 'reference-guide' } })
 await settle()
 await component.submit()
 assert.deepEqual(component.modeCalls, [{ method: 'GET' }, { method: 'PUT', mode: 'reference-guide' }])
 assert.equal(component.modeState.mode, 'reference-guide')
 assert.deepEqual(component.notifications, ['common.saved'])
 assert.ok(all(component.host).some(element => element.props.role === 'status' && text(element) === 'common.saved'))
 click(all(component.host).find(element => element.tag === 'button' && text(element).trim() === 'settings.tabs.ai')!)
 await settle()
 click(all(component.host).find(element => element.tag === 'button' && text(element).trim() === 'settings.tabs.promptMode')!)
 await settle()
 assert.equal(promptMode(component.host)?.props.value, 'reference-guide')
 assert.equal(component.modeCalls.filter(call => call.method === 'GET').length, 2)
 assert.deepEqual(component.writes, [], '保存模式不修改任何AI服务配置')
})

test('全局模式读取失败禁止覆盖默认值，重新读取及保存失败都有明确反馈', async t => {
 const component = await mount(t, 'jimeng', { authenticated: false }, false, {}, { initialTab: 'prompt-mode', readError: '读取模式失败' })
 assert.ok(all(component.host).some(element => element.props.role === 'alert' && text(element).includes('读取模式失败')))
 assert.equal(promptMode(component.host)?.props.disabled, true)
 await component.submit()
 assert.deepEqual(component.modeCalls, [{ method: 'GET' }], '读取失败不能将界面默认值写回服务器')
 component.modeState.readError = ''
 click(all(component.host).find(element => element.tag === 'button' && text(element) === 'settings.promptMode.retry')!)
 await settle()
 assert.equal(promptMode(component.host)?.props.disabled, false)
 promptMode(component.host)!.props.onChange({ target: { value: 'inline' } })
 await settle()
 component.modeState.saveError = '保存模式失败'
 await component.submit()
 assert.ok(all(component.host).some(element => element.props.role === 'alert' && text(element).includes('保存模式失败')))
 assert.equal(component.modeState.mode, 'reference-guide')
 assert.equal(promptMode(component.host)?.props.value, 'inline', '保存失败保留用户选择供重试')
 assert.deepEqual(component.notifications, [])
 component.modeState.saveError = ''
 await component.submit()
 assert.equal(component.modeState.mode, 'inline')
 assert.deepEqual(component.notifications, ['common.saved'])
})

test('新增视频服务配置不再展示或保存提示词模式', async t => {
 for (const provider of ['jimeng', 'libtv'] as const) {
  await t.test(provider, async t => {
   const component = await mount(t, provider, { authenticated: false }, false)
   click(all(component.host).find(element => element.tag === 'button' && text(element) === 'common.serviceType.video')!)
   await settle()
   click(all(component.host).find(element => element.tag === 'button' && text(element) === (provider === 'jimeng' ? '即梦积分 · 官方 CLI' : 'LibTV · 官方 CLI'))!)
   await settle()
   assert.equal(promptMode(component.host), undefined)
   await component.submit()
   assert.ok(!Object.hasOwn(component.writes[0]!.payload, 'jimeng_prompt_mode'))
   assert.deepEqual(component.modeCalls, [])
  })
 }
})

test('编辑视频服务配置不再读取或写入旧配置中的提示词模式', async t => {
 for (const provider of ['jimeng', 'libtv'] as const) {
  await t.test(provider, async t => {
   const component = await mount(t, provider, { authenticated: true }, true, { jimeng_prompt_mode: 'inline' })
   assert.equal(promptMode(component.host), undefined)
   await component.submit()
   assert.ok(!Object.hasOwn(component.writes[0]!.payload, 'jimeng_prompt_mode'))
   assert.deepEqual(component.modeCalls, [])
  })
 }
})

test('非视频配置不展示或提交即梦提示词模式', async t => {
 const component = await mount(t, 'jimeng', { authenticated: true }, true, { service_type: 'text', jimeng_prompt_mode: 'inline' })
 assert.equal(promptMode(component.host), undefined)
 await component.submit()
 assert.ok(!Object.hasOwn(component.writes[0]!.payload, 'jimeng_prompt_mode'))
})
for (const provider of ['jimeng', 'libtv'] as const) {
 for (const [name, state] of [
  ['CLI不可用', { available: false, can_authorize: false, message: '服务端尚未安装官方 CLI' }],
  ['授权失败', { status: 'failed' }], ['等待授权且链接丢失', { status: 'pending' }],
 ] as const) test(`${provider} ${name}仍显示明确网页授权入口`, async t => {
  const component = await mount(t, provider, state)
  const authorize = component.buttons().find(button => /(?:settings\.(?:jimeng|libtv)\.(?:connect|openAuthorization)|settings\.cliAccount\.(?:authorize|webAuthorization|authorizeWeb|webAuthorize)|前往网页授权)/u.test(text(button)))
  assert.ok(authorize, '网页授权入口不能被账号可用性或临时状态隐藏')
  assert.notEqual(authorize.props.disabled, true, '失效或未完成的授权必须允许重新发起')
  await click(authorize)
  await settle()
  assert.ok(component.calls.some(call => call.method === 'POST' && call.path === `/api/v1/${provider}/auth/start?accountId=empty-slot`), '点击网页授权必须实际请求当前账号授权，不能静默返回')
 })
 test(`${provider}编辑弹窗只显示所编辑配置绑定的账号`, async t => {
  const component = await mount(t, provider, { available: false, can_authorize: false })
  assert.match(text(component.section()), /未授权账号/u)
  assert.doesNotMatch(text(component.section()), /另一个账号|settings\.cliAccount\.(?:add|selected|remove)/u)
  assert.deepEqual(component.cli.accounts.value.map(account => account.id), ['empty-slot'])
  const detailCalls = component.calls.filter(call => call.path.includes('/account?'))
  assert.ok(detailCalls.length)
  assert.ok(detailCalls.every(call => call.path === `/api/v1/${provider}/account?accountId=empty-slot`))
 })
 test(`${provider}新增弹窗保存后只显示新账号`, async t => {
  const component = await mount(t, provider, { authenticated: false }, false)
  const videoTemplate = all(component.host).find(element => element.tag === 'button' && text(element) === 'common.serviceType.video')!
  assert.ok(videoTemplate)
  click(videoTemplate)
  await settle()
  const presetName = provider === 'jimeng' ? '即梦积分 · 官方 CLI' : 'LibTV · 官方 CLI'
  const providerPreset = all(component.host).find(element => element.tag === 'button' && text(element) === presetName)!
  assert.ok(providerPreset)
  click(providerPreset)
  await settle()
  assert.match(text(component.section()), /settings\.cliAccount\.saveToConnect/u)
  assert.doesNotMatch(text(component.section()), /未授权账号|另一个账号|settings\.cliAccount\.(?:add|selected)/u)
  assert.deepEqual(component.calls, [])
  const dialog = all(component.host).find(element => element.tag === 'form' && element.props.onSubmit)!
  assert.ok(dialog)
  await dialog.props.onSubmit({ preventDefault() {} })
  await settle()
  assert.match(text(component.section()), /新账号/u)
  assert.doesNotMatch(text(component.section()), /未授权账号|另一个账号|settings\.cliAccount\.(?:add|selected)/u)
  assert.deepEqual(component.cli.accounts.value.map(account => account.id), ['new-slot'])
  assert.ok(component.calls.some(call => call.path === `/api/v1/${provider}/account?accountId=new-slot`))
  assert.ok(!component.calls.some(call => call.path.includes('empty-slot') || call.path.includes('other-slot') || call.path.endsWith('/activate')))
 })
}
