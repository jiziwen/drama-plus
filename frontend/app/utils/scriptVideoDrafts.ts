import type { ScriptVideoChange } from '../../../backend/src/services/script-video-sync'

export type ScriptVideoDraft<Project> = {
  account: string
  tabId: string
  projectId: string
  clientId: string
  sequence: number
  base: Project
  local: Project
  sending?: { sequence: number; changes: ScriptVideoChange[]; submitted: Project }
}

const storeName = 'project-drafts'
let database: Promise<IDBDatabase> | undefined
function openDatabase() {
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('script-video-local-edits', 1)
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(storeName, { keyPath: ['account', 'tabId', 'projectId'] })
        store.createIndex('tab', ['account', 'tabId'])
      }
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    }).catch(error => { database = undefined; throw error })
  }
  return database
}

export async function readScriptVideoDrafts<Project>(account: string, tabId: string): Promise<ScriptVideoDraft<Project>[]> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName).objectStore(storeName).index('tab').getAll([account, tabId])
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function writeScriptVideoDraft<Project>(
  account: string, tabId: string, projectId: string, draft?: ScriptVideoDraft<Project>,
) {
  const db = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const store = tx.objectStore(storeName)
    if (draft) store.put(draft)
    else store.delete([account, tabId, projectId])
    tx.oncomplete = () => resolve()
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('本机草稿写入失败'))
  })
}
