/**
 * NDJSON event emitter + per-agent event log writer
 */
import fs from 'node:fs'
import path from 'node:path'
import type { UsertesterEvent, AgentStatus } from '../types.js'

export function emitEvent(event: UsertesterEvent): void {
  process.stdout.write(JSON.stringify(event) + '\n')
}

export function ts(): string {
  return new Date().toISOString()
}

// --- Per-agent event log (push model) ---

export function appendAgentEvent(agentDir: string, data: Record<string, unknown>): void {
  const logPath = path.join(agentDir, 'events.ndjson')
  fs.appendFileSync(logPath, JSON.stringify({ ...data, ts: ts() }) + '\n')
}

export function appendAgentLog(agentDir: string, message: string): void {
  const logPath = path.join(agentDir, 'agent.log')
  fs.appendFileSync(logPath, `[${ts()}] ${message}\n`)
}

// --- State file (atomic write) ---

export function writeStateAtomic(statePath: string, state: unknown): void {
  const tmp = statePath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, statePath)
}

export function readState<T>(statePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8')) as T
  } catch {
    return null
  }
}

// --- Command mailbox ---

export function readPendingCommand(commandsPath: string): import('../types.js').AgentCommand | null {
  try {
    const content = fs.readFileSync(commandsPath, 'utf-8').trim()
    if (!content) return null
    const lines = content.split('\n').filter(Boolean)
    if (lines.length === 0) return null
    // Read last command
    const cmd = JSON.parse(lines[lines.length - 1]) as import('../types.js').AgentCommand
    // Clear the file after reading
    fs.writeFileSync(commandsPath, '')
    return cmd
  } catch {
    return null
  }
}

export function writeCommand(commandsPath: string, cmd: import('../types.js').AgentCommand): void {
  fs.appendFileSync(commandsPath, JSON.stringify(cmd) + '\n')
}

// --- Session dir layout ---

export function getSessionDir(resultsDir: string, sessionId: string): string {
  return path.join(resultsDir, sessionId)
}

export function getAgentDir(sessionDir: string, agentId: string): string {
  return path.join(sessionDir, agentId)
}

export function initSessionDirs(resultsDir: string, sessionId: string, agentIds: string[]): void {
  const sessionDir = getSessionDir(resultsDir, sessionId)
  fs.mkdirSync(sessionDir, { recursive: true })

  for (const agentId of agentIds) {
    const agentDir = getAgentDir(sessionDir, agentId)
    fs.mkdirSync(path.join(agentDir, 'screenshots'), { recursive: true })
    // Create empty command mailbox
    fs.writeFileSync(path.join(agentDir, 'commands.ndjson'), '')
  }

  // Symlink ~/.usertester/current → latest session
  const currentLink = path.join(resultsDir, 'current')
  try { fs.unlinkSync(currentLink) } catch {}
  fs.symlinkSync(sessionDir, currentLink)
}
