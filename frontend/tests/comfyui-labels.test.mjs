import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createI18n } from 'vue-i18n'

for (const locale of ['zh']) {
  test(`ComfyUI ${locale} messages compile and interpolate the workflow size`, () => {
    const messages = JSON.parse(readFileSync(new URL(`../app/locales/${locale}.json`, import.meta.url), 'utf8'))
    const i18n = createI18n({ legacy: false, locale, messages: { [locale]: messages } })
    for (const key of Object.keys(messages.settings.comfyui)) {
      const result = i18n.global.t(`settings.comfyui.${key}`, { mp: '0.2' })
      assert.ok(result.length > 0)
      assert.ok(!result.startsWith('settings.comfyui.'))
    }
    assert.match(i18n.global.t('settings.comfyui.workflowSize', { mp: '0.2' }), /0\.2MP/)
  })
}
