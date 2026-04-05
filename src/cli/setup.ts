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

async function validateOpenRouterKey(apiKey: string): Promise<boolean> {
  try {
    const { createOpenRouter } = await import('@openrouter/ai-sdk-provider')
    const { generateText } = await import('ai')
    const or = createOpenRouter({ apiKey })
    await generateText({
      model: or('anthropic/claude-haiku-4-5') as any,
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 5,
    })
    return true
  } catch {
    return false
  }
}

async function validateAnthropicKey(apiKey: string): Promise<boolean> {
  try {
    const { createAnthropic } = await import('@ai-sdk/anthropic')
    const { generateText } = await import('ai')
    const provider = createAnthropic({ apiKey })
    await generateText({
      model: provider('claude-haiku-4-5-20251001'),
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 5,
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

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      })

      const envLines: string[] = []

      // --- LLM provider choice ---
      console.log('Choose your LLM provider:')
      console.log('  OpenRouter gives you one API key that covers Anthropic + OpenAI models.')
      console.log('  Alternatively you can configure Anthropic and/or OpenAI directly.\n')

      const useOpenRouter = (await prompt(rl, 'Use OpenRouter? (single API key, covers Anthropic + OpenAI) [Y/n]: ')).trim()
      const preferOpenRouter = !useOpenRouter || useOpenRouter.toLowerCase() !== 'n'

      if (preferOpenRouter) {
        console.log('\nGet your key at: https://openrouter.ai/keys\n')

        let openrouterKey = ''
        while (true) {
          openrouterKey = (await prompt(rl, 'OpenRouter API key (sk-or-...): ')).trim()
          if (!openrouterKey) { console.log('Key cannot be empty.'); continue }

          process.stdout.write('  Validating... ')
          const valid = await validateOpenRouterKey(openrouterKey)
          if (valid) {
            console.log('ok')
            break
          } else {
            console.log('Invalid — check the key and try again.')
          }
        }

        envLines.push(`OPENROUTER_API_KEY=${openrouterKey}`)
      } else {
        // Direct Anthropic
        console.log('\nGet your Anthropic key at: https://console.anthropic.com/settings/keys\n')

        let anthropicKey = ''
        while (true) {
          anthropicKey = (await prompt(rl, 'Anthropic API key (sk-ant-...): ')).trim()
          if (!anthropicKey) { console.log('Key cannot be empty.'); continue }

          process.stdout.write('  Validating... ')
          const valid = await validateAnthropicKey(anthropicKey)
          if (valid) {
            console.log('ok')
            break
          } else {
            console.log('Invalid — check the key and try again.')
          }
        }

        envLines.push(`ANTHROPIC_API_KEY=${anthropicKey}`)

        // Optional OpenAI
        const addOpenAI = (await prompt(rl, 'Also configure OpenAI API key? [y/N]: ')).trim()
        if (addOpenAI.toLowerCase() === 'y') {
          console.log('\nGet your key at: https://platform.openai.com/api-keys\n')

          let openaiKey = ''
          while (true) {
            openaiKey = (await prompt(rl, 'OpenAI API key (sk-...): ')).trim()
            if (!openaiKey) { console.log('Key cannot be empty.'); continue }

            process.stdout.write('  Validating... ')
            // Basic format check (full validation requires a call)
            if (openaiKey.startsWith('sk-')) {
              console.log('ok (format check)')
              break
            } else {
              console.log('Key should start with sk-')
            }
          }

          envLines.push(`OPENAI_API_KEY=${openaiKey}`)
        }
      }

      // --- AgentMail ---
      console.log('\nGet your AgentMail key at: https://agentmail.to/dashboard\n')

      let agentmailKey = ''
      while (true) {
        agentmailKey = (await prompt(rl, 'AgentMail API key: ')).trim()
        if (!agentmailKey) { console.log('Key cannot be empty.'); continue }

        process.stdout.write('  Validating... ')
        const valid = await validateAgentMailKey(agentmailKey)
        if (valid) {
          console.log('ok')
          break
        } else {
          console.log('Invalid — check the key and try again.')
        }
      }

      envLines.push(`AGENTMAIL_API_KEY=${agentmailKey}`)

      rl.close()

      const envContent = envLines.join('\n') + '\n'
      fs.writeFileSync(envPath, envContent)
      console.log(`\nWritten to ${envPath}`)
      console.log('\nYou\'re ready. Try:')
      console.log('  usertester spawn --url https://yourapp.com --n 1 --message "Sign up as a new user"')
    })
}
