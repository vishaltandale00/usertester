/**
 * usertester harness — inspect and manage the outer loop meta-harness
 *
 * Subcommands:
 *   status            — show convergence state + recent patterns
 *   patches           — list applied patches
 *   rollback <id>     — roll back a patch by ID
 */
import type { Command } from 'commander'
import path from 'node:path'
import { DEFAULT_CONFIG } from '../types.js'
import { readLastTraces } from '../harness/traces.js'
import { analyzePatterns } from '../harness/patterns.js'
import { loadConvergenceState } from '../harness/proposer.js'
import { listPatchRecords, rollbackPatch } from '../harness/applier.js'

export function registerHarness(program: Command): void {
  const harness = program
    .command('harness')
    .description('Inspect and manage the outer loop meta-harness')

  // harness status
  harness
    .command('status')
    .description('Show convergence state, recent traces, and top detected pattern')
    .option('--results-dir <dir>', 'Results directory', DEFAULT_CONFIG.results_dir)
    .action((opts) => {
      const resultsDir = opts.resultsDir ?? DEFAULT_CONFIG.results_dir
      const harnessDir = path.join(resultsDir, 'harness')

      const state = loadConvergenceState(harnessDir)
      const traces = readLastTraces(harnessDir, 5)
      const report = analyzePatterns(harnessDir)

      console.log('=== Harness Status ===')
      console.log()
      console.log('Convergence:')
      console.log(`  Patches applied:       ${state.patchesApplied}`)
      console.log(`  Sessions since patch:   ${state.sessionsSinceLastPatch}`)
      console.log(`  Last patch at:          ${state.lastPatchAt ?? 'never'}`)
      console.log(`  Converged:              ${state.converged}`)
      if (state.convergenceReason) {
        console.log(`  Convergence reason:     ${state.convergenceReason}`)
      }
      if (state.successRateHistory.length > 0) {
        const rates = state.successRateHistory.map(r => `${(r * 100).toFixed(0)}%`).join(', ')
        console.log(`  Success rate history:   [${rates}]`)
      }

      console.log()
      console.log(`Recent Traces (last 5 of ${report.tracesAnalyzed} total):`)
      if (traces.length === 0) {
        console.log('  (none yet)')
      } else {
        for (const t of traces) {
          const rate = t.n_agents > 0 ? Math.round((t.n_succeeded / t.n_agents) * 100) : 0
          console.log(
            `  [${t.ts.slice(0, 19)}] session=${t.session_id} ` +
            `${t.n_succeeded}/${t.n_agents} OK (${rate}%) ` +
            `failures=[${t.failure_types.join(',')}]`,
          )
        }
      }

      console.log()
      console.log('Pattern Analysis:')
      if (!report.hasPattern) {
        console.log('  No actionable patterns detected.')
      } else {
        for (const p of report.allPatterns) {
          const marker = p === report.topPattern ? '* ' : '  '
          console.log(`${marker}${p.type} (${p.occurrences} sessions, priority=${p.priority})`)
          if (p.errorEvidence.length > 0) {
            for (const e of p.errorEvidence.slice(0, 2)) {
              console.log(`    evidence: "${e.slice(0, 80)}"`)
            }
          }
        }
      }
    })

  // harness patches
  harness
    .command('patches')
    .description('List all applied patches')
    .option('--results-dir <dir>', 'Results directory', DEFAULT_CONFIG.results_dir)
    .action((opts) => {
      const resultsDir = opts.resultsDir ?? DEFAULT_CONFIG.results_dir
      const harnessDir = path.join(resultsDir, 'harness')

      const records = listPatchRecords(harnessDir)

      if (records.length === 0) {
        console.log('No patches applied yet.')
        return
      }

      console.log(`${records.length} patch(es) applied:\n`)
      for (const r of records) {
        console.log(`  ${r.patchId}  [${r.appliedAt.slice(0, 19)}]  ${r.patternType}`)
        console.log(`    file:    ${r.file}`)
        console.log(`    desc:    ${r.description}`)
        console.log(`    session: ${r.triggerSessionId}`)
        console.log()
      }
    })

  // harness rollback <patch-id>
  harness
    .command('rollback <patch-id>')
    .description('Roll back a patch by ID (e.g. patch_001)')
    .option('--results-dir <dir>', 'Results directory', DEFAULT_CONFIG.results_dir)
    .action(async (patchId: string, opts) => {
      const resultsDir = opts.resultsDir ?? DEFAULT_CONFIG.results_dir
      const harnessDir = path.join(resultsDir, 'harness')
      const projectRoot = new URL('../../..', import.meta.url).pathname

      console.log(`Rolling back ${patchId}...`)
      const result = await rollbackPatch(patchId, harnessDir, projectRoot)

      if (result.rolledBack) {
        console.log(`Rollback successful: ${patchId} has been reverted.`)
      } else {
        console.error(`Rollback failed: ${result.error}`)
        process.exit(1)
      }
    })
}
