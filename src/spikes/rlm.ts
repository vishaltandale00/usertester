/**
 * Spike: RLM (Recursive Language Model) memory loop
 * Goals:
 * 1. Implement SessionMemory + ActionRecord types
 * 2. Implement llm_batch() — N targeted LLM calls on data chunks
 * 3. Simulate a long session (100 actions) and measure context tokens
 *    vs naive "dump all history" approach
 * 4. Confirm context cost stays near-flat as history grows
 * 5. Validate resume() loop produces coherent context string
 *
 * Inspired by arxiv:2512.24601 (RLM) — key insight: instead of feeding full
 * history into one LLM call (O(n) tokens), make small targeted queries
 * on chunked history (O(k) tokens where k << n).
 */
import 'dotenv/config'
import Anthropic from '@anthropic-ai/sdk'

// --- Types ---

interface ActionRecord {
  ts: number
  action: string
  selector?: string
  result: 'success' | 'failed' | 'skipped'
  observation?: string
  url?: string
}

interface SessionMemory {
  taskDescription: string
  startUrl: string
  actions: ActionRecord[]
  archivedActionCount: number  // count of actions flushed to disk
}

// --- Constants (matching design doc config defaults) ---
const RLM_RECENT_ACTIONS = 10       // last N actions fed directly into context
const RLM_MAX_FAILED_ACTIONS = 5    // max failed actions to summarize
const ARCHIVE_THRESHOLD = 50        // flush to disk when > 50 actions

// --- llm_batch: make N small targeted queries on data chunks ---

async function llm_batch(
  client: Anthropic,
  queries: Array<{ data: ActionRecord[]; prompt: string }>,
): Promise<string[]> {
  if (queries.every(q => q.data.length === 0)) {
    return queries.map(() => '(no data)')
  }

  const results = await Promise.all(
    queries.map(async ({ data, prompt }) => {
      if (data.length === 0) return '(no data)'

      const dataStr = data
        .map(
          (a, i) =>
            `[${i + 1}] ${a.action} → ${a.result}${a.observation ? ` | ${a.observation}` : ''}`,
        )
        .join('\n')

      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',   // cheapest + fastest for chunk queries
        max_tokens: 150,
        messages: [
          {
            role: 'user',
            content: `${prompt}\n\nActions:\n${dataStr}\n\nAnswer in 1-2 sentences.`,
          },
        ],
      })

      const block = response.content[0]
      return block.type === 'text' ? block.text : '(no text)'
    }),
  )

  return results
}

// --- resume(): build context for next agent step ---

async function resume(
  client: Anthropic,
  memory: SessionMemory,
  nextTask: string,
): Promise<{ context: string; inputTokens: number }> {
  const recentWindow = memory.actions.slice(-RLM_RECENT_ACTIONS)
  const failedWindow = memory.actions.filter(a => a.result === 'failed').slice(-RLM_MAX_FAILED_ACTIONS)

  const [recentContext, failureContext] = await llm_batch(client, [
    { data: recentWindow, prompt: 'What is the current browser state and what has the agent done most recently?' },
    { data: failedWindow, prompt: 'What has failed before that the agent should avoid repeating?' },
  ])

  const context = [
    `Task: ${nextTask}`,
    `URL: ${memory.startUrl}`,
    `Total actions taken: ${memory.actions.length + memory.archivedActionCount}`,
    `Recent state: ${recentContext}`,
    failureContext !== '(no data)' ? `Known failures to avoid: ${failureContext}` : null,
  ]
    .filter(Boolean)
    .join('\n')

  // Measure tokens via a dry run
  const countResponse = await client.messages.countTokens({
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', content: context }],
  })

  return { context, inputTokens: countResponse.input_tokens }
}

// --- Simulate session with growing history ---

function makeAction(i: number): ActionRecord {
  const actions = [
    { action: 'click signup button', result: 'success' as const, observation: 'Navigated to registration form' },
    { action: 'fill username field', result: 'success' as const, observation: 'Typed testuser_001' },
    { action: 'fill password field', result: 'success' as const, observation: 'Typed password' },
    { action: 'click submit button', result: 'failed' as const, observation: 'CAPTCHA appeared' },
    { action: 'solve captcha', result: 'failed' as const, observation: 'Could not find solve button' },
    { action: 'scroll down', result: 'success' as const, observation: 'Found email field' },
    { action: 'fill email field', result: 'success' as const, observation: 'Typed email@agentmail.to' },
    { action: 'click confirm password', result: 'success' as const, observation: 'Field filled' },
    { action: 'click terms checkbox', result: 'failed' as const, observation: 'Checkbox not found' },
    { action: 'navigate to /register', result: 'success' as const, observation: 'Page loaded' },
  ]
  const template = actions[i % actions.length]
  return { ...template, ts: Date.now() + i * 1000, url: 'https://example.com/register' }
}

async function main() {
  console.log('=== RLM Memory Loop Spike ===\n')

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

  // Build a SessionMemory with growing history
  const memory: SessionMemory = {
    taskDescription: 'Sign up as a new user and verify the email',
    startUrl: 'https://practice.expandtesting.com/register',
    actions: [],
    archivedActionCount: 0,
  }

  console.log('Simulating 100 actions and sampling context cost at 10, 30, 60, 100 actions...\n')

  const samplePoints = [10, 30, 60, 100]
  const naiveTokenCounts: number[] = []
  const rlmTokenCounts: number[] = []

  for (let i = 0; i < 100; i++) {
    memory.actions.push(makeAction(i))

    // Flush old actions when exceeding threshold (design doc: flush oldest 10 when > 50)
    if (memory.actions.length > ARCHIVE_THRESHOLD) {
      const archived = memory.actions.splice(0, 10)
      memory.archivedActionCount += archived.length
      console.log(`  [action ${i + 1}] Archived ${archived.length} old actions (${memory.archivedActionCount} total archived)`)
    }

    if (samplePoints.includes(i + 1)) {
      const totalActions = i + 1

      // Naive approach: dump all in-memory history as context
      const naiveContext = `Task: Sign up\nHistory:\n${memory.actions
        .map(a => `${a.action} → ${a.result}`)
        .join('\n')}`
      const naiveCount = await client.messages.countTokens({
        model: 'claude-haiku-4-5-20251001',
        messages: [{ role: 'user', content: naiveContext }],
      })

      // RLM approach: targeted queries on recent + failed windows
      const { inputTokens: rlmTokens } = await resume(client, memory, 'Complete the registration')

      naiveTokenCounts.push(naiveCount.input_tokens)
      rlmTokenCounts.push(rlmTokens)

      console.log(`[${totalActions} actions] naive=${naiveCount.input_tokens} tokens  rlm=${rlmTokens} tokens`)
    }
  }

  // --- Verdict ---
  console.log('\n=== SPIKE RESULTS ===')
  console.log('Actions | Naive tokens | RLM tokens | Ratio')
  samplePoints.forEach((n, i) => {
    const ratio = (rlmTokenCounts[i] / naiveTokenCounts[i]).toFixed(2)
    console.log(`  ${String(n).padEnd(6)} | ${String(naiveTokenCounts[i]).padEnd(12)} | ${String(rlmTokenCounts[i]).padEnd(10)} | ${ratio}x`)
  })

  const naiveGrowth = naiveTokenCounts[3] / naiveTokenCounts[0]
  const rlmGrowth = rlmTokenCounts[3] / rlmTokenCounts[0]

  console.log(`\nNaive context growth (10→100 actions): ${naiveGrowth.toFixed(1)}x`)
  console.log(`RLM context growth   (10→100 actions): ${rlmGrowth.toFixed(1)}x`)

  if (rlmGrowth < naiveGrowth * 0.5) {
    console.log('\n✓ RLM CONFIRMED: context growth significantly sub-linear vs naive approach')
    console.log('→ resume() is safe to use in production agent loop')
  } else {
    console.log('\n⚠ RLM advantage less clear — may need larger sample or different chunking strategy')
  }

  // Also confirm the resume() context string is coherent
  console.log('\nSample resume() context output:')
  const { context } = await resume(client, memory, 'Complete the email verification step')
  console.log(context)
}

main().catch(console.error)
