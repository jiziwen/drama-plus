// 模块级单例供组件和 setup 外的代码共用。
import { createI18n } from 'vue-i18n'
import zh from '../locales/zh.json'

export const i18n = createI18n({
  legacy: false,
  locale: 'zh',
  fallbackLocale: 'zh',
  messages: { zh },
  missingWarn: false,
  fallbackWarn: false,
})
