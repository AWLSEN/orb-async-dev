# orb-async-dev

**Text your repo. Come back to a PR.**

A self-hosted async coding agent that lives on your [Orb Cloud](https://orbcloud.dev) account and ships PRs for you while you're off the keyboard. Install a GitHub App, comment `@orb fix this` on any issue, the agent wakes in ~1s, works as long as it needs to, sleeps between LLM calls, and replies with a PR when done.

Zero servers on our side. You own the keys. You own the repo. You own the bill.

---

## Status

Pre-alpha. Being built in batches of 5 commits. See [`learnings.txt`](learnings.txt) for what's shipped.

## How it works

```
 GitHub issue comment ──▶ webhook ──▶ Orb computer wakes (~1s)
                                        │
                                        ├─ orchestrator routes to sub-agent
                                        ├─ sub-agent on git worktree
                                        ├─ 9-gate verifier before PR opens
                                        └─ PR reply in thread
 Idle ──▶ checkpoint-to-NVMe ──▶ $0 while waiting
```

## Install (planned)

```bash
npx orb-async-dev init
```

Or clone + edit `.env`:

```bash
git clone https://github.com/nextbysam/orb-async-dev
cd orb-async-dev
cp .env.example .env && $EDITOR .env
bun run deploy
```

## Required env

| Var | Purpose |
|---|---|
| `ORB_API_KEY` | Bearer token from app.orbcloud.dev (or auto-register) |
| `GITHUB_TOKEN` | PAT with repo + issues + pull_requests scope |
| `GITHUB_REPO` | `owner/repo` to connect |
| `ANTHROPIC_API_KEY` | or `ANTHROPIC_AUTH_TOKEN` for proxy |
| `WEBHOOK_SECRET` | shared secret for GH webhook verification |

## License

MIT.
