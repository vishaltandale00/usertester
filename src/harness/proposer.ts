/**
 * LLM code proposer for the outer loop meta-harness.
 * Uses the proposer_model (defaults to anthropic/claude-opus-4-6) to generate
 * code patches that address detected failure patterns.
 */
import fs from 'node:fs'
import path from 'node:path'
import { generateText } from 'ai'
import { resolveModel } from '../llm/provider.js'
import type { UsertesterConfig } from '../types.js'
import type { DetectedPattern } from './patterns.js'

export interface CodePatch {
  file: 'src/orchestrator/retry.ts' | 'src/browser/agent.ts'
  oldCode: string
  newCode: string
  description: string
  patternType: string
}

export interface ConvergenceState {
  patchesApplied: number
  lastPatchAt: string | null
  sessionsSinceLastPatch: number
  successRateHistory: number[]   // last 5 session success rates
  converged: boolean
  convergenceReason?: string
}

export function loadConvergenceState(harnessDir: string): ConvergenceState {
  const statePath = path.join(harnessDir, 'harness_state.json')
  try {
    const content = fs.readFileSync(statePath, 'utf-8')
    return JSON.parse(content) as ConvergenceState
  } catch {
    return {
      patchesApplied: 0,
      lastPatchAt: null,
      sessionsSinceLastPatch: 0,
      successRateHistory: [],
      converged: false,
    }
  }
}

export function saveConvergenceState(harnessDir: string, state: ConvergenceState): void {
  fs.mkdirSync(harnessDir, { recursive: true })
  const statePath = path.join(harnessDir, 'harness_state.json')
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
}

export function updateConvergenceState(
  state: ConvergenceState,
  sessionSuccessRate: number,
  patchApplied: boolean,
): ConvergenceState {
  const newHistory = [...state.successRateHistory, sessionSuccessRate].slice(-5)
  const newSessionsSince = patchApplied ? 0 : state.sessionsSinceLastPatch + 1

  // Check convergence criteria
  let converged = state.converged
  let convergenceReason = state.convergenceReason

  if (state.patchesApplied >= 20) {
    converged = true
    convergenceReason = 'Max patches applied (20)'
  } else if (newSessionsSince >= 5 && newHistory.length >= 5) {
    const improvement = Math.max(...newHistory) - Math.min(...newHistory)
    if (improvement < 0.005) {
      converged = true
      convergenceReason = 'Success rate stable for 5 sessions (improvement < 0.5%)'
    }
  }

  return {
    patchesApplied: patchApplied ? state.patchesApplied + 1 : state.patchesApplied,
    lastPatchAt: patchApplied ? new Date().toISOString() : state.lastPatchAt,
    sessionsSinceLastPatch: newSessionsSince,
    successRateHistory: newHistory,
    converged,
    convergenceReason,
  }
}

function buildProposerPrompt(
  pattern: DetectedPattern,
  targetFile: 'src/orchestrator/retry.ts' | 'src/browser/agent.ts',
  fileContents: string,
): string {
  const taskDescription = getTaskDescription(pattern, targetFile)

  return `You are an expert TypeScript engineer improving an AI browser automation harness.

DETECTED PATTERN: ${pattern.type}
Error evidence (${pattern.occurrences} sessions):
${pattern.errorEvidence.map(e => `  - "${e}"`).join('\n')}

TARGET FILE: ${targetFile}
CURRENT FILE CONTENTS:
\`\`\`typescript
${fileContents}
\`\`\`

TASK:
${taskDescription}

HARD CONSTRAINTS:
- Never remove or modify existing FAILURE_SIGNALS entries
- The oldCode field must be VERBATIM text that appears EXACTLY ONCE in the file
- Change fewer than 50 lines total
- The newCode must be valid TypeScript
- Do not change imports unless strictly necessary

Respond with a single JSON object (no markdown fences, no extra text):
{
  "file": "${targetFile}",
  "oldCode": "<verbatim substring from the file to replace>",
  "newCode": "<replacement code>",
  "description": "<one sentence describing the change>",
  "patternType": "${pattern.type}"
}`
}

function getTaskDescription(
  pattern: DetectedPattern,
  targetFile: 'src/orchestrator/retry.ts' | 'src/browser/agent.ts',
): string {
  switch (pattern.type) {
    case 'UnhandledSignal':
      return `Add a new entry to the FAILURE_SIGNALS array in ${targetFile} that matches the unhandled error patterns. The new entry should have an appropriate pattern regex, FailureType, and recovery hint.`

    case 'CapabilityGapNoTool':
      return `Update selectToolsForRecovery() in ${targetFile} to inject the appropriate tool(s) for the capability gap being detected. Look at the error evidence to determine which tool is missing.`

    case 'MissingWait':
      return `Improve the RATE_LIMITED handling in ${targetFile} to better extract and apply wait times from rate limit responses. Ensure the wait logic covers the error patterns shown.`

    case 'HighAttempt':
      return `Review the retry strategy in ${targetFile} and add a more intelligent backoff or early-exit condition to reduce unnecessary retries when the agent is clearly stuck.`

    default:
      return `Improve error handling in ${targetFile} to address the detected pattern: ${pattern.type}.`
  }
}

function selectTargetFile(
  pattern: DetectedPattern,
): 'src/orchestrator/retry.ts' | 'src/browser/agent.ts' {
  switch (pattern.type) {
    case 'UnhandledSignal':
    case 'MissingWait':
    case 'CapabilityGapNoTool':
      return 'src/orchestrator/retry.ts'
    case 'HighAttempt':
      return 'src/browser/agent.ts'
    default:
      return 'src/orchestrator/retry.ts'
  }
}

export async function runProposer(opts: {
  pattern: DetectedPattern
  convergenceState: ConvergenceState
  config: Partial<UsertesterConfig>
  projectRoot: string
}): Promise<CodePatch | null> {
  const { pattern, convergenceState, config, projectRoot } = opts

  // Check convergence — don't propose if converged
  if (convergenceState.converged) {
    return null
  }

  const targetFile = selectTargetFile(pattern)
  const absoluteFilePath = path.join(projectRoot, targetFile)

  let fileContents: string
  try {
    fileContents = fs.readFileSync(absoluteFilePath, 'utf-8')
  } catch (err) {
    throw new Error(`Cannot read ${absoluteFilePath}: ${err}`)
  }

  const prompt = buildProposerPrompt(pattern, targetFile, fileContents)

  const modelString = config.proposer_model ?? 'anthropic/claude-opus-4-6'
  const model = resolveModel(modelString, config)

  let text: string
  try {
    const result = await generateText({
      model,
      messages: [{ role: 'user', content: prompt }],
      maxOutputTokens: 2000,
    })
    text = result.text
  } catch (err) {
    throw new Error(`Proposer LLM call failed: ${err}`)
  }

  // Parse JSON from response — same pattern as classifyFailure
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) {
    throw new Error(`Proposer returned no JSON. Response: ${text.slice(0, 200)}`)
  }

  let parsed: Partial<CodePatch>
  try {
    parsed = JSON.parse(match[0]) as Partial<CodePatch>
  } catch (err) {
    throw new Error(`Proposer JSON parse failed: ${err}. Raw: ${match[0].slice(0, 200)}`)
  }

  if (!parsed.file || !parsed.oldCode || !parsed.newCode || !parsed.description) {
    throw new Error(`Proposer returned incomplete patch: ${JSON.stringify(parsed)}`)
  }

  // Validate file field
  if (
    parsed.file !== 'src/orchestrator/retry.ts' &&
    parsed.file !== 'src/browser/agent.ts'
  ) {
    throw new Error(`Proposer returned invalid file: ${parsed.file}`)
  }

  const patch: CodePatch = {
    file: parsed.file,
    oldCode: parsed.oldCode,
    newCode: parsed.newCode,
    description: parsed.description,
    patternType: parsed.patternType ?? pattern.type,
  }

  // Verify oldCode appears exactly once in the file
  const occurrences = fileContents.split(patch.oldCode).length - 1
  if (occurrences !== 1) {
    throw new Error(
      `Proposed oldCode appears ${occurrences} times in ${patch.file} (expected exactly 1). ` +
        `oldCode: "${patch.oldCode.slice(0, 100)}"`,
    )
  }

  return patch
}
