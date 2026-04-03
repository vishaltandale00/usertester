/**
 * Agent runner: manages a single agent's lifecycle through the state machine.
 * Runs in its own async context (spawned by orchestrator).
 *
 * State machine:
 *   QUEUED → SPAWNING → INBOX_READY → SIGNING_UP → RUNNING → WAITING
 *                                                      |          |
 *                                                      └──────────► FAILED
 * WAITING → (send received) → RUNNING
 * WAITING → (kill received) → CANCELLED
 * RUNNING → (kill received) → CANCELLED
 */
import path from 'node:path'
import fs from 'node:fs'
import type { AgentStatus, SessionState, UsertesterConfig } from '../types.js'
import { BrowserAgent } from '../browser/agent.js'
import { InboxManager } from '../inbox/agentmail.js'
import {
  emitEvent,
  ts,
  appendAgentLog,
  appendAgentEvent,
  getAgentDir,
  readPendingCommand,
} from '../output/events.js'
import { saveSession, transitionAgent } from './session.js'
import { loadProfile, updateProfile } from '../profiles/learner.js'

const COMMAND_POLL_MS = 500
const MAX_RETRIES = 3

export async function runAgent(opts: {
  agentId: string
  sessionId: string
  url: string
  initialMessage: string
  config: UsertesterConfig
  state: SessionState
  onStateChange: (newState: SessionState) => void
  getState: () => SessionState
}): Promise<void> {
  const { agentId, sessionId, url, initialMessage, config } = opts
  const sessionDir = path.join(config.results_dir, sessionId)
  const agentDir = getAgentDir(sessionDir, agentId)

  const transition = (to: AgentStatus, extras?: Record<string, unknown>) => {
    appendAgentLog(agentDir, `State → ${to}`)
    appendAgentEvent(agentDir, { event: 'state', from: opts.getState().agents.find(a => a.id === agentId)?.status, to, ...extras })
    const newState = transitionAgent(opts.getState(), agentId, to, extras as any)
    opts.onStateChange(newState)
    saveSession(config.results_dir, newState)
    emitEvent({
      event: 'state',
      agent: agentId,
      from: opts.getState().agents.find(a => a.id === agentId)?.status as AgentStatus,
      to,
      ts: ts(),
    })
  }

  const fail = (error: string) => {
    appendAgentLog(agentDir, `FAILED: ${error}`)
    transition('FAILED', { error })
    emitEvent({ event: 'failed', agent: agentId, error, ts: ts() })
  }

  // --- SPAWNING: provision inbox ---
  transition('SPAWNING')

  let inboxId: string
  try {
    const inboxMgr = new InboxManager(config.agentmail_api_key!)
    const username = `ut-${sessionId.slice(-6)}-${agentId.replace('agent-', '')}`
    const inbox = await inboxMgr.provision(username)
    inboxId = inbox.inboxId
    appendAgentLog(agentDir, `Inbox provisioned: ${inboxId}`)
  } catch (err) {
    fail(`Inbox provisioning failed: ${err}`)
    return
  }

  // --- INBOX_READY ---
  transition('INBOX_READY', { inboxId })
  emitEvent({ event: 'spawned', agent: agentId, inbox: inboxId, ts: ts() })

  // Load profile hints for this url/scenario
  const profile = await loadProfile(config.results_dir, url, 'signup')

  // --- SIGNING_UP: launch browser and execute initial task ---
  transition('SIGNING_UP', { currentMessage: initialMessage, startedAt: Date.now() })

  const browserAgent = new BrowserAgent({
    anthropicApiKey: config.anthropic_api_key!,
    agentDir,
    rlmRecentActions: config.rlm_recent_actions,
    rlmMaxFailedActions: config.rlm_max_failed_actions,
  })

  try {
    // RUNNING during initial task execution
    transition('RUNNING')
    await browserAgent.start(url, inboxId, initialMessage, profile ?? undefined)

    // Take screenshot after task
    appendAgentLog(agentDir, 'Initial task complete, taking screenshot...')
  } catch (err) {
    const agentState = opts.getState().agents.find(a => a.id === agentId)
    if ((agentState?.retryCount ?? 0) < MAX_RETRIES) {
      appendAgentLog(agentDir, `Error during SIGNING_UP (retry ${(agentState?.retryCount ?? 0) + 1}): ${err}`)
      const newState = transitionAgent(opts.getState(), agentId, 'SIGNING_UP', {
        retryCount: (agentState?.retryCount ?? 0) + 1,
      })
      opts.onStateChange(newState)
      // Re-run start (same inbox, fresh attempt)
      try {
        await browserAgent.start(url, inboxId, initialMessage, profile ?? undefined)
      } catch (err2) {
        fail(`Browser agent failed after retry: ${err2}`)
        await browserAgent.destroy()
        return
      }
    } else {
      fail(`Browser agent failed: ${err}`)
      await browserAgent.destroy()
      return
    }
  }

  // Initial task done — emit ready + go to WAITING
  const summary = await generateSummary(browserAgent, initialMessage, config.anthropic_api_key!)
  const screenshotPath = path.join(agentDir, 'screenshots', '001.png')

  emitEvent({
    event: 'ready',
    agent: agentId,
    message_completed: initialMessage,
    summary,
    screenshot: fs.existsSync(screenshotPath) ? screenshotPath : undefined,
    ts: ts(),
  })

  transition('WAITING')

  // Update profile with what we learned
  updateProfile(config.results_dir, url, 'signup', browserAgent.exportMemory()).catch(() => {})

  // --- WAITING: poll for commands ---
  const commandsPath = path.join(agentDir, 'commands.ndjson')
  const timeoutAt = Date.now() + config.agent_timeout_ms

  while (Date.now() < timeoutAt) {
    const agentState = opts.getState().agents.find(a => a.id === agentId)
    if (!agentState || agentState.status === 'CANCELLED' || agentState.status === 'DONE') break

    const cmd = readPendingCommand(commandsPath)

    if (cmd?.type === 'kill') {
      appendAgentLog(agentDir, 'Received kill command')
      transition('CANCELLED')
      break
    }

    if (cmd?.type === 'send' && cmd.message) {
      const message = cmd.message
      appendAgentLog(agentDir, `Received send command: ${message}`)
      transition('RUNNING', { currentMessage: message })

      try {
        const result = await browserAgent.resume(message)
        emitEvent({
          event: 'ready',
          agent: agentId,
          message_completed: message,
          summary: result.summary,
          screenshot: result.screenshotPath,
          ts: ts(),
        })
        transition('WAITING')
        updateProfile(config.results_dir, url, 'signup', browserAgent.exportMemory()).catch(() => {})
      } catch (err) {
        fail(`Resume failed: ${err}`)
        break
      }

      continue
    }

    // No command — wait
    await new Promise(r => setTimeout(r, COMMAND_POLL_MS))
  }

  // Timeout → DONE
  const finalState = opts.getState().agents.find(a => a.id === agentId)
  if (finalState?.status === 'WAITING') {
    appendAgentLog(agentDir, 'Session timeout — transitioning to DONE')
    transition('DONE')
  }

  await browserAgent.destroy()
  appendAgentLog(agentDir, 'Agent finished')
}

async function generateSummary(
  agent: BrowserAgent,
  task: string,
  apiKey: string,
): Promise<string> {
  const Anthropic = await import('@anthropic-ai/sdk').then(m => m.default)
  const client = new Anthropic({ apiKey })
  const memory = agent.exportMemory()
  const recentActions = memory.actions.slice(-10)

  if (recentActions.length === 0) return 'No actions recorded.'

  const actionsStr = recentActions
    .map(a => `${a.action} → ${a.result}${a.observation ? ` (${a.observation})` : ''}`)
    .join('\n')

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: `Task: "${task}"\n\nActions:\n${actionsStr}\n\nSummarize in 1-2 sentences: what happened, did the task complete, anything confusing or broken?`,
        },
      ],
    })
    const block = response.content[0]
    return block.type === 'text' ? block.text : 'Task execution complete.'
  } catch {
    return `Completed ${recentActions.filter(a => a.result === 'success').length}/${recentActions.length} steps.`
  }
}
