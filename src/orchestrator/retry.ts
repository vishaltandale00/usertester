/**
 * Autonomous retry loop with failure classification.
 *
 * After each failed agent.execute() call:
 * 1. Classifies WHY it failed (TRANSIENT / WRONG_APPROACH / CAPABILITY_GAP / ENVIRONMENT_BLOCK)
 * 2. Decides recovery strategy
 * 3. Retries with adjusted instruction or new tools injected
 * 4. Stops when: completed, or max attempts reached
 *
 * Based on: Meta-Harness (arxiv:2603.28052) + Live-SWE-agent (arxiv:2511.13646)
 * Key principle: raw trace beats summaries for classification (never summarize before classifying)
 */
import { cheapCall } from '../llm/provider.js'
import { readInboxEmail } from '../tools/inbox.js'
import { solveTurnstile, capsolverAvailable } from '../tools/captcha.js'
import type { UsertesterConfig, RecoveryTip } from '../types.js'

export type FailureType =
  | 'COMPLETE'
  | 'TRANSIENT'
  | 'RATE_LIMITED'
  | 'WRONG_APPROACH'
  | 'CAPABILITY_GAP'
  | 'ENVIRONMENT_BLOCK'
  | 'STEP_LIMIT_EXHAUSTED'
  | 'ESCALATE'

export interface FailureClassification {
  type: FailureType
  evidence: string
  recoveryHint: string
}

export interface RetryAttempt {
  attempt: number
  instruction: string
  toolsInjected: string[]
  result: 'complete' | 'failed'
  failureType?: FailureType
  agentMessage: string
  finalUrl: string
}

export const MAX_ATTEMPTS = 5

// Signal patterns that map to failure types
export const FAILURE_SIGNALS: Array<{ pattern: RegExp; type: FailureType; hint: string }> = [
  {
    pattern: /DNS|ERR_NAME_NOT_RESOLVED|net::ERR|could not resolve|unreachable/i,
    type: 'WRONG_APPROACH',
    hint: 'Do not navigate to external web UIs. Use available API tools instead.',
  },
  {
    pattern: /verification code|6.digit|magic link|check.*email|inbox|sent.*code/i,
    type: 'CAPABILITY_GAP',
    hint: 'Use the readInboxEmail tool to retrieve the verification code from the email inbox.',
  },
  {
    pattern: /only request this after (\d+)|too many requests|rate.?limit|429|resend.*after/i,
    type: 'RATE_LIMITED',
    hint: 'Rate limited — wait the specified cooldown period before retrying.',
  },
  {
    pattern: /timeout|503|temporarily unavailable|connection failed/i,
    type: 'TRANSIENT',
    hint: 'Transient error — retry the same approach after a short wait.',
  },
  {
    pattern: /captcha|CAPTCHA|bot detection|unusual traffic/i,
    type: 'ENVIRONMENT_BLOCK',
    hint: 'CAPTCHA detected — cannot automate this step.',
  },
]

export async function classifyFailure(
  agentMessage: string,
  config: Partial<UsertesterConfig>,
): Promise<FailureClassification> {
  // Fast path: check signal patterns first (no LLM needed)
  for (const { pattern, type, hint } of FAILURE_SIGNALS) {
    if (pattern.test(agentMessage)) {
      return { type, evidence: agentMessage.slice(0, 200), recoveryHint: hint }
    }
  }

  // Slow path: ask the cheap model to classify
  const prompt = `You are classifying why a browser automation agent failed.

Agent failure message:
${agentMessage.slice(0, 800)}

Classify into exactly one of:
- COMPLETE: the task actually succeeded (agent was wrong about failing)
- TRANSIENT: network timeout, rate limit, temporary error — retry same approach
- WRONG_APPROACH: agent used wrong method (e.g. navigated to web UI instead of using API)
- CAPABILITY_GAP: agent knew what it needed but lacked a tool to do it
- ENVIRONMENT_BLOCK: CAPTCHA, auth wall, or structural blocker — cannot automate
- ESCALATE: unclear or unrecoverable

Reply with JSON: {"type": "...", "evidence": "one sentence", "recoveryHint": "one sentence"}`

  try {
    const text = await cheapCall(prompt, config, 150)
    const match = text.match(/\{[\s\S]*\}/)
    if (match) {
      const parsed = JSON.parse(match[0]) as { type?: string; evidence?: string; recoveryHint?: string }
      return {
        type: parsed.type as FailureType,
        evidence: parsed.evidence ?? '',
        recoveryHint: parsed.recoveryHint ?? '',
      }
    }
  } catch {}

  return { type: 'ESCALATE', evidence: agentMessage.slice(0, 100), recoveryHint: 'Manual intervention needed' }
}

// Build a ToolSet to inject based on failure classification
export function selectToolsForRecovery(classification: FailureClassification): Record<string, unknown> {
  const tools: Record<string, unknown> = {}

  if (
    classification.type === 'CAPABILITY_GAP' ||
    (classification.type === 'WRONG_APPROACH' && /email|inbox|code|verification/i.test(classification.evidence))
  ) {
    tools['readInboxEmail'] = readInboxEmail
  }

  // ENVIRONMENT_BLOCK from CAPTCHA: inject solver if CapSolver is configured
  if (
    classification.type === 'ENVIRONMENT_BLOCK' &&
    /captcha|turnstile|cloudflare|verify.*human/i.test(classification.evidence) &&
    capsolverAvailable()
  ) {
    tools['solveTurnstile'] = solveTurnstile
  }

  return tools
}

// Build a constraint addendum to inject into the next attempt's instruction
export function buildRetryInstruction(
  originalInstruction: string,
  history: RetryAttempt[],
  memory?: { recoveryTips?: RecoveryTip[] },
  currentUrl?: string,
): string {
  // --- Recovery tip takes priority over failure constraints ---
  if (memory?.recoveryTips?.length && currentUrl) {
    const tip = memory.recoveryTips.find(t => {
      try {
        return currentUrl.includes(new URL(t.url).hostname) || t.url.includes(currentUrl)
      } catch {
        return false
      }
    })
    if (tip) {
      return [
        `App URL: ${currentUrl} — navigate here if the page is blank or shows an error.`,
        ``,
        `PROVEN APPROACH FOR THIS APP:`,
        `The following approach previously succeeded (tools: ${tip.toolsUsed.join(', ') || 'none'}):`,
        `"${tip.successApproach}"`,
        ``,
        `REPEAT this approach exactly. Ignore any previous context suggesting otherwise.`,
        ``,
        `Task: ${originalInstruction}`,
      ].join('\n')
    }
  }

  // --- Step-limit: just continue where you left off ---
  const lastAttempt = history[history.length - 1]
  if (lastAttempt?.failureType === 'STEP_LIMIT_EXHAUSTED') {
    return [
      `Continue the task from where you left off. The browser is still open.`,
      currentUrl ? `Current URL: ${currentUrl}` : '',
      ``,
      `Original task: ${originalInstruction}`,
      ``,
      `You already made progress. Do NOT start over — pick up from the current page state and finish the remaining steps.`,
    ].filter(Boolean).join('\n')
  }

  // --- Fallback: accumulate failure constraints (existing behavior) ---
  if (history.length === 0) return originalInstruction

  const constraints = history
    .filter(a => a.failureType && a.failureType !== 'TRANSIENT' && a.failureType !== 'COMPLETE')
    .map((a) => `Attempt ${a.attempt} failed (${a.failureType}): ${a.agentMessage.slice(0, 150)}`)

  if (constraints.length === 0) return originalInstruction

  const toolHints = history.some(a => a.toolsInjected.includes('readInboxEmail'))
    ? '\n\nIMPORTANT: You have a readInboxEmail tool available. Use it to read any verification emails — do NOT try to navigate to a web-based inbox.'
    : ''

  // Always pin the URL so the agent never guesses if navigation fails
  const urlPin = currentUrl ? `\nApp URL: ${currentUrl} — always navigate here first if the page is blank or shows an error.` : ''

  return [
    originalInstruction,
    urlPin,
    '',
    '--- Previous attempt context ---',
    ...constraints,
    toolHints,
  ].join('\n')
}
