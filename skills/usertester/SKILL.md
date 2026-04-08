---
name: usertester
description: Spawn N AI agents as simulated users to test web app flows in parallel. Use when the user wants to test signup, onboarding, checkout, email verification, or any user-facing flow with real browser sessions and real email inboxes. Each agent gets a unique inbox, runs a headless browser, and reports what happened as NDJSON.
---

# usertester

Spawn AI agents that act like real first-time users against a live web app. Each agent gets a unique `@agentmail.to` inbox, drives a headless Chrome session via Stagehand, and reports back what happened. Use this skill when the user wants to test a flow end-to-end as a stranger would experience it.

## When to invoke

Invoke usertester when the user says things like:
- "test the signup flow on $URL"
- "have agents try to onboard on my site"
- "see if a new user can complete checkout"
- "spawn 3 testers and have them try X"
- "find bugs on $URL by pretending to be a user"
- "verify the email confirmation flow works"

Do NOT invoke for:
- Unit tests, integration tests, or anything that runs against localhost source code (use the project's existing test runner)
- Static analysis, linting, type checking
- Tasks that don't involve a real browser hitting a real URL

## Prerequisites

### Step 0: confirm the CLI is installed

The plugin only teaches Claude Code *how* to drive usertester. The actual CLI is a separate npm package. Before running any usertester command, check it's installed:

```bash
which usertester
```

If that returns nothing, tell the user to install it:

```bash
npm install -g usertester
```

(Or `npx usertester <command>` for a one-shot run, though spawn → status → send loops are easier with a global install.)

### API keys

Then the user needs two API keys in a `.env` file:
- `ANTHROPIC_API_KEY` — https://console.anthropic.com/settings/keys
- `AGENTMAIL_API_KEY` — https://agentmail.to/dashboard

If either is missing, run `usertester setup` (interactive prompt that validates keys live and writes `.env`).

Optional but useful:
- `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID` — auto-routes to Browserbase cloud browsers (better for sites with bot detection)
- `USERTESTER_BYPASS_TOKEN` — if the target uses Cloudflare WAF, this header bypasses the rule (LOCAL mode only, never set when using Browserbase)

## Core workflow

### 1. Spawn agents

```bash
usertester spawn --url https://app.example.com --n 3 --message "Sign up as a new user and complete onboarding"
```

Flags:
- `--url <url>` (required) — target URL
- `-n, --n <number>` — agent count, default 1
- `--message <text>` — task all agents share
- `--messages-file <path>` — JSON array of `{ "message": "..." }` for per-agent tasks
- `--session <id>` — resume an existing session

The command streams NDJSON to stdout, one event per line. Parse it line by line to know what's happening:

```jsonl
{"event":"session_start","sessionId":"abc123","url":"...","n":3}
{"event":"spawned","agent":"agent-01","inbox":"x7k2m@agentmail.to"}
{"event":"state","agent":"agent-01","from":"SIGNING_UP","to":"RUNNING"}
{"event":"ready","agent":"agent-01","message_completed":"...","summary":"Filled the registration form, verified email, landed on dashboard.","screenshot":"/Users/.../001.png"}
{"event":"failed","agent":"agent-02","error":"Could not find signup button after 15 steps"}
{"event":"session_complete","sessionId":"abc123"}
```

The interesting events are `ready` (agent finished its task — read `summary` to know what happened) and `failed` (read `error`).

### 2. Check status anytime

```bash
usertester status            # current session, human-readable
usertester status --json     # full session state as JSON
```

Shows each agent's state (`QUEUED`, `SPAWNING`, `INBOX_READY`, `SIGNING_UP`, `RUNNING`, `WAITING`, `DONE`, `FAILED`), elapsed time, inbox, current message.

### 3. Send a follow-up task

While an agent is in `WAITING` state (finished its current task, browser still open), send it a new instruction. The browser session persists.

```bash
usertester send agent-01 "Now navigate to the pricing page and try to upgrade"
```

This is the killer feature for multi-step user journeys: signup → wait → "now do checkout" → wait → "now try to cancel."

### 4. Read logs

```bash
usertester logs agent-01            # full log
usertester logs agent-01 --follow   # tail -f
```

### 5. Cleanup

AgentMail's free plan only allows 3 simultaneous inboxes. Always clean up between sessions:

```bash
usertester cleanup         # delete inboxes for current session
usertester cleanup --all   # delete inboxes for all sessions
```

## How to interpret results

After `usertester spawn` exits (or while it's running, by parsing the stream):

**Success looks like:** `{"event":"ready", ...}` with a `summary` describing what the agent did. Read the summary. It tells you in plain English whether the flow worked.

**Failure looks like:** `{"event":"failed", ...}` with an `error`. Common causes:
- Captcha blocked the agent → suggest user adds `CAPSOLVER_API_KEY` or sets up the bypass token (see Bypass section)
- Site requires real-world identity (phone verify, KYC) → flag this to the user, can't be auto-tested
- Site behavior changed mid-flow → re-run; the meta-harness learns across sessions

**Partial success:** an agent might complete signup but fail on a downstream step. Read the per-agent log: `usertester logs <agent-id>`. The log has every action the agent tried.

## Bot detection / Cloudflare bypass

If the user's site uses Cloudflare WAF and is blocking the agents:

**Option 1 — bypass token (free, recommended):**
1. `openssl rand -hex 24` → secret token
2. Add `USERTESTER_BYPASS_TOKEN=...` to `.env`
3. Cloudflare → Security → WAF → Custom rules → new rule: `Header x-usertester-bypass equals <token>` → action `Skip → All remaining custom rules`

usertester injects this header on every request **only in LOCAL mode**. Never set it when using Browserbase (causes CORS preflight failures on cross-domain API calls).

**Option 2 — Browserbase (paid, no app changes):**
Set `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID` in `.env`. usertester auto-routes to Browserbase cloud browsers which have better fingerprinting.

**Option 3 — CapSolver (paid, automatic):**
Set `CAPSOLVER_API_KEY` in `.env`. usertester will solve Cloudflare Turnstile automatically (~$1.20/1K solves).

## Profile learning

usertester remembers what worked and what didn't, per URL + scenario, in `~/.usertester/profiles/`. After each session, failures and successes are extracted into `facts.json`. The next run starts with those hints baked into the agent's prompt.

```bash
usertester profiles list          # show learned hints
```

You don't usually need to touch this. It just makes the second run on the same site noticeably better than the first.

## Meta-harness (advanced)

After a session completes, the outer harness loop analyzes failure traces and proposes code patches to usertester itself. This is opt-in and slow; only suggest it if the user is repeatedly hitting the same class of failure across multiple sessions.

```bash
usertester harness run            # analyze recent sessions, propose patches
```

## Common patterns

### "Test if a new user can sign up"
```bash
usertester spawn --url https://app.example.com --n 1 --message "Sign up as a new user. Complete email verification if required. Report whether you reached the dashboard."
```

### "Spawn 3 agents to test the full signup → upgrade → cancel flow"
```bash
usertester spawn --url https://app.example.com --n 3 --message "Sign up as a new user and complete onboarding"
# wait for ready events, then for each waiting agent:
usertester send agent-01 "Navigate to billing and upgrade to the Pro plan using card 4242 4242 4242 4242"
# wait for ready, then:
usertester send agent-01 "Cancel the subscription and confirm the downgrade"
```

### "Find any obvious bugs on this URL"
```bash
usertester spawn --url https://app.example.com --n 3 --messages-file - <<'EOF'
[
  { "message": "Sign up as a new user and try every menu item on the dashboard" },
  { "message": "Sign up, then try to break the form by entering invalid data" },
  { "message": "Sign up using Google OAuth if available, otherwise use email" }
]
EOF
```

### "I have a real account, test the post-login flow"
usertester always signs up fresh accounts. It does NOT have a way to log in as an existing user. If the user wants to test with an existing account, tell them this is a known limitation and suggest they use a regular E2E framework (Playwright, Cypress) for that case.

## Limits to flag to the user

- **AgentMail free plan: 3 inboxes simultaneous.** If the user wants `--n 4`, tell them to either upgrade or run `cleanup` between batches.
- **Costs.** Each agent run is roughly $0.10–$0.50 in Anthropic API costs (Opus 4.6 driving the browser). A 5-agent session is $1–$3. Mention this before spawning more than 3 agents.
- **No existing-account login.** See above.
- **Real browsers, real signups.** The agent is creating real accounts on the user's app. They land in the user's database. Suggest cleaning them up after testing.

## Output to give the user

After invoking usertester, parse the NDJSON stream and tell the user:
1. **What happened** — read each `ready` event's `summary` field. Summarize across agents. ("All 3 agents completed signup. Agent 2 hit an issue with the email verification step.")
2. **What broke, if anything** — read each `failed` event's `error` field. Translate to actionable next steps.
3. **Where to look for more detail** — point at `usertester logs <agent-id>` and the screenshots in `~/.usertester/<session-id>/<agent-id>/screenshots/`.

Don't just dump raw NDJSON at the user. They want the answer ("did signup work?"), not the trace.
