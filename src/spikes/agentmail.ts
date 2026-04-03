/**
 * Spike: AgentMail TypeScript SDK
 * Goals:
 * 1. Provision an inbox
 * 2. Confirm REST read API works (threads + messages) — no Composio needed
 * 3. Measure provisioning latency
 * 4. Confirm cleanup (delete inbox)
 * 5. Check rate limits by provisioning 3 inboxes in parallel
 */
import 'dotenv/config'
import { AgentMailClient } from 'agentmail'

async function main() {
  console.log('=== AgentMail TypeScript SDK Spike ===\n')

  const client = new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY! })

  // --- 1. Single inbox provisioning latency ---
  console.log('Test 1: Single inbox provision latency...')
  const t0 = Date.now()
  const inbox = await client.inboxes.create({ username: `spike-${Date.now()}` })
  const provisionMs = Date.now() - t0

  console.log(`✓ Inbox created: ${inbox.inboxId}`)
  console.log(`  Latency: ${provisionMs}ms\n`)

  // --- 2. Read API: list threads for this inbox ---
  console.log('Test 2: Read API — list threads (inbox should be empty)...')
  const threads = await client.inboxes.threads.list(inbox.inboxId)
  console.log(`✓ Threads API works. Count: ${(threads as any).items?.length ?? 0}\n`)

  // Delete inbox1 before parallel test (free plan: 3 inbox limit)
  await client.inboxes.delete(inbox.inboxId)

  // --- 3. Parallel provisioning: 3 inboxes at once ---
  console.log('Test 3: Parallel provisioning — 3 inboxes simultaneously...')
  const tParallel = Date.now()
  const [inbox2, inbox3, inbox4] = await Promise.all([
    client.inboxes.create({ username: `spike-p1-${Date.now()}` }),
    client.inboxes.create({ username: `spike-p2-${Date.now()}` }),
    client.inboxes.create({ username: `spike-p3-${Date.now()}` }),
  ])
  const parallelMs = Date.now() - tParallel
  console.log(`✓ 3 inboxes provisioned in parallel: ${parallelMs}ms`)
  console.log(`  ${inbox2.inboxId}`)
  console.log(`  ${inbox3.inboxId}`)
  console.log(`  ${inbox4.inboxId}\n`)

  // --- 4. Cleanup: delete all test inboxes ---
  console.log('Test 4: Cleanup — delete parallel test inboxes...')
  const tCleanup = Date.now()
  await Promise.all([
    client.inboxes.delete(inbox2.inboxId),
    client.inboxes.delete(inbox3.inboxId),
    client.inboxes.delete(inbox4.inboxId),
  ])
  console.log(`✓ All inboxes deleted in ${Date.now() - tCleanup}ms\n`)

  // --- Verdict ---
  console.log('=== SPIKE RESULTS ===')
  console.log(`Single provision latency: ${provisionMs}ms`)
  console.log(`3 parallel provisions:    ${parallelMs}ms`)
  console.log(`Composio needed:          NO — AgentMail REST SDK handles inbox read`)
  console.log(`Cleanup API:              ✓ works`)
  console.log('')

  if (provisionMs < 5000) {
    console.log('✓ Provisioning is fast enough for v1 (< 5s per inbox)')
  } else {
    console.log(`⚠ Provisioning is slow (${provisionMs}ms) — consider parallel provisioning`)
  }

  if (parallelMs < provisionMs * 1.5) {
    console.log('✓ Parallel provisioning is efficient — no rate limiting detected')
  } else {
    console.log('⚠ Parallel provisioning is slower than expected — possible rate limiting')
  }
}

main().catch(console.error)
