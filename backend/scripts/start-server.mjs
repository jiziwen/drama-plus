import 'dotenv/config'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// Node reads its proxy settings at process startup. Load .env before spawning
// tsx so HTTPS_PROXY / NO_PROXY also apply to fetch in the actual server.
const env = { ...process.env }
if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) {
  env.NODE_USE_ENV_PROXY ??= '1'
}
const require = createRequire(import.meta.url)
const args = [require.resolve('tsx/cli'), ...(process.argv[2] === 'watch' ? ['watch'] : []), 'src/index.ts']
const child = spawn(process.execPath, args, { env, stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('error', error => { console.error('Unable to start backend:', error.message); process.exitCode = 1 })
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 128 : 1) })
