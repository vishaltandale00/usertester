/**
 * BrowserAgent: Stagehand v3 wrapper with RLM memory loop
 *
 * Implements the BrowserAgent interface from the design doc:
 *   start(url, inbox, initialTask, profileHints?) → void
 *   resume(task) → ResumeResult
 *   exportMemory() → SessionMemory
 *   destroy() → void
 */
import { Stagehand } from '@browserbasehq/stagehand'
import path from 'node:path'
import fs from 'node:fs'
import type { ActionRecord, SessionMemory, ProfileFacts, UsertesterConfig, RecoveryTip } from '../types.js'
import { appendAgentEvent, appendAgentLog } from '../output/events.js'
import { cheapCall, cheapBatch } from '../llm/provider.js'
import { classifyFailure, selectToolsForRecovery, buildRetryInstruction } from '../orchestrator/retry.js'
import type { RetryAttempt } from '../orchestrator/retry.js'

export interface ResumeResult {
  summary: string
  screenshotPath: string
}

const ARCHIVE_THRESHOLD = 50
const ARCHIVE_BATCH = 10


export class BrowserAgent {
  private stagehand: Stagehand | null = null
  private config: Partial<UsertesterConfig>
  private memory: SessionMemory
  private agentDir: string
  private screenshotIndex = 0
  private rlmRecentActions: number
  private rlmMaxFailedActions: number
  private retryHistory: RetryAttempt[] = []

  constructor(opts: {
    config: Partial<UsertesterConfig>
    agentDir: string
    rlmRecentActions?: number
    rlmMaxFailedActions?: number
  }) {
    this.config = opts.config
    this.agentDir = opts.agentDir
    this.rlmRecentActions = opts.rlmRecentActions ?? 10
    this.rlmMaxFailedActions = opts.rlmMaxFailedActions ?? 5
    this.memory = {
      taskDescription: '',
      startUrl: '',
      actions: [],
      archivedActionCount: 0,
      recoveryTips: [],
    }
  }

  async start(
    url: string,
    inbox: string,
    initialTask: string,
    profileHints?: ProfileFacts,
  ): Promise<void> {
    this.memory.taskDescription = initialTask
    this.memory.startUrl = url

    // Use Stagehand's native model config (provider/model format + apiKey)
    // This is the format confirmed working from spike tests
    const cuaModelString = this.config.cua_model ?? 'anthropic/claude-opus-4-6'
    // Strip 'openrouter/' prefix — Stagehand uses provider/model directly
    const stagehandModelName = cuaModelString.startsWith('openrouter/')
      ? cuaModelString.slice('openrouter/'.length)
      : cuaModelString

    const apiKey = this.config.anthropic_api_key
      ?? this.config.openrouter_api_key
      ?? this.config.openai_api_key
      ?? process.env.ANTHROPIC_API_KEY
      ?? process.env.OPENROUTER_API_KEY
      ?? ''

    const useBrowserbase = !!(
      this.config.browserbase_api_key && this.config.browserbase_project_id
    )

    if (useBrowserbase) {
      appendAgentLog(this.agentDir, `Using Browserbase (project: ${this.config.browserbase_project_id})`)
      this.stagehand = new Stagehand({
        env: 'BROWSERBASE',
        apiKey: this.config.browserbase_api_key,
        projectId: this.config.browserbase_project_id,
        verbose: 0,
        model: { modelName: stagehandModelName, apiKey } as any,
        logger: () => {},
        experimental: true,
        disableAPI: true,
      } as any)
    } else {
      appendAgentLog(this.agentDir, `Using local Chrome (headless)`)
      this.stagehand = new Stagehand({
        env: 'LOCAL',
        verbose: 0,
        model: { modelName: stagehandModelName, apiKey } as any,
        localBrowserLaunchOptions: { headless: true },
        logger: () => {},
        experimental: true,
        disableAPI: true,
      })
    }

    await this.stagehand.init()
    const page = this.stagehand.context.pages()[0]

    // Inject customer-specific bypass token if configured.
    // Customers add a WAF rule: (http.request.headers["x-usertester-bypass"] eq "<their-token>") → Skip
    // The token is secret — read from USERTESTER_BYPASS_TOKEN env, never hardcoded.
    const bypassToken = this.config.bypass_token
    if (bypassToken) {
      await page.setExtraHTTPHeaders({ 'x-usertester-bypass': bypassToken })
    }

    appendAgentLog(this.agentDir, `Browser started. Navigating to ${url}`)
    appendAgentEvent(this.agentDir, { event: 'browser_started', url })

    await page.goto(url, { waitUntil: 'load' })

    // Build initial system context including profile hints.
    // If a high-confidence recovery tip exists (proven approach), use it exclusively —
    // contradictory lower-confidence hints are excluded to avoid confusing the agent.
    const provenApproach = profileHints?.harnessHints.find(
      h => h.confidence >= 0.95 && h.observation.startsWith('PROVEN APPROACH'),
    )
    const hintLines = provenApproach
      ? `- ${provenApproach.observation}`
      : profileHints?.harnessHints
          .filter(h => h.confidence > 0.5)
          .map(h => `- ${h.observation}`)
          .join('\n')

    const systemContext = [
      `You are testing this web app as a first-time user.`,
      `Your email address is: ${inbox}`,
      `Your task: ${initialTask}`,
      `Navigate the app, complete the task, and note anything confusing, broken, or unclear.`,
      `Do not skip steps. Use the email ${inbox} when asked for an email.`,
      `If verification fails and you need to resend a code, wait for any cooldown timer shown before clicking Resend. Then call readInboxEmail again to get the new code.`,
      hintLines ? `\nKnown context from previous runs:\n${hintLines}` : '',
    ]
      .filter(Boolean)
      .join('\n')

    appendAgentLog(this.agentDir, `Starting task: ${initialTask}`)

    // Pre-inject tools from recovery tip on attempt 1.
    // The profile's PROVEN APPROACH hint records which tools worked — inject them immediately
    // so the agent doesn't waste attempt 1 discovering it needs them.
    const attempt1Tools: Record<string, unknown> = {}
    const { readInboxEmail } = await import('../tools/inbox.js')

    const provenHint = profileHints?.harnessHints.find(
      h => h.confidence >= 0.95 && h.observation.startsWith('PROVEN APPROACH'),
    )
    if (provenHint?.observation.includes('readInboxEmail')) {
      attempt1Tools['readInboxEmail'] = readInboxEmail
      appendAgentLog(this.agentDir, `Pre-injecting readInboxEmail from profile recovery tip`)
    }

    this.retryHistory = []
    let result = await this.executeTask(systemContext, initialTask, attempt1Tools)

    if (!result.completed) {
      for (let attempt = 2; attempt <= 5; attempt++) {
        const classification = await classifyFailure(result.message, this.config)
        appendAgentLog(this.agentDir, `Retry ${attempt}: classified as ${classification.type} — ${classification.recoveryHint}`)

        this.retryHistory.push({
          attempt: attempt - 1,
          instruction: initialTask,
          toolsInjected: [],
          result: 'failed',
          failureType: classification.type,
          agentMessage: result.message,
          finalUrl: result.finalUrl,
        })

        if (classification.type === 'COMPLETE') break
        if (classification.type === 'ESCALATE') break

        // RATE_LIMITED: wait the app's specified cooldown then retry
        if (classification.type === 'RATE_LIMITED') {
          const secondsMatch = result.message.match(/only request this after (\d+)|wait (\d+) second/i)
          const waitSeconds = secondsMatch
            ? parseInt(secondsMatch[1] ?? secondsMatch[2], 10)
            : 90  // default to 90s if we can't parse
          appendAgentLog(this.agentDir, `  Rate limited — waiting ${waitSeconds}s before retry`)
          await new Promise(r => setTimeout(r, waitSeconds * 1000))
        }

        // ENVIRONMENT_BLOCK: only break if no solver tool available for it
        if (classification.type === 'ENVIRONMENT_BLOCK') {
          const recoveryTools = selectToolsForRecovery(classification)
          if (Object.keys(recoveryTools).length === 0) break  // no tool can help
        }
        if (classification.type === 'TRANSIENT' && attempt > 3) break

        const tools = selectToolsForRecovery(classification)
        const retryInstruction = buildRetryInstruction(initialTask, this.retryHistory, this.memory, url)

        appendAgentLog(this.agentDir, `  injecting tools: ${Object.keys(tools).join(', ') || 'none'}`)
        result = await this.executeTask(systemContext, retryInstruction, tools)

        if (result.completed) {
          appendAgentLog(this.agentDir, `✓ Retry ${attempt} succeeded`)
          const tip: RecoveryTip = {
            url: this.memory.startUrl,
            scenario: 'signup',
            failedApproaches: this.retryHistory
              .filter(a => a.result === 'failed')
              .map(a => a.agentMessage.slice(0, 150)),
            successApproach: result.message.slice(0, 400),
            toolsUsed: Object.keys(tools),
            finalUrl: result.finalUrl,
            confidence: 0.95,
            ts: Date.now(),
          }
          this.memory.recoveryTips.push(tip)
          appendAgentEvent(this.agentDir, { event: 'recovery_tip_written', tip })
          appendAgentLog(this.agentDir, `Recovery tip stored: ${tip.successApproach.slice(0, 80)}`)
          break
        }
      }
    }
  }

  async resume(task: string): Promise<ResumeResult> {
    if (!this.stagehand) throw new Error('BrowserAgent not started')

    const context = await this.buildRLMContext(task)
    appendAgentLog(this.agentDir, `Resuming with task: ${task}`)
    appendAgentLog(this.agentDir, `RLM context: ${context.slice(0, 200)}...`)

    await this.executeTask(context, task, {})

    const screenshotPath = await this.takeScreenshot()
    const summary = await this.summarizeLastTask(task)

    return { summary, screenshotPath }
  }

  exportMemory(): SessionMemory {
    return { ...this.memory, actions: [...this.memory.actions] }
  }

  exportRetryHistory(): RetryAttempt[] {
    return [...this.retryHistory]
  }

  async destroy(): Promise<void> {
    if (this.stagehand) {
      await this.stagehand.close()
      this.stagehand = null
    }
  }

  // --- Private: RLM context builder ---

  private async buildRLMContext(nextTask: string): Promise<string> {
    const page = this.stagehand!.context.pages()[0]
    const currentUrl = page.url()

    const recentWindow = this.memory.actions.slice(-this.rlmRecentActions)
    const failedWindow = this.memory.actions
      .filter(a => a.result === 'failed')
      .slice(-this.rlmMaxFailedActions)

    const [recentContext, failureContext] = await this.llmBatch([
      {
        data: recentWindow,
        prompt: 'What is the current browser state and what has the agent done most recently?',
      },
      {
        data: failedWindow,
        prompt: 'What has failed before that the agent should avoid repeating?',
      },
    ])

    return [
      `You are a browser automation agent testing a web app.`,
      `Current URL: ${currentUrl}`,
      `Next task: ${nextTask}`,
      `Total actions taken so far: ${this.memory.actions.length + this.memory.archivedActionCount}`,
      `Recent state: ${recentContext}`,
      failureContext !== '(no data)' ? `Things to avoid: ${failureContext}` : null,
    ]
      .filter(Boolean)
      .join('\n')
  }

  private async llmBatch(
    queries: Array<{ data: ActionRecord[]; prompt: string }>,
  ): Promise<string[]> {
    const prompts = queries.map(({ data, prompt }) => {
      if (data.length === 0) return null
      const dataStr = data
        .map(a => `${a.action} → ${a.result}${a.observation ? ` | ${a.observation}` : ''}`)
        .join('\n')
      return `${prompt}\n\nActions:\n${dataStr}\n\nAnswer in 1-2 sentences.`
    })

    return Promise.all(
      prompts.map(async (p) => {
        if (p === null) return '(no data)'
        const text = await cheapBatch([p], this.config, 150)
        return text[0] || '(no data)'
      }),
    )
  }

  // --- Private: task execution ---

  private async executeTask(
    systemContext: string,
    task: string,
    tools: Record<string, unknown> = {},
  ): Promise<{ completed: boolean; message: string; finalUrl: string }> {
    if (!this.stagehand) throw new Error('Stagehand not initialized')

    const page = this.stagehand.context.pages()[0]
    const startUrl = page.url()
    const fullInstruction = systemContext ? `${systemContext}\n\nTask: ${task}` : task

    try {
      // Tools are passed to stagehand.agent() config, not to execute()
      const agentConfig: Record<string, unknown> = {}
      if (Object.keys(tools).length > 0) {
        agentConfig.tools = tools
      }
      const agent = this.stagehand.agent(agentConfig as Parameters<typeof this.stagehand.agent>[0])
      const result = await agent.execute({ instruction: fullInstruction, maxSteps: 15 })

      await page.waitForLoadState('load').catch(() => {})
      const newUrl = page.url()

      appendAgentLog(this.agentDir, `agent.execute() completed: ${result.completed ? 'done' : 'incomplete'}`)
      appendAgentLog(this.agentDir, `  steps: ${result.actions?.length ?? 0}, tools injected: ${Object.keys(tools).join(', ') || 'none'}`)
      appendAgentLog(this.agentDir, `  message: ${result.message}`)
      appendAgentLog(this.agentDir, `  final url: ${newUrl}`)

      // Record each step as an ActionRecord for RLM memory
      for (const action of (result.actions ?? [])) {
        this.recordAction({
          ts: Date.now(),
          action: (action as any).type ?? 'unknown',
          result: 'success',
          observation: (action as any).reasoning ?? undefined,
          url: startUrl,
        })
      }

      // Record overall outcome with agent's message as observation
      this.recordAction({
        ts: Date.now(),
        action: task.slice(0, 100),
        result: result.completed ? 'success' : 'failed',
        observation: result.message ?? (newUrl !== startUrl ? `Navigated to ${newUrl}` : `Stayed on ${startUrl}`),
        url: startUrl,
      })

      return { completed: result.completed, message: result.message ?? '', finalUrl: newUrl }
    } catch (err) {
      appendAgentLog(this.agentDir, `agent.execute() failed: ${err}`)

      // Fallback: individual act() calls per observed action
      let allActions: Array<{ description: string; selector?: string }> = []
      try { allActions = await this.stagehand.observe() } catch {}

      if (allActions.length > 0) {
        appendAgentLog(this.agentDir, `Falling back to ${allActions.length} individual act() calls`)
        for (const action of allActions.slice(0, 5)) {
          try {
            await this.stagehand.act(action.description)
            await page.waitForLoadState('load').catch(() => {})
            this.recordAction({
              ts: Date.now(),
              action: action.description,
              selector: action.selector,
              result: 'success',
              url: startUrl,
            })
            appendAgentLog(this.agentDir, `  ok ${action.description}`)
          } catch (err2) {
            this.recordAction({
              ts: Date.now(),
              action: action.description,
              selector: action.selector,
              result: 'failed',
              observation: String(err2),
              url: startUrl,
            })
            appendAgentLog(this.agentDir, `  fail ${action.description}: ${err2}`)
          }
        }
      } else {
        this.recordAction({
          ts: Date.now(),
          action: task.slice(0, 100),
          result: 'failed',
          observation: String(err),
          url: startUrl,
        })
      }

      return { completed: false, message: String(err), finalUrl: page.url() }
    }
  }

  private recordAction(action: ActionRecord): void {
    this.memory.actions.push(action)
    appendAgentEvent(this.agentDir, { event: 'action', ...action })

    // Archive oldest actions when exceeding threshold (RLM memory management)
    if (this.memory.actions.length > ARCHIVE_THRESHOLD) {
      const archived = this.memory.actions.splice(0, ARCHIVE_BATCH)
      this.memory.archivedActionCount += archived.length
      appendAgentEvent(this.agentDir, {
        event: 'actions_archived',
        count: archived.length,
        total_archived: this.memory.archivedActionCount,
        actions: archived,
      })
    }
  }

  private async takeScreenshot(): Promise<string> {
    if (!this.stagehand) return ''
    this.screenshotIndex++
    const screenshotDir = path.join(this.agentDir, 'screenshots')
    const filename = `${String(this.screenshotIndex).padStart(3, '0')}.png`
    const screenshotPath = path.join(screenshotDir, filename)

    try {
      const page = this.stagehand.context.pages()[0]
      await page.screenshot({ path: screenshotPath })
      appendAgentLog(this.agentDir, `Screenshot saved: ${filename}`)
    } catch (err) {
      appendAgentLog(this.agentDir, `Screenshot failed: ${err}`)
    }

    return screenshotPath
  }

  private async summarizeLastTask(task: string): Promise<string> {
    const recentActions = this.memory.actions.slice(-10)
    if (recentActions.length === 0) return 'No actions recorded.'

    const actionsStr = recentActions
      .map(a => `${a.action} → ${a.result}${a.observation ? ` (${a.observation})` : ''}`)
      .join('\n')

    const prompt = `Task: "${task}"\n\nActions taken:\n${actionsStr}\n\nSummarize in 1-2 sentences: what happened, did the task complete, and anything confusing or broken?`

    try {
      const text = await cheapCall(prompt, this.config, 200)
      return text || 'Task execution complete.'
    } catch {
      return `Completed ${recentActions.filter(a => a.result === 'success').length}/${recentActions.length} actions.`
    }
  }
}
