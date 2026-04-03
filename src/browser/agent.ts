/**
 * BrowserAgent: Stagehand v3 wrapper with RLM memory loop
 *
 * Implements the BrowserAgent interface from the design doc:
 *   start(url, inbox, initialTask, profileHints?) → void
 *   resume(task) → ResumeResult
 *   exportMemory() → SessionMemory
 *   destroy() → void
 */
import Anthropic from '@anthropic-ai/sdk'
import { Stagehand } from '@browserbasehq/stagehand'
import path from 'node:path'
import fs from 'node:fs'
import type { ActionRecord, SessionMemory, ProfileFacts } from '../types.js'
import { appendAgentEvent, appendAgentLog } from '../output/events.js'

export interface ResumeResult {
  summary: string
  screenshotPath: string
}

const ARCHIVE_THRESHOLD = 50
const ARCHIVE_BATCH = 10

export class BrowserAgent {
  private stagehand: Stagehand | null = null
  private anthropic: Anthropic
  private memory: SessionMemory
  private agentDir: string
  private screenshotIndex = 0
  private rlmRecentActions: number
  private rlmMaxFailedActions: number

  constructor(opts: {
    anthropicApiKey: string
    agentDir: string
    rlmRecentActions?: number
    rlmMaxFailedActions?: number
  }) {
    this.anthropic = new Anthropic({ apiKey: opts.anthropicApiKey })
    this.agentDir = opts.agentDir
    this.rlmRecentActions = opts.rlmRecentActions ?? 10
    this.rlmMaxFailedActions = opts.rlmMaxFailedActions ?? 5
    this.memory = {
      taskDescription: '',
      startUrl: '',
      actions: [],
      archivedActionCount: 0,
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

    this.stagehand = new Stagehand({
      env: 'LOCAL',
      verbose: 0,
      model: {
        modelName: 'anthropic/claude-opus-4-6',
        apiKey: this.anthropic.apiKey as string,
      },
      localBrowserLaunchOptions: { headless: true },
      logger: () => {},  // suppress internal logs
    })

    await this.stagehand.init()
    const page = this.stagehand.context.pages()[0]

    appendAgentLog(this.agentDir, `Browser started. Navigating to ${url}`)
    appendAgentEvent(this.agentDir, { event: 'browser_started', url })

    await page.goto(url, { waitUntil: 'load' })

    // Build initial system context including profile hints
    const hintLines = profileHints?.harnessHints
      .filter(h => h.confidence > 0.5)
      .map(h => `- ${h.observation}`)
      .join('\n')

    const systemContext = [
      `You are testing this web app as a first-time user.`,
      `Your email address is: ${inbox}`,
      `Your task: ${initialTask}`,
      `Navigate the app, complete the task, and note anything confusing, broken, or unclear.`,
      `Do not skip steps. Use the email ${inbox} when asked for an email.`,
      hintLines ? `\nKnown context from previous runs:\n${hintLines}` : '',
    ]
      .filter(Boolean)
      .join('\n')

    appendAgentLog(this.agentDir, `Starting task: ${initialTask}`)

    await this.executeTask(systemContext, initialTask)
  }

  async resume(task: string): Promise<ResumeResult> {
    if (!this.stagehand) throw new Error('BrowserAgent not started')

    const context = await this.buildRLMContext(task)
    appendAgentLog(this.agentDir, `Resuming with task: ${task}`)
    appendAgentLog(this.agentDir, `RLM context: ${context.slice(0, 200)}...`)

    await this.executeTask(context, task)

    const screenshotPath = await this.takeScreenshot()
    const summary = await this.summarizeLastTask(task)

    return { summary, screenshotPath }
  }

  exportMemory(): SessionMemory {
    return { ...this.memory, actions: [...this.memory.actions] }
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
    return Promise.all(
      queries.map(async ({ data, prompt }) => {
        if (data.length === 0) return '(no data)'
        const dataStr = data
          .map(a => `${a.action} → ${a.result}${a.observation ? ` | ${a.observation}` : ''}`)
          .join('\n')

        const response = await this.anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 150,
          messages: [
            {
              role: 'user',
              content: `${prompt}\n\nActions:\n${dataStr}\n\nAnswer in 1-2 sentences.`,
            },
          ],
        })
        const block = response.content[0]
        return block.type === 'text' ? block.text : '(no text)'
      }),
    )
  }

  // --- Private: task execution ---

  private async executeTask(systemContext: string, task: string): Promise<void> {
    if (!this.stagehand) throw new Error('Stagehand not initialized')

    const page = this.stagehand.context.pages()[0]
    const startUrl = page.url()

    // Use stagehand.agent().execute() for multi-step tasks.
    // act() is single-step only — it executes one action and considers itself done.
    // agent().execute() runs a proper loop: observe → act → check → repeat until complete.
    const fullInstruction = systemContext
      ? `${systemContext}\n\nTask: ${task}`
      : task

    try {
      const agent = this.stagehand.agent()
      const result = await agent.execute({ instruction: fullInstruction, maxSteps: 15 })

      await page.waitForLoadState('load').catch(() => {})
      const newUrl = page.url()

      appendAgentLog(this.agentDir, `agent.execute() completed: ${result.completed ? 'done' : 'incomplete'}`)
      appendAgentLog(this.agentDir, `  steps taken: ${result.actions?.length ?? 0}`)

      // Record each step as an ActionRecord for RLM memory
      for (const action of (result.actions ?? [])) {
        this.recordAction({
          ts: Date.now(),
          action: action.type ?? 'unknown',
          result: 'success',
          url: startUrl,
        })
      }

      // Also record overall outcome
      if ((result.actions?.length ?? 0) === 0) {
        this.recordAction({
          ts: Date.now(),
          action: task.slice(0, 100),
          result: result.completed ? 'success' : 'failed',
          observation: newUrl !== startUrl ? `Navigated to ${newUrl}` : `Stayed on ${startUrl}`,
          url: startUrl,
        })
      }
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
            appendAgentLog(this.agentDir, `  ✓ ${action.description}`)
          } catch (err2) {
            this.recordAction({
              ts: Date.now(),
              action: action.description,
              selector: action.selector,
              result: 'failed',
              observation: String(err2),
              url: startUrl,
            })
            appendAgentLog(this.agentDir, `  ✗ ${action.description}: ${err2}`)
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

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content: `Task: "${task}"\n\nActions taken:\n${actionsStr}\n\nSummarize in 1-2 sentences: what happened, did the task complete, and anything confusing or broken?`,
          },
        ],
      })
      const block = response.content[0]
      return block.type === 'text' ? block.text : 'Task execution complete.'
    } catch {
      return `Completed ${recentActions.filter(a => a.result === 'success').length}/${recentActions.length} actions.`
    }
  }
}
