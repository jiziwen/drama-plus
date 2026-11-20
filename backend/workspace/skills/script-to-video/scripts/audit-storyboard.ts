import { runCli } from './cli'

process.exitCode = runCli('audit', process.argv.slice(2))
