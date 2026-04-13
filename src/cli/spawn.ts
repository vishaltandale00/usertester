/**
 * usertester spawn — launch N agents against a URL
 */
import type { Command } from 'commander'
import fs from 'node:fs'
import { DEFAULT_CONFIG } from '../types.js'
import { orchestrate } from '../orchestrator/index.js'

export function registerSpawn(program: Command): void {
  program
    .command('spawn')
    .description('Spawn N AI agents as simulated users against a URL')
    .requiredOption('--url <url>', 'Target URL')
    .option('-n, --n <number>', 'Number of agents', '1')
    .option('--message <message>', 'Task message for all agents')
    .option('--messages-file <file>', 'JSON file with per-agent messages')
    .option('--session <id>', 'Resume an existing session ID')
    .option('--no-wait', 'Skip WAITING state — agents transition straight to DONE after task completion')
    .action(async (opts) => {
      const config = { ...DEFAULT_CONFIG }

      // Resolve messages
      let messages: string[] = []
      if (opts.messagesFile) {
        try {
          const raw = JSON.parse(fs.readFileSync(opts.messagesFile, 'utf-8')) as Array<{ message: string }>
          messages = raw.map(r => r.message)
        } catch (err) {
          console.error(`Error reading messages file: ${err}`)
          process.exit(1)
        }
      } else if (opts.message) {
        messages = [opts.message]
      } else {
        console.error('Error: --message or --messages-file is required')
        process.exit(1)
      }

      const n = parseInt(opts.n, 10)
      if (isNaN(n) || n < 1) {
        console.error('Error: --n must be a positive integer')
        process.exit(1)
      }

      if (!config.agentmail_api_key) {
        console.error('Error: AGENTMAIL_API_KEY is not set')
        process.exit(1)
      }
      if (!config.anthropic_api_key) {
        console.error('Error: ANTHROPIC_API_KEY is not set')
        process.exit(1)
      }

      // Ensure results dir exists
      fs.mkdirSync(config.results_dir, { recursive: true })

      await orchestrate({ url: opts.url, messages, n, config, noWait: !!opts.noWait })
    })
}
