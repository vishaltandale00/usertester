/**
 * usertester status — print current session agent states
 */
import type { Command } from 'commander'
import path from 'node:path'
import fs from 'node:fs'
import { DEFAULT_CONFIG } from '../types.js'
import { loadSession } from '../orchestrator/session.js'
import type { AgentState } from '../types.js'

const STATUS_COLORS: Record<string, string> = {
  QUEUED: '\x1b[90m',      // gray
  SPAWNING: '\x1b[33m',    // yellow
  INBOX_READY: '\x1b[33m', // yellow
  SIGNING_UP: '\x1b[36m',  // cyan
  RUNNING: '\x1b[36m',     // cyan
  WAITING: '\x1b[32m',     // green
  DONE: '\x1b[90m',        // gray
  FAILED: '\x1b[31m',      // red
  CANCELLED: '\x1b[90m',   // gray
}
const RESET = '\x1b[0m'

function elapsedStr(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

function colorStatus(status: string): string {
  const color = STATUS_COLORS[status] ?? ''
  return `${color}${status}${RESET}`
}

export function registerStatus(program: Command): void {
  program
    .command('status')
    .description('Show status of all agents in the current session')
    .option('--session <id>', 'Session ID (defaults to current)')
    .option('--json', 'Output raw JSON')
    .action((opts) => {
      const config = { ...DEFAULT_CONFIG }

      let sessionId = opts.session
      if (!sessionId) {
        const currentLink = path.join(config.results_dir, 'current')
        try {
          const target = fs.readlinkSync(currentLink)
          sessionId = path.basename(target)
        } catch {
          console.error('No active session found. Run `usertester spawn` first.')
          process.exit(1)
        }
      }

      const state = loadSession(config.results_dir, sessionId)
      if (!state) {
        console.error(`Session ${sessionId} not found`)
        process.exit(1)
      }

      if (opts.json) {
        console.log(JSON.stringify(state, null, 2))
        return
      }

      const now = Date.now()
      console.log(`Session: ${state.sessionId}`)
      console.log(`URL:     ${state.url}`)
      console.log(`Started: ${new Date(state.startedAt).toLocaleTimeString()}`)
      console.log()
      console.log('AGENT         STATUS        ELAPSED   INBOX')
      console.log('─'.repeat(70))

      for (const agent of state.agents) {
        const elapsed = agent.startedAt ? elapsedStr(now - agent.startedAt) : '-'
        const inbox = agent.inboxId ? agent.inboxId.split('@')[0] + '@...' : '-'
        const status = colorStatus(agent.status)
        const msg = agent.currentMessage ? `  "${agent.currentMessage.slice(0, 30)}"` : ''
        console.log(
          `${agent.id.padEnd(14)}${status.padEnd(22)}${elapsed.padEnd(10)}${inbox}${msg}`,
        )
        if (agent.error) {
          console.log(`  Error: ${agent.error}`)
        }
      }

      const summary = {
        total: state.agents.length,
        running: state.agents.filter(a => a.status === 'RUNNING').length,
        waiting: state.agents.filter(a => a.status === 'WAITING').length,
        failed: state.agents.filter(a => a.status === 'FAILED').length,
        done: state.agents.filter(a => ['DONE', 'CANCELLED'].includes(a.status)).length,
      }
      console.log()
      console.log(
        `${summary.running} running, ${summary.waiting} waiting, ${summary.failed} failed, ${summary.done} done`,
      )
    })
}
