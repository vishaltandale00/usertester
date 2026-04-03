/**
 * usertester send <agent-id> <message> — resume an agent with a new task
 */
import type { Command } from 'commander'
import path from 'node:path'
import fs from 'node:fs'
import { DEFAULT_CONFIG } from '../types.js'
import { loadSession } from '../orchestrator/session.js'
import { writeCommand, getAgentDir } from '../output/events.js'

export function registerSend(program: Command): void {
  program
    .command('send <agent-id> <message>')
    .description('Send a new task message to a waiting agent')
    .option('--session <id>', 'Session ID (defaults to current)')
    .action((agentId, message, opts) => {
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

      const state = loadSession(config.results_dir, sessionId)
      if (!state) {
        console.error(`Session ${sessionId} not found`)
        process.exit(1)
      }

      const agent = state.agents.find(a => a.id === agentId)
      if (!agent) {
        console.error(`Agent ${agentId} not found in session ${sessionId}`)
        process.exit(1)
      }

      if (agent.status === 'DONE' || agent.status === 'CANCELLED') {
        console.error(`Agent ${agentId} is ${agent.status}. Spawn a new session.`)
        process.exit(1)
      }

      const sessionDir = path.join(config.results_dir, sessionId)
      const agentDir = getAgentDir(sessionDir, agentId)
      const commandsPath = path.join(agentDir, 'commands.ndjson')

      writeCommand(commandsPath, { type: 'send', message, issuedAt: Date.now() })
      console.log(`Sent message to ${agentId}: "${message}"`)
    })
}
