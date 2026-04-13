/**
 * Orchestrator: manages N agents, concurrency queue, session lifecycle
 */
import crypto from 'node:crypto'
import path from 'node:path'
import type { SessionState, UsertesterConfig } from '../types.js'
import { emitEvent, ts, initSessionDirs } from '../output/events.js'
import { createSession, saveSession, transitionAgent } from './session.js'
import { runAgent } from './agent.js'
import type { RetryAttempt } from './retry.js'
import { runHarnessLoop } from '../harness/index.js'

export async function orchestrate(opts: {
  url: string
  messages: string[]    // one per agent (cycled if fewer than n)
  n: number
  config: UsertesterConfig
  noWait?: boolean
}): Promise<void> {
  const { url, messages, n, config, noWait } = opts

  const sessionId = crypto.randomBytes(4).toString('hex')
  const agentIds = Array.from({ length: n }, (_, i) => `agent-${String(i + 1).padStart(2, '0')}`)

  // Init session dirs
  initSessionDirs(config.results_dir, sessionId, agentIds)

  // Create initial session state
  let state = createSession({ resultsDir: config.results_dir, sessionId, url, agentIds })
  saveSession(config.results_dir, state)

  emitEvent({ event: 'session_start', sessionId, url, n, ts: ts() })

  // State mutation: agents call this to update shared state
  const onStateChange = (newState: SessionState) => {
    state = newState
  }
  const getState = () => state

  // Concurrency queue
  const agentPromises: Promise<void>[] = []
  // Collect per-agent results for the harness loop
  const agentResults: Array<{ retryHistory: RetryAttempt[]; toolsUsed: string[]; profileHit: boolean } | null> =
    new Array(agentIds.length).fill(null)
  const concurrencyLimit = Math.min(config.cua_concurrency_limit, n)
  let activeCount = 0
  let agentIndex = 0

  await new Promise<void>((resolve) => {
    function launchNext() {
      while (activeCount < concurrencyLimit && agentIndex < agentIds.length) {
        const currentIndex = agentIndex++
        const agentId = agentIds[currentIndex]
        const message = messages[currentIndex % messages.length]

        activeCount++

        // Mark as QUEUED → will be updated by runAgent
        const p = runAgent({
          agentId,
          sessionId,
          url,
          initialMessage: message,
          config,
          state,
          onStateChange,
          getState,
          noWait,
        })
          .then(result => {
            agentResults[currentIndex] = result
          })
          .catch(err => {
            const newState = transitionAgent(getState(), agentId, 'FAILED', { error: String(err) })
            onStateChange(newState)
            saveSession(config.results_dir, newState)
            emitEvent({ event: 'failed', agent: agentId, error: String(err), ts: ts() })
          })
          .finally(() => {
            activeCount--
            launchNext()
            if (activeCount === 0 && agentIndex >= agentIds.length) {
              resolve()
            }
          })

        agentPromises.push(p)
      }
    }

    launchNext()

    // Edge case: n=0
    if (agentIds.length === 0) resolve()
  })

  await Promise.allSettled(agentPromises)

  // Outer loop: fire-and-forget harness improvement
  const harnessDir = path.join(config.results_dir, 'harness')
  const agentSucceeded = state.agents.map(a => ['DONE', 'WAITING'].includes(a.status))
  runHarnessLoop({
    sessionId,
    agentRetryHistories: agentResults.map(r => r?.retryHistory ?? []),
    agentToolsUsed: agentResults.map(r => r?.toolsUsed ?? []),
    agentProfileHits: agentResults.map(r => r?.profileHit ?? false),
    agentSucceeded,
    url,
    nAgents: n,
    config,
    harnessDir,
    projectRoot: new URL('../..', import.meta.url).pathname,
  }).catch(() => {})  // never throw — outer loop is non-fatal

  emitEvent({ event: 'session_complete', sessionId, ts: ts() })
}
