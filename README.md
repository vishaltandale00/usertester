# usertester

Spawn N AI agents as simulated users to test your web app flows — signup, onboarding, checkout, email verification — in parallel, with real email inboxes and natural language control.

```
usertester spawn --url https://myapp.com --n 3 --message "Sign up as a new user"
```

Each agent gets a unique email inbox, runs a headless browser, and executes your task as a first-time user. You watch a live NDJSON event stream. When an agent finishes, send it a follow-up task — the browser session stays open.

---

## Install

```bash
npm install -g usertester
```

Or run without installing:

```bash
npx usertester setup
```

You need Node.js 20+ and Google Chrome installed locally.

---

## Quick start

**Step 1 — Get two API keys**

- Anthropic API key: https://console.anthropic.com/settings/keys
- AgentMail API key: https://agentmail.to/dashboard

**Step 2 — Configure**

```bash
usertester setup
```

Prompts for both keys, validates them live, writes `.env`.

**Step 3 — Spawn agents**

```bash
usertester spawn --url https://yourapp.com --n 1 --message "Sign up as a new user"
```

Output (NDJSON, one event per line):

```jsonl
{"event":"session_start","sessionId":"abc123","url":"https://yourapp.com","n":1}
{"event":"spawned","agent":"agent-01","inbox":"abc@agentmail.to"}
{"event":"state","agent":"agent-01","from":"SIGNING_UP","to":"RUNNING"}
{"event":"ready","agent":"agent-01","message_completed":"Sign up as a new user","summary":"Filled the registration form and clicked Register. Signup succeeded and was redirected to the dashboard.","screenshot":"/Users/you/.usertester/abc123/agent-01/screenshots/001.png"}
```

**Step 4 — Send follow-up tasks**

While an agent is in `WAITING` state, send it a new task — the browser session stays open:

```bash
usertester send agent-01 "Go to the pricing page and try to upgrade to the Pro plan"
```

---

## Commands

```bash
usertester setup                              # First-run API key configuration
usertester spawn --url URL --n N --message M  # Spawn N agents with a shared task
usertester spawn --url URL --messages-file tasks.json  # Per-agent tasks from file
usertester status                             # Show all agents + current state
usertester send <agent-id> <message>          # Resume a waiting agent with a new task
usertester kill <agent-id>                    # Kill a running or waiting agent
usertester logs <agent-id> [--follow]         # Tail an agent's log
usertester cleanup                            # Delete all AgentMail inboxes for current session
usertester cleanup --all                      # Clean up all sessions
usertester profiles list                      # Show learned profile hints per URL/scenario
```

---

## Per-agent task file

```json
[
  { "message": "Sign up as a new user and complete onboarding" },
  { "message": "Sign up, then try to upgrade to the paid plan" },
  { "message": "Sign up using Google OAuth if available" }
]
```

If the file has fewer entries than `--n`, tasks cycle.

---

## How it works

1. **Inbox provisioning** — each agent gets a unique `@agentmail.to` email address (~135ms)
2. **Browser agent** — headless Chrome via Stagehand v3, controlled by `claude-opus-4-6`
3. **Multi-step execution** — `agent().execute()` runs an observe→act→check loop until the task completes
4. **RLM memory** — session history is queried in chunks rather than fed whole into context. Cost stays near-flat as sessions grow.
5. **Profile learning** — after each session, failures are extracted into `facts.json` per URL/scenario. Next run, the agent starts with those hints.
6. **NDJSON event stream** — every state transition and result is a JSON line to stdout. Calling agents (Claude Code, etc.) parse this to decide next steps.

---

## Bypassing bot detection (Cloudflare, CAPTCHA)

usertester injects an `x-usertester-session: 1` header on every request. Configure your app to allow this traffic through.

### Option A: Cloudflare WAF bypass (recommended, free)

**Step 1 — Generate a secret bypass token:**
```bash
openssl rand -hex 24   # → e.g. a3f9c2b8d7e14f6a9c2b8d7e14f6a9c2b8d7e14f
```

**Step 2 — Add it to your `.env`:**
```
USERTESTER_BYPASS_TOKEN=a3f9c2b8d7e14f6a9c2b8d7e14f6a9c2b8d7e14f
```

**Step 3 — Add a WAF rule in Cloudflare dashboard → Security → WAF → Custom rules:**
```
Field:      Request Header
Header:     x-usertester-bypass
Operator:   equals
Value:      a3f9c2b8d7e14f6a9c2b8d7e14f6a9c2b8d7e14f   ← your secret
Action:     Skip → All remaining custom rules
```

The token is never in source code — only in your `.env` and Cloudflare dashboard. Rotate it anytime by generating a new one and updating both places.

### Option B: Supabase Auth — use Cloudflare test keys

If your app uses Supabase Auth with Cloudflare Turnstile:

1. Supabase dashboard → **Authentication → Security → CAPTCHA protection**
2. Switch site key to: `1x00000000000000000000AA` (Cloudflare's official test key — always passes)
3. Switch secret key to: `1x0000000000000000000000000000000AA`

Use only in dev/staging — not production.

### Option C: Automatic CAPTCHA solving (no app changes, paid)

Add `CAPSOLVER_API_KEY` to `.env` and usertester will automatically solve Cloudflare Turnstile via [CapSolver](https://capsolver.com) (~$1.20/1K solves, ~85-90% success rate).

```bash
CAPSOLVER_API_KEY=CAP-...
```

---

## Calling from a coding agent

usertester is designed to be orchestrated by a coding agent (Claude Code, Codex) as well as used directly. Parse the NDJSON stream:

```typescript
import { spawn } from 'node:child_process'
import * as readline from 'node:readline'

const proc = spawn('usertester', ['spawn', '--url', url, '--n', '3', '--message', task])
const rl = readline.createInterface({ input: proc.stdout })

rl.on('line', (line) => {
  const event = JSON.parse(line)
  if (event.event === 'ready') {
    // agent.summary tells you what happened
    // send next task:
    spawn('usertester', ['send', event.agent, 'Next task here'])
  }
})
```

---

## Limits

| | Free plan | Paid plan |
|---|---|---|
| AgentMail inboxes | 3 simultaneous | Unlimited |
| Agents per session | 3 | Up to 20 (configurable) |

Always run `usertester cleanup` between sessions to free inbox slots on the free plan.

---

## Results

After a session, results are saved to `~/.usertester/<session-id>/`:

```
~/.usertester/<session-id>/
├── state.json              # Live session + agent states
├── agent-01/
│   ├── agent.log           # Full agent activity log
│   ├── events.ndjson       # Structured event history
│   └── screenshots/        # Screenshots per task
└── ...
```

---

## Requirements

- Node.js 20+
- Google Chrome (for local browser automation)
- Anthropic API key
- AgentMail API key

---

## License

MIT
