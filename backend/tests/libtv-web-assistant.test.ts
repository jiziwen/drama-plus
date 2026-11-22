import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { libtvWebAssistant } from '../src/services/libtv-web-assistant.js'

test('the Windows assistant runs a loopback callback and returns credentials only in a browser form', { skip: process.platform !== 'win32' }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'drama-libtv-assistant-'))
  const urlFile = path.join(dir, 'opened-url')
  const launcher = libtvWebAssistant({ state: 'be076ff1-694e-41d7-b5c0-b87c89dff0f4', expiresAt: Date.now() + 30_000,
    callbackUrl: 'https://private.example.test/api/v1/libtv/auth/callback' })
  const script = path.join(dir, 'assistant.cmd')
  const override = `function Start-Process { param([string]$FilePath) [IO.File]::WriteAllText('${urlFile.replaceAll("'", "''")}', $FilePath) }\r\n`
  await writeFile(script, launcher.replace('# POWERSHELL-BEGIN\r\n', '# POWERSHELL-BEGIN\r\n' + override))
  const child = spawn('cmd.exe', ['/d', '/c', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let diagnostics = ''
  child.stderr.on('data', value => { diagnostics += value })
  child.stdout.on('data', value => { diagnostics += value })
  const exit = once(child, 'close')
  t.after(async () => { if (child.exitCode === null) child.kill(); await exit; await rm(dir, { recursive: true, force: true }) })
  let opened = ''
  for (let i = 0; i < 150; i++) {
    try { opened = await readFile(urlFile, 'utf8'); if (opened) break } catch {}
    if (child.exitCode !== null) assert.fail(diagnostics)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(opened, diagnostics)
  const official = new URL(opened)
  assert.equal(official.origin, 'https://www.liblib.tv')
  const callback = new URL(official.searchParams.get('callback_url')!)
  assert.equal(callback.protocol, 'http:')
  assert.equal(callback.hostname, '127.0.0.1')
  assert.equal(callback.pathname, '/callback')
  assert.equal(callback.searchParams.get('state'), 'be076ff1-694e-41d7-b5c0-b87c89dff0f4')
  assert.equal(callback.searchParams.has('expires_at'), false, '官网不进入可能静默失败的过期回调校验分支，过期由助手和服务器控制')
  const badState = new URL(callback)
  badState.searchParams.set('state', 'another-browser')
  badState.searchParams.set('token', 'fixture-token')
  assert.equal((await fetch(badState)).status, 400)
  callback.searchParams.set('token', 'fixture-token&with=reserved')
  const result = await fetch(callback)
  assert.equal(result.status, 200, diagnostics)
  assert.match(result.headers.get('content-security-policy') ?? '', /form-action https:\/\/private\.example\.test/u)
  const html = await result.text()
  assert.match(html, /<form method="post" action="https:\/\/private\.example\.test\/api\/v1\/libtv\/auth\/callback"/u)
  assert.match(html, /name="token" value="fixture-token&amp;with=reserved"/u)
  assert.match(html, /history\.replaceState/u)
  assert.match(html, /document\.forms\[0\]\.submit\(\)/u)
  const [code] = await exit
  assert.equal(code, 0, diagnostics)
  assert.doesNotMatch(diagnostics, /fixture-token/u)
})
