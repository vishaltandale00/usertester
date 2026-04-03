/**
 * usertester cleanup — delete all AgentMail inboxes from a session
 */
import type { Command } from 'commander'
import path from 'node:path'
import fs from 'node:fs'
import { DEFAULT_CONFIG } from '../types.js'
import { loadSession } from '../orchestrator/session.js'
import { InboxManager } from '../inbox/agentmail.js'

export function registerCleanup(program: Command): void {
  program
    .command('cleanup')
    .description('Delete all AgentMail inboxes from a session')
    .option('--session <id>', 'Session ID (defaults to current)')
    .option('--all', 'Clean up all sessions', false)
    .action(async (opts) => {
      const config = { ...DEFAULT_CONFIG }

      if (!config.agentmail_api_key) {
        console.error('AGENTMAIL_API_KEY not set')
        process.exit(1)
      }

      let sessionIds: string[] = []

      if (opts.all) {
        // Find all session dirs
        try {
          const entries = fs.readdirSync(config.results_dir, { withFileTypes: true })
          sessionIds = entries
            .filter(e => e.isDirectory() && e.name !== 'profiles')
            .map(e => e.name)
        } catch {
          console.error(`Results dir not found: ${config.results_dir}`)
          process.exit(1)
        }
      } else {
        let sessionId = opts.session
        if (!sessionId) {
          const currentLink = path.join(config.results_dir, 'current')
          try {
            const target = fs.readlinkSync(currentLink)
            sessionId = path.basename(target)
          } catch {
            console.error('No active session. Use --session <id> or --all.')
            process.exit(1)
          }
        }
        sessionIds = [sessionId]
      }

      const inboxMgr = new InboxManager(config.agentmail_api_key)
      let deletedCount = 0

      for (const sessionId of sessionIds) {
        const state = loadSession(config.results_dir, sessionId)
        if (!state) {
          console.log(`Session ${sessionId}: not found, skipping`)
          continue
        }

        const inboxIds = state.agents.map(a => a.inboxId).filter(Boolean) as string[]
        if (inboxIds.length === 0) {
          console.log(`Session ${sessionId}: no inboxes to delete`)
          continue
        }

        console.log(`Session ${sessionId}: deleting ${inboxIds.length} inbox(es)...`)
        await Promise.allSettled(
          inboxIds.map(async (id) => {
            try {
              await inboxMgr.delete(id)
              deletedCount++
              console.log(`  ✓ Deleted ${id}`)
            } catch (err) {
              console.log(`  ✗ Failed to delete ${id}: ${err}`)
            }
          }),
        )
      }

      console.log(`\nDone. Deleted ${deletedCount} inbox(es).`)
    })
}
