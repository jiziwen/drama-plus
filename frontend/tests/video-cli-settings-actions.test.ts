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
async function mount(t: any, provider: 'jimeng' | 'libtv', accountState: Record<string, unknown>, failNextAccountRead = false) {
 const previousFetch = globalThis.fetch
 let accounts = [{ id: 'empty-slot', name: '未授权账号' }]
 if (failNextAccountRead) accounts.push({ id: 'remaining-slot', name: '另一个账号' })
 let deleted = false
 let cli: ReturnType<typeof useVideoCliAccount>
 let removalResult: boolean | undefined
 const calls: { method: string; path: string }[] = []
 globalThis.fetch = async (input, init) => {
  const url = new URL(String(input), 'http://localhost'); const method = init?.method || 'GET'
  calls.push({ method, path: url.pathname + url.search })
  if (url.pathname === `/api/v1/${provider}/accounts`) return Response.json({ data: { accounts, activeAccountId: accounts[0]?.id } })
  if (method === 'DELETE') {
   accounts = accounts.filter(account => account.id !== 'empty-slot')
   deleted = true
   return Response.json({ data: { activeAccountId: accounts[0]?.id || 'default' } })
  }
  if (deleted && failNextAccountRead) return Response.json({ message: '剩余账号状态暂时无法读取' }, { status: 503 })
  return Response.json({ data: { available: true, authenticated: false, can_authorize: true, ...accountState } })
 }
 const passthrough = { setup(_props: unknown, { slots }: any) { return () => vue.h('span', {}, slots.default?.()) } }
 const readApi = new Proxy({}, { get: (_target, method) => async () => method === 'get' ? {} : [] })
 const imports: Record<string, unknown> = {
  vue, 'lucide-vue-next': new Proxy({}, { get: () => passthrough }),
  '~/components/BaseSelect.vue': { default: passthrough }, '~/components/FeedbackPanel.vue': { default: passthrough },
  'vue-sonner': { toast: { success() {}, warning() {} } }, '~/composables/useToast': { toastError(error: unknown) { throw error } },
  'vue-i18n': { useI18n: () => ({ t: (key: string) => key }) },
  '~/composables/useApi': { aiConfigAPI: { list: async () => [{ id: 1, provider, name: '视频服务', service_type: 'video', model: [], is_active: true }] }, api: {}, promptAPI: readApi, skillsAPI: readApi, storageAPI: readApi, stylePresetAPI: readApi, releaseNotesAPI: { access: async () => ({ canPublish: false }) } },
  '~/composables/useVideoCliAccount': { useVideoCliAccount: (...args: Parameters<typeof useVideoCliAccount>) => {
   cli = useVideoCliAccount(...args)
   return { ...cli, removeAccount: async () => { removalResult = await cli.removeAccount(); return removalResult } }
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
  createElement: tag => Object.assign(node(tag), { tagName: tag.toUpperCase(), value: '', type: 'text', setAttribute() {}, removeAttribute() {} }),
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
 const app = renderer.createApp(exported.default!, { embedded: true, configId: 1, initialTab: 'ai' })
 app.config.warnHandler = () => {}
 for (const name of ['ConfirmDialog', 'LocalRuntimeSettings', 'ApiCallLogPanel', 'ReleaseNotesSettings']) app.component(name, passthrough)
 app.mount(host)
 t.after(() => { app.unmount(); globalThis.fetch = previousFetch })
 await settle()
 const section = () => all(host).find(element => element.props['aria-labelledby'] === 'video-cli-account-label')!
 assert.ok(section(), '真实设置组件应打开账号面板')
 return { host, calls, section, get cli() { return cli! }, get removalResult() { return removalResult },
  buttons: () => all(section()).filter(element => element.tag === 'button' || element.tag === 'a') }
}
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
 test(`${provider}真实移除确认按钮调用删除接口并更新列表`, async t => {
  const component = await mount(t, provider, { available: false, can_authorize: false })
  const remove = component.buttons().find(button => text(button) === 'settings.cliAccount.remove')!
  assert.ok(remove); await click(remove); await settle()
  const confirmation = all(component.section()).find(element => element.props.role === 'group' && element.props['aria-label'] === 'settings.cliAccount.remove')!
  assert.ok(confirmation)
  const confirm = all(confirmation).find(element => element.tag === 'button' && /(?:settings\.cliAccount\.(?:remove|confirmRemove)|确认移除)/u.test(text(element)))!
  assert.ok(confirm); await click(confirm); await settle()
  assert.ok(component.calls.some(call => call.method === 'DELETE' && call.path === `/api/v1/${provider}/accounts/empty-slot`))
  assert.match(text(component.section()), /settings\.cliAccount\.empty/u)
 })
 test(`${provider}删除成功后其他账号读取失败仍完成移除并关闭确认`, async t => {
  const component = await mount(t, provider, { available: false, authenticated: false }, true)
  await click(component.buttons().find(button => text(button) === 'settings.cliAccount.remove')!)
  await settle()
  const confirmation = all(component.section()).find(element => element.props.role === 'group' && element.props['aria-label'] === 'settings.cliAccount.remove')!
  assert.ok(confirmation)
  const confirm = all(confirmation).find(element => element.tag === 'button' && /(?:settings\.cliAccount\.confirmRemove|确认移除)/u.test(text(element)))!
  assert.ok(confirm)
  await click(confirm)
  await settle()
  assert.equal(component.removalResult, true, '已完成的DELETE不能因为另一个账号状态失败被改判为删除失败')
  assert.deepEqual(component.cli.accounts.value.map(account => account.id), ['remaining-slot'])
  assert.equal(component.cli.selectedAccountId.value, 'remaining-slot')
  assert.ok(!all(component.section()).some(element => element.props.role === 'group' && element.props['aria-label'] === 'settings.cliAccount.remove'))
  assert.match(text(component.section()), /剩余账号状态暂时无法读取/u)
  assert.equal(component.calls.filter(call => call.method === 'DELETE').length, 1)
 })
}
