/**
 * readInboxEmail tool — lets the browser agent read emails via AgentMail API
 * instead of trying to navigate to a web inbox (which fails DNS).
 *
 * Used by the retry loop when it detects a CAPABILITY_GAP around email reading.
 * Injected into Stagehand via stagehand.agent({ tools: { readInboxEmail } })
 */
import { z } from 'zod'
import { AgentMailClient } from 'agentmail'
import type { Tool } from 'ai'

const inboxParams = z.object({
  inboxId: z.string().describe('The full inbox email address, e.g. ut-abc123@agentmail.to'),
  subjectContains: z.string().optional().describe('Optional: filter by subject keyword, e.g. "verification" or "code"'),
  waitMinutes: z.number().optional().describe('How many minutes to wait for the email to arrive. Default: 2.'),
})

type InboxParams = z.infer<typeof inboxParams>

type InboxResult =
  | { found: false; error: string }
  | { found: false; message: string }
  | { found: true; subject?: string; snippet?: string; verificationCodes: string[]; primaryCode: string | null }

export const readInboxEmail: Tool<InboxParams, InboxResult> = {
  description: `Read emails from an AgentMail inbox using the API.
Use this when you need to retrieve a verification code, magic link, or any email sent to your inbox.
Do NOT try to navigate to a web-based email client — use this tool instead.
Returns the email subject, body snippet, and any 6-digit codes found.`,
  inputSchema: inboxParams,
  execute: async ({ inboxId, subjectContains, waitMinutes = 2 }: InboxParams): Promise<InboxResult> => {
    const apiKey = process.env.AGENTMAIL_API_KEY
    if (!apiKey) return { found: false, error: 'AGENTMAIL_API_KEY not set' }

    const client = new AgentMailClient({ apiKey })
    const deadline = Date.now() + waitMinutes * 60 * 1000

    while (Date.now() < deadline) {
      try {
        const threads = await client.inboxes.threads.list(inboxId)
        // AgentMail API returns { count, threads: [...] }
        const items = ((threads as any).threads ?? (threads as any).items ?? []) as Array<{
          subject?: string
          threadId?: string
        }>

        for (const thread of items) {
          if (subjectContains && !thread.subject?.toLowerCase().includes(subjectContains.toLowerCase())) {
            continue
          }

          // Fetch full thread to get message HTML (snippet is often undefined)
          const detail = await client.inboxes.threads.get(inboxId, thread.threadId!)
          const msg = (detail as any).messages?.[0]
          const fullText = JSON.stringify(msg ?? '')

          // Extract 6-digit verification codes — filter out obvious template placeholders
          const allCodes = fullText.match(/\b\d{6}\b/g) ?? []
          // De-duplicate and filter repeated filler codes (e.g. 333333, 666666)
          const codes = [...new Set(allCodes)].filter(c => !/^(\d)\1{5}$/.test(c))

          return {
            found: true,
            subject: thread.subject,
            snippet: (msg?.extractedHtml ?? msg?.html ?? '').slice(0, 200),
            verificationCodes: codes,
            primaryCode: codes[0] ?? null,
          }
        }
      } catch (err) {
        return { found: false, error: String(err) }
      }

      // Wait 5 seconds before polling again
      await new Promise(r => setTimeout(r, 5000))
    }

    return {
      found: false,
      message: `No email found in ${inboxId} after ${waitMinutes} minutes`,
    }
  },
}
