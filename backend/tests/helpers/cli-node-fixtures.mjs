// Windows 不执行 Unix shebang。仅在测试预加载时将 Node CLI fixture 交给 Node，
// 真实 CLI 可执行文件和生产代码不受影响。
import childProcess from 'node:child_process'
import { closeSync, openSync, readSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

if (process.platform === 'win32') {
  const isNodeFixture = file => {
    if (typeof file !== 'string') return false
    let descriptor
    try {
      descriptor = openSync(file, 'r')
      const buffer = Buffer.alloc(64)
      readSync(descriptor, buffer, 0, buffer.length, 0)
      return /^#![^\r\n]*\bnode\b/u.test(buffer.toString())
    } catch { return false }
    finally { if (descriptor !== undefined) closeSync(descriptor) }
  }
  for (const method of ['execFile', 'spawn']) {
    const original = childProcess[method]
    childProcess[method] = function (file, args, ...rest) {
      if (Array.isArray(args) && isNodeFixture(file)) return original.call(this, process.execPath, [file, ...args], ...rest)
      return original.call(this, file, args, ...rest)
    }
  }
  syncBuiltinESMExports()
}
