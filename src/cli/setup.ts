/**
 * usertester setup — interactive first-run configuration
 * Prompts for API keys, validates them live, writes .env
 */
import type { Command } from 'commander'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve))
}

async function validateAnthropicKey(apiKey: string): Promise<boolean> {
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey })
    await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hi' }],
    })
    return true
  } catch {
    return false
  }
}

async function validateAgentMailKey(apiKey: string): Promise<boolean> {
  try {
    const { AgentMailClient } = await import('agentmail')
    const client = new AgentMailClient({ apiKey })
    await client.inboxes.list()
    return true
  } catch {
    return false
  }
}

export function registerSetup(program: Command): void {
  program
    .command('setup')
    .description('Interactive first-run setup — configure API keys and validate')
    .option('--force', 'Overwrite existing .env', false)
    .action(async (opts) => {
      const envPath = path.join(process.cwd(), '.env')

      if (fs.existsSync(envPath) && !opts.force) {
        console.log(`.env already exists at ${envPath}`)
        console.log('Run with --force to overwrite, or edit it directly.')
        process.exit(0)
      }

      console.log('usertester setup\n')
      console.log('You need two API keys:')
      console.log('  1. Anthropic API key  → https://console.anthropic.com/settings/keys')
      console.log('  2. AgentMail API key  → https://agentmail.to/dashboard\n')

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      })

      let anthropicKey = ''
      let agentmailKey = ''

      // Anthropic key
      while (true) {
        anthropicKey = (await prompt(rl, 'Anthropic API key (sk-ant-...): ')).trim()
        if (!anthropicKey) { console.log('Key cannot be empty.'); continue }

        process.stdout.write('  Validating... ')
        const valid = await validateAnthropicKey(anthropicKey)
        if (valid) {
          console.log('✓')
          break
        } else {
          console.log('✗ Invalid — check the key and try again.')
        }
      }

      // AgentMail key
      while (true) {
        agentmailKey = (await prompt(rl, 'AgentMail API key: ')).trim()
        if (!agentmailKey) { console.log('Key cannot be empty.'); continue }

        process.stdout.write('  Validating... ')
        const valid = await validateAgentMailKey(agentmailKey)
        if (valid) {
          console.log('✓')
          break
        } else {
          console.log('✗ Invalid — check the key and try again.')
        }
      }

      rl.close()

      const envContent = [
        `ANTHROPIC_API_KEY=${anthropicKey}`,
        `AGENTMAIL_API_KEY=${agentmailKey}`,
      ].join('\n') + '\n'

      fs.writeFileSync(envPath, envContent)
      console.log(`\n✓ Written to ${envPath}`)
      console.log('\nYou\'re ready. Try:')
      console.log('  usertester spawn --url https://yourapp.com --n 1 --message "Sign up as a new user"')
    })
}
