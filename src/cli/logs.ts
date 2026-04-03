/**
 * usertester logs <agent-id> — tail an agent's log file
 */
import type { Command } from 'commander'
import path from 'node:path'
import fs from 'node:fs'
import { DEFAULT_CONFIG } from '../types.js'
import { getAgentDir } from '../output/events.js'

export function registerLogs(program: Command): void {
  program
    .command('logs <agent-id>')
    .description("Tail an agent's log in real time")
    .option('--session <id>', 'Session ID (defaults to current)')
    .option('--follow', 'Keep watching (like tail -f)', false)
    .option('-n, --lines <number>', 'Last N lines to show first', '20')
    .action((agentId, opts) => {
      const config = { ...DEFAULT_CONFIG }

      let sessionId = opts.session
      if (!sessionId) {
        const currentLink = path.join(config.results_dir, 'current')
        try {
          const target = fs.readlinkSync(currentLink)
          sessionId = path.basename(target)
        } catch {
          console.error('No active session. Use --session <id> to specify.')
          process.exit(1)
        }
      }

      const sessionDir = path.join(config.results_dir, sessionId)
      const agentDir = getAgentDir(sessionDir, agentId)
      const logPath = path.join(agentDir, 'agent.log')

      if (!fs.existsSync(logPath)) {
        console.error(`Log not found: ${logPath}`)
        process.exit(1)
      }

      // Show last N lines
      const content = fs.readFileSync(logPath, 'utf-8')
      const lines = content.split('\n').filter(Boolean)
      const lastN = parseInt(opts.lines, 10)
      const toShow = lines.slice(-lastN)
      toShow.forEach(l => console.log(l))

      if (!opts.follow) return

      // Follow mode: use fs.watch to detect appends
      let offset = fs.statSync(logPath).size
      console.log(`\n--- following ${logPath} ---`)

      const watcher = fs.watch(logPath, () => {
        try {
          const stat = fs.statSync(logPath)
          if (stat.size <= offset) return
          const fd = fs.openSync(logPath, 'r')
          const buf = Buffer.alloc(stat.size - offset)
          fs.readSync(fd, buf, 0, buf.length, offset)
          fs.closeSync(fd)
          offset = stat.size
          process.stdout.write(buf.toString())
        } catch {}
      })

      process.on('SIGINT', () => {
        watcher.close()
        process.exit(0)
      })
    })
}
