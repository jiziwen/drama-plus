import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buffer } from 'node:stream/consumers'
import { test } from 'node:test'
import { ZipFile } from 'yazl'

async function wordFixture() {
  const zip = new ZipFile()
  zip.addBuffer(Buffer.from('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>暗号：青棠 513</w:t></w:r></w:p></w:body></w:document>'), 'word/document.xml')
  zip.end()
  return new Uint8Array(await buffer(zip.outputStream))
}

function pdfFixture(text: string) {
  const hex = Buffer.from(text, 'utf16le').swap16().toString('hex')
  const stream = text ? `BT /F1 12 Tf 40 80 Td <${hex}> Tj ET` : ''
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((object, index) => {
    const offset = pdf.length
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
    return `${String(offset).padStart(10, '0')} 00000 n \n`
  })
  const count = objects.length + 1
  return `${pdf}xref\n0 ${count}\n0000000000 65535 f \n${offsets.join('')}trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${pdf.length}\n%%EOF`
}

function parseSseBody(raw: string) {
  const events: { event: string; data: any }[] = []
  for (const block of raw.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue
    let event = 'message'
    const dataLines: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    if (!dataLines.length) continue
    const text = dataLines.join('\n')
    events.push({ event, data: JSON.parse(text) })
  }
  return events
}

test('AI 聊天支持模型选择、流式输出、主动与被动上下文压缩续答', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-chat-'))
  const oldPath = process.env.SQLITE_PATH
  process.env.SQLITE_PATH = join(dir, 'app.sqlite3')

  const [{ createAiChatRoutes }, { db, schema }] = await Promise.all([
    import('../src/routes/ai-chat.js'),
    import('../src/db/index.js'),
  ])

  t.after(async () => {
    if (oldPath === undefined) delete process.env.SQLITE_PATH
    else process.env.SQLITE_PATH = oldPath
    await rm(dir, { recursive: true, force: true })
  })

  const timestamp = new Date().toISOString()
  db.insert(schema.aiServiceConfigs).values([
    {
      id: 31,
      serviceType: 'text',
      provider: 'openai',
      name: '主力文本服务',
      baseUrl: 'http://localhost:9000',
      apiKey: 'fake-key',
      model: JSON.stringify(['gpt-4o', 'deepseek-chat']),
      priority: 10,
      isActive: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: 32,
      serviceType: 'text',
      provider: 'gemini',
      name: '停用服务',
      baseUrl: 'http://localhost:9001',
      apiKey: 'fake-key-2',
      model: JSON.stringify(['gemini-off']),
      priority: 1,
      isActive: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ]).run()

  let forceInputLimitOnce = false
  let lastSeenModel: any = null
  const streamCalls: { instructions: string; messageCount: number; firstUser?: string; lastUser?: string }[] = []
  const summarizeCalls: string[] = []

  const app = createAiChatRoutes({
    createRunner: async (selection) => {
      lastSeenModel = selection
      return {
        limits: { contextWindow: 4_000, maxOutputTokens: 1_000 },
        modelName: selection?.model || 'gpt-4o',
        configName: '主力文本服务',
        async stream({ instructions, messages }, callbacks) {
          streamCalls.push({
            instructions,
            messageCount: messages.length,
            firstUser: messages.find(m => m.role === 'user')?.content,
            lastUser: [...messages].reverse().find(m => m.role === 'user')?.content,
          })

          if (forceInputLimitOnce) {
            forceInputLimitOnce = false
            const err: any = new Error('This model\'s maximum context length is 4096 tokens, however you requested 5200 tokens.')
            err.code = 'context_length_exceeded'
            throw err
          }

          callbacks.onReasoning?.('先整理问题要点')
          callbacks.onDelta('第一段')
          callbacks.onDelta('回答完成')
          return {
            text: '第一段回答完成',
            reasoning: '先整理问题要点',
            usage: { inputTokens: 320, outputTokens: 28, totalTokens: 348 },
            finishReason: 'stop',
          }
        },
        async summarize({ prompt }) {
          summarizeCalls.push(prompt)
          return '压缩摘要：用户与助手讨论了短剧开场与核心人物设定。'
        },
      }
    },
  })

  const json = (method: string, body?: unknown) => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

  // 1. 模型列表只返回启用的文本模型
  const modelsRes = await app.request('/models')
  assert.equal(modelsRes.status, 200)
  const modelsPayload = (await modelsRes.json()).data
  assert.equal(modelsPayload.models.length, 2)
  assert.deepEqual(modelsPayload.models.map((m: any) => m.model), ['gpt-4o', 'deepseek-chat'])

  // 2. 禁止选择未启用模型
  const badSessionRes = await app.request('/sessions', json('POST', { model: { configId: 32, model: 'gemini-off' } }))
  assert.equal(badSessionRes.status, 400)

  // 3. 创建会话并选择模型
  const createRes = await app.request('/sessions', json('POST', { model: { configId: 31, model: 'deepseek-chat' } }))
  assert.equal(createRes.status, 201)
  const session = (await createRes.json()).data
  assert.equal(session.model.model, 'deepseek-chat')

  // 4. 第一轮流式聊天：验证 SSE 事件与自动命名
  const turn1Res = await app.request(`/sessions/${session.id}/messages`, json('POST', { content: '帮我写一个短剧开场' }))
  assert.equal(turn1Res.status, 200)
  const turn1Events = parseSseBody(await turn1Res.text())
  assert.equal(turn1Events.some(e => e.event === 'reasoning' && e.data.delta === '先整理问题要点'), true)
  const deltas = turn1Events.filter(e => e.event === 'delta').map(e => e.data.delta).join('')
  assert.equal(deltas, '第一段回答完成')
  const done1 = turn1Events.find(e => e.event === 'done')?.data
  assert.ok(done1)
  assert.equal(done1.session.title, '帮我写一个短剧开场')
  assert.equal(done1.session.messages.length, 2)
  assert.deepEqual(lastSeenModel, { configId: 31, model: 'deepseek-chat' })

  // 5. 切换模型并触发被动上下文超限压缩（context_length_exceeded -> 自动压缩 -> 重试继续回答）
  const patchRes = await app.request(`/sessions/${session.id}`, json('PATCH', { model: { configId: 31, model: 'gpt-4o' } }))
  assert.equal(patchRes.status, 200)

  forceInputLimitOnce = true
  const turn2Res = await app.request(`/sessions/${session.id}/messages`, json('POST', { content: '继续细化第二场冲突' }))
  assert.equal(turn2Res.status, 200)
  const turn2Events = parseSseBody(await turn2Res.text())
  assert.equal(turn2Events.some(e => e.event === 'status' && e.data.phase === 'compressing'), true)
  assert.equal(turn2Events.some(e => e.event === 'compressed' && e.data.compressedUntil === 2), true)
  const done2 = turn2Events.find(e => e.event === 'done')?.data
  assert.ok(done2)
  assert.equal(done2.message.content, '第一段回答完成')
  assert.equal(done2.message.compression.compressedCount, 2)
  assert.equal(done2.session.compressedUntil, 2)
  assert.match(done2.session.summary, /压缩摘要/)
  assert.deepEqual(lastSeenModel, { configId: 31, model: 'gpt-4o' })
  assert.equal(summarizeCalls.length, 1)

  // 6. 主动上下文压缩：当下一条消息本身超过 proactiveBudget（~2550 tokens）时提前压缩后再回答
  const hugeTurnRes = await app.request(`/sessions/${session.id}/messages`, json('POST', {
    content: '背景补充：' + '这是一段非常详细的短剧人物关系和冲突背景说明。'.repeat(160) + '\n请问主角下一步该怎么反击？',
  }))
  assert.equal(hugeTurnRes.status, 200)
  const hugeEvents = parseSseBody(await hugeTurnRes.text())
  assert.equal(hugeEvents.some(e => e.event === 'compressed'), true)
  const hugeDone = hugeEvents.find(e => e.event === 'done')?.data
  assert.ok(hugeDone)
  assert.equal(hugeDone.message.content, '第一段回答完成')
  assert.ok(summarizeCalls.length >= 2)
  // UI 保留全部历史消息用于回看
  assert.equal(hugeDone.session.messages.length, 6)

  // 7. 验证会话列表和删除
  const listRes = await app.request('/sessions')
  assert.equal(listRes.status, 200)
  const list = (await listRes.json()).data
  assert.equal(list.length, 1)

  const delRes = await app.request(`/sessions/${session.id}`, { method: 'DELETE' })
  assert.equal(delRes.status, 200)
  const afterDel = await app.request('/sessions')
  assert.equal((await afterDel.json()).data.length, 0)

  await t.test('附件进入模型上下文，记录只返回文件信息，超长附件按问题分段处理', async () => {
    const created = await app.request('/sessions', json('POST', {}))
    const id = (await created.json()).data.id
    const path = `/sessions/${id}/messages`
    const multipart = (files: File[], content?: string) => {
      const body = new FormData()
      body.set('message', JSON.stringify({ content }))
      for (const file of files) body.append('files', file)
      return { method: 'POST', body }
    }

    const invalid = await app.request(path, multipart([new File(['hello'], '旧格式.doc')]))
    assert.equal(invalid.status, 400)
    assert.match((await invalid.json()).message, /不支持文件/)
    const blank = await app.request(path, multipart([new File([pdfFixture('')], '扫描件.pdf')]))
    assert.equal(blank.status, 400)
    assert.match((await blank.json()).message, /OCR/)

    const files = [
      new File(['角色是沈青，地点是西宁。'], '人物.txt'),
      new File([await wordFixture()], '剧本.docx'),
      new File([pdfFixture('合约编号742')], '备注.pdf'),
    ]
    const uploaded = await app.request(path, multipart(files))
    assert.equal(uploaded.status, 200)
    const uploadedEvents = await uploaded.text()
    assert.doesNotMatch(uploadedEvents, /西宁|青棠|合约编号/)
    const done = parseSseBody(uploadedEvents).find(event => event.event === 'done')?.data
    assert.equal(done.session.title, '人物.txt')
    assert.equal(done.session.messages[0].content, '')
    assert.deepEqual(done.session.messages[0].attachments, files.map(({ name, size }) => ({ name, size })))
    assert.match(streamCalls.at(-1)!.lastUser!, /西宁[\s\S]*青棠 513[\s\S]*合约编号\s*742[\s\S]*请概述这些附件/)

    const regenerated = await app.request(path, json('POST', { regenerate: true }))
    assert.ok(parseSseBody(await regenerated.text()).some(event => event.event === 'done'))
    assert.match(streamCalls.at(-1)!.lastUser!, /青棠 513/)

    const followup = await app.request(path, json('POST', { content: '暗号是什么？' }))
    assert.ok(parseSseBody(await followup.text()).some(event => event.event === 'done'))
    assert.match(streamCalls.at(-1)!.firstUser!, /青棠 513/)

    const question = '请对照开头和结尾的暗号，分别写出数字。'
    const summaryStart = summarizeCalls.length
    const longFile = new File(['开头暗号 691\n', '场景继续，人物冲突逐渐升级。'.repeat(360), '\n结尾暗号 203'], '长剧本.md')
    const oversized = await app.request(path, multipart([longFile], question))
    const events = parseSseBody(await oversized.text())
    assert.ok(events.some(event => event.event === 'compressed'))
    assert.ok(events.some(event => event.event === 'done'))
    const chunks = summarizeCalls.slice(summaryStart).filter(prompt => prompt.includes(question))
    assert.ok(chunks.length > 2)
    assert.ok(chunks.some(prompt => prompt.includes('开头暗号 691')))
    assert.ok(chunks.some(prompt => prompt.includes('结尾暗号 203')))
    assert.ok(streamCalls.at(-1)!.lastUser!.endsWith(question))
    assert.match(streamCalls.at(-1)!.lastUser!, /附件分段摘要：长剧本\.md/)

    const history = await app.request(`/sessions/${id}`)
    const session = (await history.json()).data
    assert.deepEqual(session.messages[0].attachments.map((file: any) => file.name), ['人物.txt', '剧本.docx', '备注.pdf'])
    await app.request(`/sessions/${id}`, { method: 'DELETE' })
    assert.equal(db.select().from(schema.aiChatAttachments).all().length, 0)
  })
})
