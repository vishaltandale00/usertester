/**
 * Profile meta-learning system
 *
 * After each session, extract reusable observations from session memory
 * and persist them as facts.json per (url, scenario).
 *
 * Next run: agent loads these hints via BrowserAgent.start(profileFacts).
 * Repeated failures become high-confidence hints ("avoid CAPTCHA on form submit").
 *
 * Inspired by the meta-harness paper (arxiv:2603.28052): post-session outer loop
 * that reads execution traces and updates the harness config.
 */
import path from 'node:path'
import fs from 'node:fs'
import type { ProfileFacts, HarnessHint, SessionMemory, RecoveryTip } from '../types.js'
import { cheapCall } from '../llm/provider.js'

const PROFILES_DIR_NAME = 'profiles'

function profileKey(url: string, scenario: string): string {
  // Stable key from url domain + scenario
  const domain = new URL(url).hostname.replace(/\./g, '_')
  return `${domain}_${scenario}`
}

function getProfilePath(resultsDir: string, url: string, scenario: string): string {
  const profilesDir = path.join(resultsDir, PROFILES_DIR_NAME)
  fs.mkdirSync(profilesDir, { recursive: true })
  return path.join(profilesDir, `${profileKey(url, scenario)}.json`)
}

export function loadProfile(
  resultsDir: string,
  url: string,
  scenario: string,
): ProfileFacts | null {
  const profilePath = getProfilePath(resultsDir, url, scenario)
  try {
    return JSON.parse(fs.readFileSync(profilePath, 'utf-8')) as ProfileFacts
  } catch {
    return null
  }
}

export async function updateProfile(
  resultsDir: string,
  url: string,
  scenario: string,
  memory: SessionMemory,
): Promise<void> {
  const profilePath = getProfilePath(resultsDir, url, scenario)
  const existing = loadProfile(resultsDir, url, scenario) ?? {
    url,
    scenario,
    harnessHints: [],
    runCount: 0,
    lastRunAt: Date.now(),
  }

  const failedActions = memory.actions.filter(a => a.result === 'failed')
  if (failedActions.length === 0 && existing.harnessHints.length > 0) {
    // Perfect run — bump confidence on existing hints, update run count
    existing.runCount++
    existing.lastRunAt = Date.now()
    existing.harnessHints = existing.harnessHints.map(h => ({
      ...h,
      confidence: Math.min(1.0, h.confidence + 0.1),
    }))
    writeProfileAtomic(profilePath, existing)
    return
  }

  // Extract new hints from failures using LLM
  const failuresStr = failedActions
    .slice(0, 10)
    .map(a => `- ${a.action}: ${a.observation}`)
    .join('\n')

  let newHints: HarnessHint[] = []
  try {
    const responseText = await cheapCall(
      `You are analyzing failed browser automation actions to extract reusable hints for future runs.

URL: ${url}
Scenario: ${scenario}
Failed actions:
${failuresStr}

Extract 1-3 brief, actionable hints that would help future automation avoid these failures.
Each hint should be a concrete observation (e.g., "CAPTCHA appears after 3rd form submit attempt").
Reply with JSON array: [{"observation": "...", "confidence": 0.7}]
Only include hints where confidence >= 0.5.`,
      undefined,
      400,
    )

    const match = responseText.match(/\[[\s\S]*\]/)
    if (match) {
      const parsed = JSON.parse(match[0]) as Array<{ observation: string; confidence: number }>
      newHints = parsed.map(h => ({
        observation: h.observation,
        confidence: Math.min(1.0, Math.max(0.0, h.confidence)),
        addedAt: Date.now(),
      }))
    }
  } catch {
    // Learner failures are non-fatal
  }

  // Merge: update confidence on existing similar hints, add new ones
  const updated = mergeHints(existing.harnessHints, newHints)

  const profile: ProfileFacts = {
    ...existing,
    harnessHints: updated,
    runCount: existing.runCount + 1,
    lastRunAt: Date.now(),
  }

  writeProfileAtomic(profilePath, profile)
}

function mergeHints(existing: HarnessHint[], newHints: HarnessHint[]): HarnessHint[] {
  const merged = [...existing]

  for (const hint of newHints) {
    // Check for similar existing hint (simple substring match)
    const similar = merged.findIndex(h =>
      h.observation.toLowerCase().includes(hint.observation.toLowerCase().slice(0, 20)),
    )
    if (similar >= 0) {
      // Boost confidence
      merged[similar] = {
        ...merged[similar],
        confidence: Math.min(1.0, merged[similar].confidence + 0.15),
      }
    } else {
      merged.push(hint)
    }
  }

  // Keep top 10 by confidence, prune low-confidence stale hints
  return merged
    .filter(h => h.confidence > 0.3)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 10)
}

export async function updateProfileWithSuccess(
  resultsDir: string,
  tip: RecoveryTip,
): Promise<void> {
  const profilePath = getProfilePath(resultsDir, tip.url, tip.scenario)
  const existing = loadProfile(resultsDir, tip.url, tip.scenario) ?? {
    url: tip.url,
    scenario: tip.scenario,
    harnessHints: [],
    runCount: 0,
    lastRunAt: Date.now(),
  }

  // MemCollab intersection: discard hints that contradict the proven approach
  // A hint contradicts if it recommends an approach NOT used in the success
  const filteredHints = existing.harnessHints.filter(hint => {
    // Discard hints that recommend approaches explicitly absent from success
    const contradicts = hint.observation.toLowerCase().includes('password instead') &&
      !tip.successApproach.toLowerCase().includes('password')
    return !contradicts
  })

  // Add recovery tip as top-priority hint
  const recoveryHint: HarnessHint = {
    observation: `PROVEN APPROACH: ${tip.successApproach.slice(0, 300)}. Tools that worked: ${tip.toolsUsed.join(', ') || 'none'}.`,
    confidence: 0.97,
    addedAt: tip.ts,
  }

  // Merge: recovery tip first, then filtered existing hints, deduped
  const merged = [recoveryHint, ...filteredHints]
    .filter(h => h.confidence > 0.3)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5)  // Keep only top 5 — K=3-5 is empirically sufficient

  const profile: ProfileFacts = {
    ...existing,
    harnessHints: merged,
    runCount: existing.runCount + 1,
    lastRunAt: Date.now(),
  }

  writeProfileAtomic(profilePath, profile)
}

function extractKeywords(text: string): string[] {
  // Extract meaningful action words — naive but effective for O(1) comparison
  const stopwords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'with', 'by'])
  return text.toLowerCase()
    .split(/\W+/)
    .filter(w => w.length > 3 && !stopwords.has(w))
}

function writeProfileAtomic(profilePath: string, profile: ProfileFacts): void {
  const tmp = profilePath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(profile, null, 2))
  fs.renameSync(tmp, profilePath)
}
