# orb-async-dev

**Text your repo. Come back to a PR.**

A self-hosted async coding agent that runs on your own [Orb Cloud](https://orbcloud.dev) account. Comment `@orb <task>` on any GitHub issue, and a persistent agent — warm checkout, warm deps, warm LSP — wakes in ~1 second, works for however long it needs, runs a 10-gate verifier on its own output, and replies with a PR.

Zero servers on our side. You own the keys, the code, and the bill.

---

## Why this exists

Every dev on Twitter has a graveyard of half-built side projects. You wanted to ship that idea on the train home, but your laptop is closed, and the commit window is gone. Devin charges $500/mo and still needs babysitting. Cursor Background Agents burn money on idle compute. GitHub Actions can't hold state between jobs.

Orb Cloud's moat is precisely this: an agent runtime that **checkpoints to NVMe while idle and wakes on webhook in ~1s.** `orb-async-dev` is the thinnest possible layer on top:

- one HTTP listener (`/github/webhook`, `/health`, `/logs`)
- one orchestrator that spawns sub-agents per task
- one 10-gate verifier that blocks the PR unless the change actually works

Everything else is just plumbing.

---

## How it works

```
 GitHub issue / PR comment  ──▶  Orb wakes computer (~1s)
   "@orb fix the login bug"        │
                                   ├─ verify HMAC
                                   ├─ parse @orb mention
                                   ├─ create branch + git worktree
                                   ├─ sub-agent runs (Claude tool-use loop)
                                   ├─ 10-gate verifier (build, tests,
                                   │     mutation check, self-review, red team, ...)
                                   ├─ commit + push + open PR
                                   └─ reply in the thread
 Idle ──▶  checkpoint-to-NVMe  ──▶  ~$0/hr
```

See `learnings.txt` for the detailed build log.

---

## Install

### Easy path

```bash
npx orb-async-dev init
```

Four questions (GH repo, GH token, LLM key, cost cap), writes `.env`, registers an Orb computer, returns the live URL.

### Power-user path

```bash
git clone https://github.com/AWLSEN/orb-async-dev
cd orb-async-dev
cp .env.example .env && $EDITOR .env
bun install
bun run deploy
```

Either path ends the same way:

1. `deploy` prints `https://{short_id}.orbcloud.dev`
2. Open `https://github.com/<owner>/<repo>/settings/hooks`
3. Add a webhook:
   - **Payload URL**: `https://{short_id}.orbcloud.dev/github/webhook`
   - **Secret**: the value of `WEBHOOK_SECRET` from your `.env`
   - **Events**: Issues, Issue comments, Pull request review comments
4. Comment `@orb try a quick test` on any issue.

---

## Required config (`.env`)

| Var | Purpose |
|---|---|
| `ORB_API_KEY` | Orb Cloud bearer (auto-registered via `ORB_REGISTER_EMAIL` if blank) |
| `GITHUB_TOKEN` | PAT with `repo` + `issues` + `pull_requests` scope |
| `GITHUB_REPO` | `owner/name` — the single target repo this agent watches |
| `WEBHOOK_SECRET` | Shared secret for HMAC-SHA256 webhook signing (auto-generated if blank) |
| `ANTHROPIC_API_KEY` **or** `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` | LLM. Proxy auth-token path supports Z.AI, OpenRouter, etc. |
| `DAILY_COST_CAP_USD` (optional, default `5`) | Watchdog trip threshold |
| `ANTHROPIC_MODEL` (optional) | Defaults to `claude-opus-4-7` |

---

## The 10-gate verifier

Every PR clears this chain before it opens. Hard failures block the PR outright; soft failures become warnings in the PR body.

1. **scope** (hard) — reject if the diff is > 20 files or > 500 LOC
2. **secret_scan** (hard) — pattern + entropy detection of GH/AWS/Anthropic/OpenAI/Stripe/Slack/Google/JWT/PEM tokens in added lines
3. **new_tests** (hard) — if the src diff is > 20 LOC, at least one test file must have added lines
4. **build** (hard) — stack-aware build command must exit 0
5. **tests** (hard) — existing + new tests must pass
6. **lint** (soft) — warnings render as `⚠` in the PR body
7. **typecheck** (hard) — `tsc --noEmit` / `mypy` / etc. must pass
8. **mutation** (hard) — revert src changes, re-run tests; they MUST go red (proves the new tests actually exercise the fix)
9. **self_review** (hard) — second Claude call reads the diff cold, says whether it matches the task and what the top risk is
10. **red_team** (hard) — third Claude call tries to find 3 substantive flaws; any real flaw blocks the PR

---

## Health loops

The orchestrator self-monitors via a jittered scheduler:

- **canary** (hourly) — clone + fetch + detect + test on the live repo. Failure notifies the operator; user tasks keep flowing.
- **cost-watchdog** (10 min) — polls `/v1/usage`, trips sticky at `DAILY_COST_CAP_USD`, refuses new tasks until acknowledged.
- **reaper** (5 min) — cancels any in-flight task older than 2 hours.

`GET /logs` returns a read-only HTML dashboard of the last 500 events, auto-refreshing every 5 seconds.

---

## Non-goals

- Not a SaaS. No control plane, no ops page. If it breaks on your computer, the logs are on your computer.
- Not a replacement for code review. The verifier catches mechanical regressions; a human still reads the PR.
- No UI that isn't GitHub or `/logs`. If you want a fancy dashboard, build one — the registry + log store both expose simple TS APIs.

---

## License

MIT.
