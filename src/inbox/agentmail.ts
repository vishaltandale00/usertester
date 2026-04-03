/**
 * AgentMail inbox management
 * Uses the agentmail TypeScript SDK directly (no Composio needed for REST ops)
 */
import { AgentMailClient } from 'agentmail'

export interface Inbox {
  inboxId: string   // also serves as the email address
}

export class InboxManager {
  private client: AgentMailClient

  constructor(apiKey: string) {
    this.client = new AgentMailClient({ apiKey })
  }

  async provision(username: string): Promise<Inbox> {
    const inbox = await this.client.inboxes.create({ username })
    return { inboxId: inbox.inboxId }
  }

  async delete(inboxId: string): Promise<void> {
    await this.client.inboxes.delete(inboxId)
  }

  async listThreads(inboxId: string): Promise<unknown[]> {
    const result = await this.client.inboxes.threads.list(inboxId)
    return (result as { items?: unknown[] }).items ?? []
  }

  async waitForEmail(
    inboxId: string,
    subject: string,
    timeoutMs = 60_000,
    pollIntervalMs = 3_000,
  ): Promise<string | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const threads = await this.listThreads(inboxId)
      for (const thread of threads as Array<{ subject?: string; snippet?: string }>) {
        if (thread.subject?.toLowerCase().includes(subject.toLowerCase())) {
          return thread.snippet ?? thread.subject ?? null
        }
      }
      await new Promise(r => setTimeout(r, pollIntervalMs))
    }
    return null
  }
}
