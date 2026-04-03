/**
 * Shared types for usertester-agent
 */

// --- Agent state machine ---

export type AgentStatus =
  | 'QUEUED'
  | 'SPAWNING'
  | 'INBOX_READY'
  | 'SIGNING_UP'
  | 'RUNNING'
  | 'WAITING'
  | 'DONE'
  | 'FAILED'
  | 'CANCELLED'

export interface AgentState {
  id: string            // e.g. "agent-01"
  status: AgentStatus
  inboxId?: string      // e.g. "abc123@agentmail.to"
  currentMessage?: string
  startedAt?: number    // ms since epoch
  updatedAt: number
  error?: string
  lastScreenshot?: string
  retryCount: number
}

export interface SessionState {
  sessionId: string
  url: string
  agents: AgentState[]
  startedAt: number
  completedAt?: number
}

// --- RLM memory ---

export interface ActionRecord {
  ts: number
  action: string
  selector?: string
  result: 'success' | 'failed' | 'skipped'
  observation?: string
  url?: string
}

export interface SessionMemory {
  taskDescription: string
  startUrl: string
  actions: ActionRecord[]
  archivedActionCount: number
}

// --- Profile meta-learning ---

export interface HarnessHint {
  observation: string   // "signup button is inside an iframe"
  confidence: number    // 0.0–1.0
  addedAt: number
}

export interface ProfileFacts {
  url: string
  scenario: string      // e.g. "signup", "checkout"
  harnessHints: HarnessHint[]
  runCount: number
  lastRunAt: number
}

// --- NDJSON event schema ---

export type UsertesterEvent =
  | { event: 'session_start'; sessionId: string; url: string; n: number; ts: string }
  | { event: 'spawned'; agent: string; inbox: string; ts: string }
  | { event: 'state'; agent: string; from: AgentStatus; to: AgentStatus; message?: string; ts: string }
  | { event: 'ready'; agent: string; message_completed: string; summary: string; screenshot?: string; ts: string }
  | { event: 'failed'; agent: string; error: string; ts: string }
  | { event: 'session_complete'; sessionId: string; ts: string }

// --- IPC command types ---

export interface AgentCommand {
  type: 'send' | 'kill'
  message?: string      // for 'send'
  issuedAt: number
}

// --- Config ---

export interface UsertesterConfig {
  agentmail_api_key?: string
  anthropic_api_key?: string
  cua_backend: 'stagehand'
  max_agents: number
  cua_concurrency_limit: number
  agent_timeout_ms: number
  screenshot_interval_ms: number
  results_dir: string
  rlm_recent_actions: number
  rlm_max_failed_actions: number
}

export const DEFAULT_CONFIG: UsertesterConfig = {
  agentmail_api_key: process.env.AGENTMAIL_API_KEY,
  anthropic_api_key: process.env.ANTHROPIC_API_KEY,
  cua_backend: 'stagehand',
  max_agents: 20,
  cua_concurrency_limit: 5,
  agent_timeout_ms: 300_000,
  screenshot_interval_ms: 2_000,
  results_dir: `${process.env.HOME}/.usertester`,
  rlm_recent_actions: 10,
  rlm_max_failed_actions: 5,
}
