/**
 * Debug spike: watch the signup flow with headless:false
 * to see exactly what the agent does on the form
 */
import 'dotenv/config'
import { Stagehand } from '@browserbasehq/stagehand'
import { z } from 'zod'

const URL = 'https://practice.expandtesting.com/register'

async function main() {
  const stagehand = new Stagehand({
    env: 'LOCAL',
    verbose: 1,
    model: {
      modelName: 'anthropic/claude-opus-4-6',
      apiKey: process.env.ANTHROPIC_API_KEY,
    },
    localBrowserLaunchOptions: { headless: false },
  })

  await stagehand.init()
  const page = stagehand.context.pages()[0]

  await page.goto(URL, { waitUntil: 'load' })
  console.log('Page loaded. Observing form fields...')

  // First just observe what fields are on the page
  const observations = await stagehand.observe()
  console.log('\nAll observable actions:')
  for (const obs of observations) {
    console.log(' -', obs.description)
  }

  // Check what the page source says about the form
  const formInfo = await stagehand.extract(
    'List all input fields on this page with their labels and types',
    z.object({
      fields: z.array(z.object({
        label: z.string(),
        type: z.string(),
        required: z.boolean(),
      })),
    }),
  )
  console.log('\nForm fields:', JSON.stringify(formInfo, null, 2))

  // Now try the act() with explicit credential details
  console.log('\nAttempting signup with explicit instructions...')
  const inbox = 'debug-test@agentmail.to'
  const instruction = [
    `You are testing this web app as a first-time user.`,
    `Your email address is: ${inbox}`,
    `Your task: Sign up as a new user.`,
    `Fill in the username field with "debuguser001".`,
    `Fill in the password field with "DebugPass123!".`,
    `Fill in the confirm password field with "DebugPass123!".`,
    `Click the Register button.`,
    `Wait to see if the registration succeeds.`,
  ].join('\n')

  await stagehand.act(instruction)
  await page.waitForLoadState('load').catch(() => {})

  const finalUrl = page.url()
  console.log('\nFinal URL:', finalUrl)

  const result = await stagehand.extract(
    'What happened after clicking Register? Was there an error message or success?',
    z.object({
      success: z.boolean(),
      message: z.string(),
      current_page: z.string(),
    }),
  )
  console.log('Result:', JSON.stringify(result, null, 2))

  // Take a screenshot to see what happened
  await page.screenshot({ path: '/tmp/debug_signup.png' })
  console.log('\nScreenshot saved to /tmp/debug_signup.png')

  await stagehand.close()
}

main().catch(console.error)
