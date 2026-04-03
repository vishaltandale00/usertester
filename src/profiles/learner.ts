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
import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import type { ProfileFacts, HarnessHint, SessionMemory } from '../types.js'

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
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return

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
  const client = new Anthropic({ apiKey })
  const failuresStr = failedActions
    .slice(0, 10)
    .map(a => `- ${a.action}: ${a.observation}`)
    .join('\n')

  let newHints: HarnessHint[] = []
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [
        {
          role: 'user',
          content: `You are analyzing failed browser automation actions to extract reusable hints for future runs.

URL: ${url}
Scenario: ${scenario}
Failed actions:
${failuresStr}

Extract 1-3 brief, actionable hints that would help future automation avoid these failures.
Each hint should be a concrete observation (e.g., "CAPTCHA appears after 3rd form submit attempt").
Reply with JSON array: [{"observation": "...", "confidence": 0.7}]
Only include hints where confidence >= 0.5.`,
        },
      ],
    })

    const block = response.content[0]
    if (block.type === 'text') {
      const match = block.text.match(/\[[\s\S]*\]/)
      if (match) {
        const parsed = JSON.parse(match[0]) as Array<{ observation: string; confidence: number }>
        newHints = parsed.map(h => ({
          observation: h.observation,
          confidence: Math.min(1.0, Math.max(0.0, h.confidence)),
          addedAt: Date.now(),
        }))
      }
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

function writeProfileAtomic(profilePath: string, profile: ProfileFacts): void {
  const tmp = profilePath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(profile, null, 2))
  fs.renameSync(tmp, profilePath)
}
