/**
 * Validates a proposed code patch by:
 * 1. Verifying oldCode appears exactly once in the source file
 * 2. Applying the patch to a temp copy of src/
 * 3. Running tsc --noEmit on the temp copy with a 15-second timeout
 */
import { execFile } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import type { CodePatch } from './proposer.js'

export interface ValidationResult {
  valid: boolean
  error?: string
}

export async function validatePatch(
  patch: CodePatch,
  projectRoot: string,
): Promise<ValidationResult> {
  // Step 1: Verify oldCode appears exactly once
  const absoluteFilePath = path.join(projectRoot, patch.file)
  let originalContents: string
  try {
    originalContents = fs.readFileSync(absoluteFilePath, 'utf-8')
  } catch (err) {
    return { valid: false, error: `Cannot read source file ${patch.file}: ${err}` }
  }

  const occurrences = originalContents.split(patch.oldCode).length - 1
  if (occurrences !== 1) {
    return {
      valid: false,
      error: `oldCode appears ${occurrences} times in ${patch.file} (expected exactly 1)`,
    }
  }

  // Step 2: Create temp dir and copy src/ tree into it
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usertester-validate-'))

  try {
    const srcDir = path.join(projectRoot, 'src')
    const tempSrcDir = path.join(tempDir, 'src')
    copyDirRecursive(srcDir, tempSrcDir)

    // Step 3: Apply the patch to the temp copy
    const patchedContents = originalContents.replace(patch.oldCode, patch.newCode)
    const tempFilePath = path.join(tempDir, patch.file)
    fs.writeFileSync(tempFilePath, patchedContents, 'utf-8')

    // Step 4: Create a minimal tsconfig pointing at the temp src
    const originalTsConfig = path.join(projectRoot, 'tsconfig.json')
    let tsConfigContent: Record<string, unknown>
    try {
      tsConfigContent = JSON.parse(fs.readFileSync(originalTsConfig, 'utf-8')) as Record<string, unknown>
    } catch {
      tsConfigContent = {}
    }

    const tempTsConfig = {
      ...tsConfigContent,
      compilerOptions: {
        ...((tsConfigContent.compilerOptions as Record<string, unknown>) ?? {}),
        rootDir: './src',
        outDir: './dist',
        noEmit: true,
      },
      include: ['src/**/*'],
    }

    fs.writeFileSync(
      path.join(tempDir, 'tsconfig.json'),
      JSON.stringify(tempTsConfig, null, 2),
    )

    // Copy node_modules reference via paths or just use the project root's node_modules
    // We run npx tsc from the project root but point at temp tsconfig
    // Actually simpler: run from project root with explicit rootDir override
    const tscResult = await runTsc(tempDir, projectRoot)
    return tscResult
  } finally {
    // Clean up temp dir
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {}
  }
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  const entries = fs.readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

function runTsc(tempDir: string, projectRoot: string): Promise<ValidationResult> {
  return new Promise((resolve) => {
    const tempTsConfig = path.join(tempDir, 'tsconfig.json')

    // Use npx from project root so node_modules is found
    const child = execFile(
      'npx',
      ['tsc', '--noEmit', '--project', tempTsConfig],
      {
        cwd: projectRoot,
        timeout: 15_000,
      },
      (error, _stdout, stderr) => {
        if (error) {
          const output = stderr || error.message || 'tsc failed'
          resolve({ valid: false, error: output.slice(0, 1000) })
        } else {
          resolve({ valid: true })
        }
      },
    )

    // Safety: kill after 15s if not already timed out
    setTimeout(() => {
      try { child.kill() } catch {}
      resolve({ valid: false, error: 'tsc validation timed out after 15s' })
    }, 15_000)
  })
}
