/**
 * Spike: Stagehand v3 session persistence
 * Goal: confirm cookies/localStorage survive across sequential act() calls
 * on the same session. This is the load-bearing assumption for WAITING → RUNNING resume.
 */
import 'dotenv/config'
import { Stagehand } from '@browserbasehq/stagehand'
import { z } from 'zod'

const TEST_URL = 'https://practice.expandtesting.com/register'

async function main() {
  console.log('=== Stagehand v3 Session Persistence Spike ===\n')

  const stagehand = new Stagehand({
    env: 'LOCAL',
    verbose: 1,
    model: {
      modelName: 'anthropic/claude-opus-4-6',
      apiKey: process.env.ANTHROPIC_API_KEY,
    },
    localBrowserLaunchOptions: {
      headless: true,
    },
  })

  await stagehand.init()
  // v3: page is accessed via stagehand.context.pages()[0]
  const page = stagehand.context.pages()[0]
  console.log('✓ Stagehand initialized (headless, local Chrome via CDP)\n')

  // --- Act 1: navigate and interact ---
  console.log('Act 1: Navigate to register page and fill username...')
  await page.goto(TEST_URL)
  await page.waitForLoadState('networkidle')

  await stagehand.act('Fill in the username field with "testuser_spike_001"')
  await stagehand.act('Fill in the password field with "TestPass123!"')

  // Set a localStorage marker + cookie to verify persistence across act() calls
  await page.evaluate(() => {
    localStorage.setItem('spike_marker', 'act1_was_here')
    document.cookie = 'spike_cookie=act1; path=/'
  })

  const afterAct1 = await page.evaluate(() => ({
    localStorage: localStorage.getItem('spike_marker'),
    cookie: document.cookie,
    url: window.location.href,
  }))
  console.log('State after Act 1:', afterAct1, '\n')

  // --- Act 2: same session, no reload — verify state survived ---
  console.log('Act 2: Observe page (same session, no reload)...')
  const observation = await stagehand.extract(
    'Describe what is on this page and what values are in the form fields',
    z.object({
      page_title: z.string(),
      form_visible: z.boolean(),
      username_filled: z.boolean(),
      description: z.string(),
    }),
  )
  console.log('Observation:', observation)

  const afterAct2 = await page.evaluate(() => ({
    localStorage: localStorage.getItem('spike_marker'),
    cookie: document.cookie,
    url: window.location.href,
  }))
  console.log('\nState after Act 2 (same session):', afterAct2)

  // --- Act 3: navigate somewhere else and come back, verify again ---
  console.log('\nAct 3: Navigate away and return, check state...')
  await page.goto('https://practice.expandtesting.com/login')
  await page.waitForLoadState('networkidle')
  await page.goto(TEST_URL)
  await page.waitForLoadState('networkidle')

  const afterAct3 = await page.evaluate(() => ({
    localStorage: localStorage.getItem('spike_marker'),
    cookie: document.cookie,
    url: window.location.href,
  }))
  console.log('State after Act 3 (navigate away + return):', afterAct3)

  // --- Verdict ---
  const localStorageSurvivedAct2 = afterAct2.localStorage === 'act1_was_here'
  const cookieSurvivedAct2 = afterAct2.cookie.includes('spike_cookie=act1')
  const localStorageSurvivedAct3 = afterAct3.localStorage === 'act1_was_here'
  const cookieSurvivedAct3 = afterAct3.cookie.includes('spike_cookie=act1')

  console.log('\n=== SPIKE RESULTS ===')
  console.log(`localStorage survived act→act:         ${localStorageSurvivedAct2 ? '✓ YES' : '✗ NO'}`)
  console.log(`Cookie survived act→act:               ${cookieSurvivedAct2 ? '✓ YES' : '✗ NO'}`)
  console.log(`localStorage survived navigate away:   ${localStorageSurvivedAct3 ? '✓ YES' : '✗ NO'}`)
  console.log(`Cookie survived navigate away:         ${cookieSurvivedAct3 ? '✓ YES' : '✗ NO'}`)

  if (localStorageSurvivedAct2 && cookieSurvivedAct2) {
    console.log('\n✓ PREMISE 3 CONFIRMED: session state persists across act() calls.')
    if (localStorageSurvivedAct3 && cookieSurvivedAct3) {
      console.log('✓ State also survives cross-page navigation in same session.')
      console.log('→ resume() can proceed without cookie snapshot fallback.')
    } else {
      console.log('⚠ State does NOT survive navigation away. Cookie snapshot needed on page nav.')
    }
  } else {
    console.log('\n✗ PREMISE 3 FAILED: session state does NOT persist across act() calls.')
    console.log('→ Must implement cookie snapshot fallback in browser/agent.ts.')
  }

  await stagehand.close()
}

main().catch(console.error)
