# usertester

Spawn N AI agents as simulated users to test your web app flows — signup, onboarding, checkout, email verification — in parallel, with real email inboxes and natural language control.

> "Test the signup flow on app.example.com" — and watch 3 agents do it.

Each agent gets a unique email inbox, runs a headless browser, and executes your task as a first-time user. You watch a live NDJSON event stream. When an agent finishes, send it a follow-up task — the browser session stays open.

---

## Install in Claude Code (recommended)

usertester is built to be driven by a coding agent. The fastest way to use it is as a Claude Code plugin.

```
/plugin marketplace add vishaltandale00/usertester
/plugin install usertester@vishaltandale00
```

Then just talk to Claude Code:

> "Test the signup flow on app.example.com with 3 agents"

Claude Code will invoke usertester, parse the event stream, and tell you what worked and what broke.

You still need the underlying CLI installed (for now) — see [Standalone CLI](#standalone-cli) below.

---

## Setup

You need two API keys:

- Anthropic API key — https://console.anthropic.com/settings/keys
- AgentMail API key — https://agentmail.to/dashboard

Run:

```bash
usertester setup
```

Interactive prompt that validates both keys live and writes them to `.env`.

You also need Node.js 20+ and Google Chrome installed locally (or Browserbase credentials for cloud browsers).

---

## What you get

- **Parallel agents.** Spawn 1–20 simultaneous testers, each with its own browser session and email inbox.
- **Real email verification.** Each agent gets a unique `@agentmail.to` address. Email-based signup flows actually work end-to-end.
- **Multi-step user journeys.** Agents pause in `WAITING` state between tasks. Send follow-ups: "now do checkout," "now try to cancel."
- **Profile learning.** After each session, what worked and what failed is extracted into a per-URL profile. The next run is noticeably better.
- **Meta-harness loop.** When usertester repeatedly fails on the same class of issue, an outer loop proposes code patches to itself. Opt-in.
- **NDJSON event stream.** Every state transition and result is one JSON line on stdout. Trivial for any coding agent to parse.

---

## Standalone CLI

If you'd rather use the CLI directly:

```bash
npm install -g usertester
usertester setup
usertester spawn --url https://yourapp.com --n 1 --message "Sign up as a new user"
```

Or run without installing:

```bash
npx usertester setup
```

### Commands

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
usertester harness run                        # Run the meta-harness outer loop
```

### NDJSON event stream

```jsonl
{"event":"session_start","sessionId":"abc123","url":"https://yourapp.com","n":1}
{"event":"spawned","agent":"agent-01","inbox":"abc@agentmail.to"}
{"event":"state","agent":"agent-01","from":"SIGNING_UP","to":"RUNNING"}
{"event":"ready","agent":"agent-01","message_completed":"Sign up as a new user","summary":"Filled the registration form and clicked Register. Signup succeeded and was redirected to the dashboard.","screenshot":"/Users/you/.usertester/abc123/agent-01/screenshots/001.png"}
```

### Per-agent task file

```json
[
  { "message": "Sign up as a new user and complete onboarding" },
  { "message": "Sign up, then try to upgrade to the paid plan" },
  { "message": "Sign up using Google OAuth if available" }
]
```

If the file has fewer entries than `--n`, tasks cycle.

### Calling from a coding agent (raw)

```typescript
import { spawn } from 'node:child_process'
import * as readline from 'node:readline'

const proc = spawn('usertester', ['spawn', '--url', url, '--n', '3', '--message', task])
const rl = readline.createInterface({ input: proc.stdout })

rl.on('line', (line) => {
  const event = JSON.parse(line)
  if (event.event === 'ready') {
    spawn('usertester', ['send', event.agent, 'Next task here'])
  }
})
```

---

## How it works

1. **Inbox provisioning** — each agent gets a unique `@agentmail.to` email address (~135ms)
2. **Browser agent** — headless Chrome via Stagehand v3, controlled by `claude-opus-4-6`
3. **Multi-step execution** — `agent().execute()` runs an observe→act→check loop until the task completes
4. **RLM memory** — session history is queried in chunks rather than fed whole into context. Cost stays near-flat as sessions grow.
5. **Profile learning** — after each session, failures are extracted into `facts.json` per URL/scenario. Next run, the agent starts with those hints.
6. **Meta-harness outer loop** — repeated failure patterns get auto-classified and proposed as code patches against usertester itself.
7. **NDJSON event stream** — every state transition and result is a JSON line to stdout. Calling agents (Claude Code, etc.) parse this to decide next steps.

---

## Bypassing bot detection (Cloudflare, CAPTCHA)

If your app uses Cloudflare WAF, Turnstile, or similar bot protection, agents will get blocked. Three options:

### Option A: Cloudflare WAF bypass (recommended, free)

**Step 1 — Generate a secret bypass token:**
```bash
openssl rand -hex 24
```

**Step 2 — Add it to your `.env`:**
```
USERTESTER_BYPASS_TOKEN=<your secret>
```

**Step 3 — Add a WAF rule in Cloudflare dashboard → Security → WAF → Custom rules:**
```
Field:      Request Header
Header:     x-usertester-bypass
Operator:   equals
Value:      <your secret>
Action:     Skip → All remaining custom rules
```

The token is never in source code — only in your `.env` and Cloudflare dashboard. Rotate it anytime by updating both places.

usertester injects this header **only in LOCAL mode** (not when using Browserbase) to avoid CORS preflight failures on cross-domain API calls.

### Option B: Browserbase (paid, no app changes)

Set `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` in `.env`. usertester auto-routes to Browserbase cloud browsers, which have better fingerprinting.

### Option C: Supabase Auth — use Cloudflare test keys

If your app uses Supabase Auth with Cloudflare Turnstile, in **Supabase dashboard → Authentication → Security → CAPTCHA protection**:

- Site key: `1x00000000000000000000AA`
- Secret key: `1x0000000000000000000000000000000AA`

These are Cloudflare's official test keys (always pass). Use only in dev/staging, never production.

### Option D: Automatic CAPTCHA solving (paid)

```
CAPSOLVER_API_KEY=CAP-...
```

usertester will automatically solve Cloudflare Turnstile via [CapSolver](https://capsolver.com) (~$1.20/1K solves, ~85-90% success rate).

---

## Limits

| | Free plan | Paid plan |
|---|---|---|
| AgentMail inboxes | 3 simultaneous | Unlimited |
| Agents per session | 3 | Up to 20 (configurable) |

Always run `usertester cleanup` between sessions to free inbox slots on the free plan.

**Cost.** Each agent run is roughly $0.10–$0.50 in Anthropic API costs (Opus 4.6 driving the browser). A 5-agent session is $1–$3.

**No existing-account login.** usertester always creates fresh accounts. If you want to test post-login flows for an existing user, use Playwright or Cypress instead.

**Real signups in your DB.** Agents create real accounts on your app. They land in your database. Clean them up after testing.

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
- Google Chrome (for local browser automation) OR Browserbase credentials
- Anthropic API key
- AgentMail API key

---

## License

MIT
