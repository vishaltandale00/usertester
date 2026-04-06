/**
 * Outer loop meta-harness entry point.
 * Wires traces → patterns → proposer → validator → applier.
 * Called fire-and-forget from the orchestrator after each session.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { UsertesterConfig } from '../types.js'
import type { RetryAttempt } from '../orchestrator/retry.js'
import { buildTrace, writeTrace } from './traces.js'
import { analyzePatterns } from './patterns.js'
import { runProposer, loadConvergenceState, saveConvergenceState, updateConvergenceState } from './proposer.js'
import { validatePatch } from './validator.js'
import { applyPatch } from './applier.js'

export async function runHarnessLoop(opts: {
  sessionId: string
  agentRetryHistories: RetryAttempt[][]   // one array per agent
  agentToolsUsed: string[][]
  agentProfileHits: boolean[]
  agentSucceeded: boolean[]
  url: string
  nAgents: number
  config: Partial<UsertesterConfig>
  harnessDir: string
  projectRoot: string
}): Promise<void> {
  const {
    sessionId,
    agentRetryHistories,
    agentToolsUsed,
    agentProfileHits,
    agentSucceeded,
    url,
    nAgents,
    config,
    harnessDir,
    projectRoot,
  } = opts

  fs.mkdirSync(harnessDir, { recursive: true })

  const harnessLog = path.join(harnessDir, 'harness.log')
  const log = (msg: string) => {
    try {
      fs.appendFileSync(harnessLog, `[${new Date().toISOString()}] ${msg}\n`)
    } catch {}
  }

  log(`Session ${sessionId}: harness loop started (${nAgents} agents, url=${url})`)

  // Step 1: Build and write SessionTrace
  const trace = buildTrace({
    sessionId,
    url,
    agentRetryHistories,
    agentToolsUsed,
    agentProfileHits,
    agentSucceeded,
    nAgents,
  })
  writeTrace(harnessDir, trace)
  log(`Trace written: ${trace.n_succeeded}/${nAgents} succeeded, failure_types=[${trace.failure_types.join(',')}]`)

  // Update convergence state with current session success rate
  const sessionSuccessRate = nAgents > 0 ? trace.n_succeeded / nAgents : 0
  let convergenceState = loadConvergenceState(harnessDir)
  convergenceState = updateConvergenceState(convergenceState, sessionSuccessRate, false)

  // Check if converged — if so, skip analysis
  if (convergenceState.converged) {
    log(`Converged: ${convergenceState.convergenceReason ?? 'unknown reason'}. Skipping.`)
    saveConvergenceState(harnessDir, convergenceState)
    return
  }

  // Step 2: Analyze patterns
  const report = analyzePatterns(harnessDir)
  log(`Pattern analysis: ${report.tracesAnalyzed} traces, hasPattern=${report.hasPattern}, top=${report.topPattern?.type ?? 'none'}`)

  if (!report.hasPattern || !report.topPattern) {
    saveConvergenceState(harnessDir, convergenceState)
    return
  }

  // Step 3: Run proposer
  let patch
  try {
    patch = await runProposer({
      pattern: report.topPattern,
      convergenceState,
      config,
      projectRoot,
    })
  } catch (err) {
    log(`Proposer error: ${err}`)
    saveConvergenceState(harnessDir, convergenceState)
    return
  }

  if (!patch) {
    log('Proposer returned no patch (converged or skipped)')
    saveConvergenceState(harnessDir, convergenceState)
    return
  }

  log(`Proposer patch: ${patch.file} — ${patch.description}`)

  // Step 4: Validate patch
  let validation
  try {
    validation = await validatePatch(patch, projectRoot)
  } catch (err) {
    log(`Validation error: ${err}`)
    saveConvergenceState(harnessDir, convergenceState)
    return
  }

  if (!validation.valid) {
    log(`Patch validation FAILED: ${validation.error}`)
    saveConvergenceState(harnessDir, convergenceState)
    return
  }

  log('Patch validated OK (tsc clean)')

  // Step 5: Apply patch
  let applyResult
  try {
    applyResult = await applyPatch(patch, sessionId, harnessDir, projectRoot)
  } catch (err) {
    log(`Apply error: ${err}`)
    saveConvergenceState(harnessDir, convergenceState)
    return
  }

  if (!applyResult.applied) {
    log(`Patch apply FAILED: ${applyResult.error}`)
    saveConvergenceState(harnessDir, convergenceState)
    return
  }

  log(`Patch applied successfully: ${applyResult.patchId} (${patch.patternType}: ${patch.description})`)

  // Step 6: Update convergence state with patch applied
  convergenceState = updateConvergenceState(convergenceState, sessionSuccessRate, true)
  saveConvergenceState(harnessDir, convergenceState)
}
