import { runCli } from './cli'

process.exitCode = runCli('duration', process.argv.slice(2))
