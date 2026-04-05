/**
 * CAPTCHA solving tool via CapSolver API
 *
 * Used as fallback when agent hits Cloudflare Turnstile or other CAPTCHAs
 * and the customer hasn't configured the X-Usertester-Session WAF bypass.
 *
 * Cost: ~$1.20/1K Turnstile solves. Success rate: ~85-90%.
 * Set CAPSOLVER_API_KEY in .env to enable. Disabled if key not present.
 *
 * Integration: injected as a Stagehand agent tool alongside readInboxEmail.
 * Agent calls solveTurnstile({ pageURL, siteKey }) → gets token → injects it.
 */
import { tool } from 'ai'
import { z } from 'zod'
import type { Tool } from 'ai'

const captchaParams = z.object({
  pageURL: z.string().describe('The full URL of the page showing the CAPTCHA'),
  siteKey: z.string().optional().describe('Cloudflare Turnstile site key (found in page source). Leave empty to auto-detect.'),
})

type CaptchaParams = z.infer<typeof captchaParams>
type CaptchaResult =
  | { solved: true; token: string; type: string }
  | { solved: false; error: string; hint: string }

export const solveTurnstile: Tool<CaptchaParams, CaptchaResult> = {
  description: `Solve a Cloudflare Turnstile CAPTCHA using the CapSolver API.
Use this when you see a "Verify you are human" challenge blocking form submission.
Returns a token you can inject into the page to bypass the challenge.
Only works if CAPSOLVER_API_KEY is configured — check first before calling.`,
  inputSchema: captchaParams,
  execute: async ({ pageURL, siteKey }: CaptchaParams): Promise<CaptchaResult> => {
    const apiKey = process.env.CAPSOLVER_API_KEY
    if (!apiKey) {
      return {
        solved: false,
        error: 'CAPSOLVER_API_KEY not configured',
        hint: 'Add CAPSOLVER_API_KEY to .env, or configure X-Usertester-Session WAF bypass in Cloudflare instead (recommended).',
      }
    }

    try {
      // CapSolver REST API — no SDK needed, direct HTTP is cleaner
      const createTask = await fetch('https://api.capsolver.com/createTask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientKey: apiKey,
          task: {
            type: 'AntiTurnstileTaskProxyLess',
            websiteURL: pageURL,
            websiteKey: siteKey ?? '0x4AAAAAAADnPIDROrmt1Wwj',  // Cloudflare default demo key fallback
          },
        }),
      }).then(r => r.json()) as { taskId?: string; errorCode?: string; errorDescription?: string }

      if (!createTask.taskId) {
        return {
          solved: false,
          error: createTask.errorDescription ?? 'Task creation failed',
          hint: 'Check CAPSOLVER_API_KEY balance and validity.',
        }
      }

      // Poll for result (Turnstile typically solves in 5-15 seconds)
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 3000))

        const result = await fetch('https://api.capsolver.com/getTaskResult', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientKey: apiKey, taskId: createTask.taskId }),
        }).then(r => r.json()) as {
          status?: string
          solution?: { token?: string }
          errorCode?: string
          errorDescription?: string
        }

        if (result.status === 'ready' && result.solution?.token) {
          return {
            solved: true,
            token: result.solution.token,
            type: 'AntiTurnstileTaskProxyLess',
          }
        }

        if (result.status === 'failed' || result.errorCode) {
          return {
            solved: false,
            error: result.errorDescription ?? 'Solve failed',
            hint: 'Turnstile may be in hardened mode. Try configuring X-Usertester-Session WAF bypass instead.',
          }
        }
      }

      return { solved: false, error: 'Timeout waiting for CAPTCHA solve', hint: 'CapSolver took >60s' }
    } catch (err) {
      return { solved: false, error: String(err), hint: 'CapSolver API request failed' }
    }
  },
}

export function capsolverAvailable(): boolean {
  return !!process.env.CAPSOLVER_API_KEY
}
