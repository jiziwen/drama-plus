import type Database from 'better-sqlite3'
import { createVideoCliAccount, listVideoCliAccounts, removeVideoCliAccount, type VideoCliAccountProvider } from '../services/video-cli-accounts.js'

export function bindLegacyVideoCliConfigs(sqlite: Database.Database) {
  const created: { provider: VideoCliAccountProvider; id: string }[] = []
  try {
    sqlite.transaction(() => {
      const configs = sqlite.prepare(`SELECT id, video_cli_account_id AS accountId FROM ai_service_configs
        WHERE service_type = 'video' AND provider = ? ORDER BY id`)
      const bind = sqlite.prepare('UPDATE ai_service_configs SET video_cli_account_id = ? WHERE id = ?')
      const copy = sqlite.prepare(`INSERT INTO ai_service_configs
        (service_type, provider, name, base_url, api_key, model, endpoint, query_endpoint, video_cli_account_id,
          priority, is_default, is_active, settings, created_at, updated_at)
        SELECT service_type, provider, ?, base_url, api_key, model, endpoint, query_endpoint, ?,
          priority, 0, is_active, settings, ?, ? FROM ai_service_configs WHERE id = ?`)
      for (const provider of ['jimeng', 'libtv'] as const) {
        const rows = configs.all(provider) as { id: number; accountId: string | null }[]
        const pending = rows.filter(row => !row.accountId)
        if (!pending.length) continue
        const used = new Set(rows.map(row => row.accountId))
        const available = listVideoCliAccounts(provider).filter(account => !used.has(account.id))
        for (const row of pending) {
          let account = available.shift()
          if (!account) {
            account = createVideoCliAccount(provider)
            created.push({ provider, id: account.id })
          }
          bind.run(account.id, row.id)
        }
        if (available.length) {
          const time = new Date().toISOString()
          for (const account of available) copy.run(account.name, account.id, time, time, pending[0].id)
        }
      }
    }).immediate()
  } catch (error) {
    for (const { provider, id } of created.reverse()) removeVideoCliAccount(provider, id)
    throw error
  }
}
