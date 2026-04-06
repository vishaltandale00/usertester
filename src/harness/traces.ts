/**
 * Session trace writer — appends one structured line per session to
 * ~/.usertester/harness/traces.ndjson for the outer loop pattern analyzer.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { FailureType } from '../orchestrator/retry.js'
import type { RetryAttempt } from '../orchestrator/retry.js'

export interface SessionTrace {
  session_id: string
  url: string
  ts: string
  n_agents: number
  n_succeeded: number
  n_failed: number
  failure_types: FailureType[]
  recurring_errors: string[]      // raw agentMessage slices from failed retries, deduped
  tools_used: string[]
  attempts_per_agent: number[]
  profile_hit: boolean            // was a RecoveryTip pre-injected from profile?
}

export function writeTrace(harnessDir: string, trace: SessionTrace): void {
  fs.mkdirSync(harnessDir, { recursive: true })
  const tracePath = path.join(harnessDir, 'traces.ndjson')
  fs.appendFileSync(tracePath, JSON.stringify(trace) + '\n')
}

export function readLastTraces(harnessDir: string, k = 20): SessionTrace[] {
  const tracePath = path.join(harnessDir, 'traces.ndjson')
  try {
    const content = fs.readFileSync(tracePath, 'utf-8')
    return content
      .split('\n')
      .filter(Boolean)
      .slice(-k)
      .map(line => JSON.parse(line) as SessionTrace)
  } catch {
    return []
  }
}

/**
 * Build a SessionTrace from per-agent retry histories.
 */
export function buildTrace(opts: {
  sessionId: string
  url: string
  agentRetryHistories: RetryAttempt[][]
  agentToolsUsed: string[][]
  agentProfileHits: boolean[]
  agentSucceeded: boolean[]
  nAgents: number
}): SessionTrace {
  const { sessionId, url, agentRetryHistories, agentToolsUsed, agentProfileHits, agentSucceeded, nAgents } = opts

  const n_succeeded = agentSucceeded.filter(Boolean).length
  const n_failed = nAgents - n_succeeded

  // Collect all failure types across all agents
  const failure_types: FailureType[] = [
    ...new Set(
      agentRetryHistories
        .flat()
        .filter(a => a.result === 'failed' && a.failureType)
        .map(a => a.failureType as FailureType),
    ),
  ]

  // Collect unique error message slices from failed retries
  const errorSlices = agentRetryHistories
    .flat()
    .filter(a => a.result === 'failed')
    .map(a => a.agentMessage.slice(0, 200))

  const recurring_errors = [...new Set(errorSlices)]

  // Collect all tools used
  const tools_used = [...new Set(agentToolsUsed.flat())]

  // Attempts per agent = number of retry entries per agent + 1 (first attempt)
  const attempts_per_agent = agentRetryHistories.map(h => h.length + 1)

  const profile_hit = agentProfileHits.some(Boolean)

  return {
    session_id: sessionId,
    url,
    ts: new Date().toISOString(),
    n_agents: nAgents,
    n_succeeded,
    n_failed,
    failure_types,
    recurring_errors,
    tools_used,
    attempts_per_agent,
    profile_hit,
  }
}
