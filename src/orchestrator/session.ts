/**
 * Session state management
 * Reads/writes ~/.usertester/<session-id>/state.json (atomic)
 */
import path from 'node:path'
import fs from 'node:fs'
import type { SessionState, AgentState, AgentStatus } from '../types.js'
import { writeStateAtomic, readState, getSessionDir } from '../output/events.js'

export function createSession(opts: {
  resultsDir: string
  sessionId: string
  url: string
  agentIds: string[]
}): SessionState {
  const agents: AgentState[] = opts.agentIds.map(id => ({
    id,
    status: 'QUEUED',
    updatedAt: Date.now(),
    retryCount: 0,
  }))

  return {
    sessionId: opts.sessionId,
    url: opts.url,
    agents,
    startedAt: Date.now(),
  }
}

export function getStatePath(resultsDir: string, sessionId: string): string {
  return path.join(getSessionDir(resultsDir, sessionId), 'state.json')
}

export function saveSession(resultsDir: string, state: SessionState): void {
  writeStateAtomic(getStatePath(resultsDir, state.sessionId), state)
}

export function loadSession(resultsDir: string, sessionId: string): SessionState | null {
  return readState<SessionState>(getStatePath(resultsDir, sessionId))
}

export function updateAgent(
  state: SessionState,
  agentId: string,
  updates: Partial<AgentState>,
): SessionState {
  return {
    ...state,
    agents: state.agents.map(a =>
      a.id === agentId
        ? { ...a, ...updates, updatedAt: Date.now() }
        : a,
    ),
  }
}

export function transitionAgent(
  state: SessionState,
  agentId: string,
  to: AgentStatus,
  extras?: Partial<AgentState>,
): SessionState {
  return updateAgent(state, agentId, { status: to, ...extras })
}

export function resolveSessionId(resultsDir: string, sessionId?: string): string | null {
  if (sessionId) return sessionId
  // Read current symlink
  try {
    const currentLink = path.join(resultsDir, 'current')
    const target = fs.readlinkSync(currentLink) as string
    return path.basename(target)
  } catch {
    return null
  }
}
