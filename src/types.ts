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

export interface RecoveryTip {
  url: string
  scenario: string                // e.g. "signup"
  failedApproaches: string[]      // summaries of what failed (1 per attempt)
  successApproach: string         // what the agent reported on the successful attempt
  toolsUsed: string[]             // tools that were active on success
  finalUrl: string                // confirms we got past the auth wall
  confidence: number              // always 0.95 for a direct observation
  ts: number
}

export interface SessionMemory {
  taskDescription: string
  startUrl: string
  actions: ActionRecord[]
  archivedActionCount: number
  recoveryTips: RecoveryTip[]
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
  openrouter_api_key?: string
  openai_api_key?: string
  /** Customer-specific secret for Cloudflare WAF bypass. Never hardcoded — read from env only. */
  bypass_token?: string
  browserbase_api_key?: string
  browserbase_project_id?: string
  cua_backend: 'stagehand'
  max_agents: number
  cua_concurrency_limit: number
  agent_timeout_ms: number
  screenshot_interval_ms: number
  results_dir: string
  rlm_recent_actions: number
  rlm_max_failed_actions: number
  orchestrator_model: string   // cheap model: summaries, RLM, classifier
  cua_model: string            // browser execution (Stagehand)
  proposer_model: string       // outer harness loop
  max_steps: number            // max Stagehand agent steps per executeTask() call
  execute_timeout_ms: number   // hard timeout for a single agent.execute() call
}

export const DEFAULT_CONFIG: UsertesterConfig = {
  agentmail_api_key: process.env.AGENTMAIL_API_KEY,
  anthropic_api_key: process.env.ANTHROPIC_API_KEY,
  openrouter_api_key: process.env.OPENROUTER_API_KEY,
  openai_api_key: process.env.OPENAI_API_KEY,
  bypass_token: process.env.USERTESTER_BYPASS_TOKEN,
  browserbase_api_key: process.env.BROWSERBASE_API_KEY,
  browserbase_project_id: process.env.BROWSERBASE_PROJECT_ID,
  cua_backend: 'stagehand',
  max_agents: 20,
  cua_concurrency_limit: 5,
  agent_timeout_ms: 300_000,
  screenshot_interval_ms: 2_000,
  results_dir: `${process.env.HOME}/.usertester`,
  rlm_recent_actions: 10,
  rlm_max_failed_actions: 5,
  orchestrator_model: process.env.OPENROUTER_API_KEY
    ? 'openrouter/openai/gpt-5.4-mini'
    : 'anthropic/claude-haiku-4-5-20251001',
  cua_model: process.env.OPENROUTER_API_KEY
    ? 'openrouter/anthropic/claude-opus-4-6'
    : 'anthropic/claude-opus-4-6',
  proposer_model: process.env.OPENROUTER_API_KEY
    ? 'openrouter/anthropic/claude-opus-4-6'
    : 'anthropic/claude-opus-4-6',
  max_steps: 35,
  execute_timeout_ms: 480_000,  // 8 min — long enough for 35 steps, short enough to detect Browserbase session timeout
}
