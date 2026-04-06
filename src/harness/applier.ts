/**
 * Atomically applies a validated code patch and records a PatchRecord.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { CodePatch } from './proposer.js'

export interface PatchRecord {
  patchId: string         // patch_001, patch_002, etc.
  appliedAt: string
  triggerSessionId: string
  patternType: string
  file: string
  before: string          // full file contents before
  after: string           // full file contents after
  description: string
}

export async function applyPatch(
  patch: CodePatch,
  triggerSessionId: string,
  harnessDir: string,
  projectRoot: string,
): Promise<{ applied: boolean; patchId?: string; error?: string }> {
  // Step 1: Determine next patchId
  const patchesDir = path.join(harnessDir, 'patches')
  fs.mkdirSync(patchesDir, { recursive: true })

  let nextN = 1
  try {
    const existing = fs.readdirSync(patchesDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const match = f.match(/patch_(\d+)\.json/)
        return match ? parseInt(match[1], 10) : 0
      })
    if (existing.length > 0) {
      nextN = Math.max(...existing) + 1
    }
  } catch {}

  const patchId = `patch_${String(nextN).padStart(3, '0')}`

  // Step 2: Read source file
  const absoluteFilePath = path.join(projectRoot, patch.file)
  let before: string
  try {
    before = fs.readFileSync(absoluteFilePath, 'utf-8')
  } catch (err) {
    return { applied: false, error: `Cannot read ${patch.file}: ${err}` }
  }

  // Step 3: Verify oldCode appears exactly once (double-check)
  const occurrences = before.split(patch.oldCode).length - 1
  if (occurrences !== 1) {
    return {
      applied: false,
      error: `oldCode appears ${occurrences} times in ${patch.file} (expected exactly 1)`,
    }
  }

  // Step 4: Build new contents
  const after = before.replace(patch.oldCode, patch.newCode)

  // Step 5: Write PatchRecord FIRST (atomic)
  const record: PatchRecord = {
    patchId,
    appliedAt: new Date().toISOString(),
    triggerSessionId,
    patternType: patch.patternType,
    file: patch.file,
    before,
    after,
    description: patch.description,
  }

  const recordPath = path.join(patchesDir, `${patchId}.json`)
  try {
    fs.writeFileSync(recordPath, JSON.stringify(record, null, 2), 'utf-8')
  } catch (err) {
    return { applied: false, error: `Cannot write patch record: ${err}` }
  }

  // Step 6: Write new source file atomically (.tmp then rename)
  const tmpPath = absoluteFilePath + `.${patchId}.tmp`
  try {
    fs.writeFileSync(tmpPath, after, 'utf-8')
    fs.renameSync(tmpPath, absoluteFilePath)
  } catch (err) {
    // Clean up tmp if rename failed
    try { fs.unlinkSync(tmpPath) } catch {}
    return { applied: false, error: `Cannot write patched file: ${err}` }
  }

  // Step 7: Append to applier.log
  const logLine = `[${record.appliedAt}] ${patchId} applied to ${patch.file}: ${patch.description} (session: ${triggerSessionId})\n`
  try {
    fs.appendFileSync(path.join(harnessDir, 'applier.log'), logLine)
  } catch {}

  return { applied: true, patchId }
}

/**
 * Read a patch record by ID.
 */
export function readPatchRecord(harnessDir: string, patchId: string): PatchRecord | null {
  const recordPath = path.join(harnessDir, 'patches', `${patchId}.json`)
  try {
    const content = fs.readFileSync(recordPath, 'utf-8')
    return JSON.parse(content) as PatchRecord
  } catch {
    return null
  }
}

/**
 * List all patch records sorted by patchId ascending.
 */
export function listPatchRecords(harnessDir: string): PatchRecord[] {
  const patchesDir = path.join(harnessDir, 'patches')
  try {
    const files = fs.readdirSync(patchesDir)
      .filter(f => f.endsWith('.json'))
      .sort()
    return files.map(f => {
      try {
        return JSON.parse(fs.readFileSync(path.join(patchesDir, f), 'utf-8')) as PatchRecord
      } catch {
        return null
      }
    }).filter((r): r is PatchRecord => r !== null)
  } catch {
    return []
  }
}

/**
 * Rollback a patch by writing the `before` contents back to the source file.
 */
export async function rollbackPatch(
  patchId: string,
  harnessDir: string,
  projectRoot: string,
): Promise<{ rolledBack: boolean; error?: string }> {
  const record = readPatchRecord(harnessDir, patchId)
  if (!record) {
    return { rolledBack: false, error: `Patch record not found: ${patchId}` }
  }

  const absoluteFilePath = path.join(projectRoot, record.file)
  const tmpPath = absoluteFilePath + `.rollback-${patchId}.tmp`

  try {
    fs.writeFileSync(tmpPath, record.before, 'utf-8')
    fs.renameSync(tmpPath, absoluteFilePath)
  } catch (err) {
    try { fs.unlinkSync(tmpPath) } catch {}
    return { rolledBack: false, error: `Cannot write rollback: ${err}` }
  }

  const logLine = `[${new Date().toISOString()}] ROLLBACK ${patchId} (file: ${record.file})\n`
  try {
    fs.appendFileSync(path.join(harnessDir, 'applier.log'), logLine)
  } catch {}

  return { rolledBack: true }
}

/**
 * Write a rollback using the temp file approach for atomicity.
 */
export async function rollbackPatchAtomic(
  patchId: string,
  harnessDir: string,
  projectRoot: string,
): Promise<{ rolledBack: boolean; error?: string }> {
  return rollbackPatch(patchId, harnessDir, projectRoot)
}
