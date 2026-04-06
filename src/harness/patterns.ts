/**
 * Rule-based pattern analyzer. Reads last K session traces and identifies
 * patterns the current harness doesn't handle. No LLM — pure regex matching.
 */
import { readLastTraces } from './traces.js'
import type { SessionTrace } from './traces.js'
// Import FAILURE_SIGNALS from retry.ts to check if patterns are already handled
import { FAILURE_SIGNALS } from '../orchestrator/retry.js'

export type PatternType =
  | 'UnhandledSignal'
  | 'MissingWait'
  | 'CapabilityGapNoTool'
  | 'HighAttempt'

export interface DetectedPattern {
  type: PatternType
  errorEvidence: string[]   // the raw error substrings that triggered this
  occurrences: number       // number of sessions that exhibited this pattern
  priority: number          // lower = higher priority (1 = highest)
}

export interface PatternReport {
  hasPattern: boolean
  topPattern?: DetectedPattern
  allPatterns: DetectedPattern[]
  tracesAnalyzed: number
}

export function analyzePatterns(harnessDir: string, k = 20): PatternReport {
  const traces = readLastTraces(harnessDir, k)

  if (traces.length === 0) {
    return { hasPattern: false, allPatterns: [], tracesAnalyzed: 0 }
  }

  const patterns: DetectedPattern[] = []

  // 1. UnhandledSignal: error substring appears in 3+ sessions' recurring_errors
  //    but matches no existing FAILURE_SIGNALS regex
  const errorCounts = new Map<string, number>()
  for (const trace of traces) {
    // Use a set per session to avoid counting the same error twice in one session
    const seenInSession = new Set<string>()
    for (const err of trace.recurring_errors) {
      // Normalize: take first 100 chars as the "key"
      const key = err.slice(0, 100).toLowerCase()
      if (!seenInSession.has(key)) {
        seenInSession.add(key)
        errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1)
      }
    }
  }

  const unhandledErrors: string[] = []
  for (const [errKey, count] of errorCounts.entries()) {
    if (count >= 3) {
      // Check if any existing FAILURE_SIGNALS regex matches this error snippet
      const isHandled = FAILURE_SIGNALS.some(sig => sig.pattern.test(errKey))
      if (!isHandled) {
        unhandledErrors.push(errKey)
      }
    }
  }

  if (unhandledErrors.length > 0) {
    patterns.push({
      type: 'UnhandledSignal',
      errorEvidence: unhandledErrors.slice(0, 5),
      occurrences: unhandledErrors.length,
      priority: 1,
    })
  }

  // 2. MissingWait: RATE_LIMITED in failure_types but session still failed
  const missingWaitSessions = traces.filter(
    t => t.failure_types.includes('RATE_LIMITED') && t.n_failed > 0,
  )
  if (missingWaitSessions.length >= 2) {
    patterns.push({
      type: 'MissingWait',
      errorEvidence: missingWaitSessions
        .flatMap(t => t.recurring_errors.filter(e => /rate.?limit|429|too many/i.test(e)))
        .slice(0, 3),
      occurrences: missingWaitSessions.length,
      priority: 3,
    })
  }

  // 3. CapabilityGapNoTool: CAPABILITY_GAP in failure_types AND tools_used is empty AND session failed
  const capGapSessions = traces.filter(
    t =>
      t.failure_types.includes('CAPABILITY_GAP') &&
      t.tools_used.length === 0 &&
      t.n_failed > 0,
  )
  if (capGapSessions.length >= 2) {
    patterns.push({
      type: 'CapabilityGapNoTool',
      errorEvidence: capGapSessions
        .flatMap(t => t.recurring_errors)
        .slice(0, 3),
      occurrences: capGapSessions.length,
      priority: 2,
    })
  }

  // 4. HighAttempt: average max attempts >= 3.5 across recent sessions
  if (traces.length >= 3) {
    const avgMaxAttempts =
      traces
        .map(t => (t.attempts_per_agent.length > 0 ? Math.max(...t.attempts_per_agent) : 1))
        .reduce((a, b) => a + b, 0) / traces.length

    if (avgMaxAttempts >= 3.5) {
      patterns.push({
        type: 'HighAttempt',
        errorEvidence: [],
        occurrences: traces.length,
        priority: 4,
      })
    }
  }

  // Sort by priority (lower = higher)
  patterns.sort((a, b) => a.priority - b.priority)

  return {
    hasPattern: patterns.length > 0,
    topPattern: patterns[0],
    allPatterns: patterns,
    tracesAnalyzed: traces.length,
  }
}
