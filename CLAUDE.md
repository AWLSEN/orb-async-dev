# CLAUDE.md — repo guidance for future sessions

Before making any changes, read `learnings.txt` for the build log of what shipped in each batch and why.

## House rules

- **Test + typecheck must stay green.** `bun test` and `bun run typecheck` on every commit. TypeScript is `strict` + `exactOptionalPropertyTypes`.
- **Commit rhythm:** small commits with descriptive messages, 5 commits per push.
- **No mocks of internal code.** Use real tmpdirs and injected runners/clients — tests already demonstrate the pattern (see `tests/worktree.test.ts`, `tests/fs-tools.test.ts`).
- **Secrets never leave `.env`.** `.env` is gitignored; `.env.example` is the canonical template. Never commit real tokens.
- **Match existing style.** Bun + TypeScript, no `any`, no default exports, short-punch comments on the WHY only.

## Architecture sketch

```
orb-async-dev/
├── cli/init.ts              # npx orb-async-dev init wizard
├── deploy/                  # orb.toml + Orb Cloud API client + idempotent deploy
│   ├── orb-api.ts
│   ├── orb-toml.ts
│   ├── state.ts
│   └── deploy.ts
├── adapters/                # inbound webhook pipeline
│   ├── webhook-verify.ts
│   ├── mention-parser.ts
│   ├── event-router.ts
│   └── github-client.ts
├── agent/                   # runtime (what executes on the Orb computer)
│   ├── orchestrator.ts      # Bun.serve + /health + /github/webhook + /logs
│   ├── task-runner.ts       # webhook → worktree → sub-agent → verifier → PR
│   ├── sub-agent.ts         # Claude tool-use loop (messages API)
│   ├── worktree.ts          # git worktrees per task, shared .git object store
│   ├── runner.ts            # injectable process runner abstraction
│   ├── log-store.ts         # in-memory ring buffer for /logs
│   ├── tools/fs-tools.ts    # jailed read/write/edit/list/run_bash tools
│   ├── verifier/            # 10-gate chain (scope → ... → red_team)
│   └── health/              # scheduler + canary + cost-watchdog + reaper
└── tests/                   # bun test
```

## Key contracts

- **Sub-agent tools are jailed.** Every path goes through `resolveInJail` (`agent/tools/fs-tools.ts`). Don't add a tool that bypasses this.
- **Orb Cloud API shape is canonical.** `deploy/orb-api.ts` matches `docs.orbcloud.dev/api-reference`. If the spec changes, update the client first, then any callers.
- **Verifier is the only reason a PR opens.** TaskRunner's flow is commit → verify → if pass: push + openPR. A hard failure posts a reply with the reason and does NOT push; don't add code paths that skip the verifier.
- **Health loops are best-effort.** They must never throw into the orchestrator — errors route through `createScheduler(_, onError)`.

## When adding a new gate

1. Add the gate function in the right file under `agent/verifier/`:
   - shell-based → `shell-gates.ts`
   - diff-reasoning → `diff-gates.ts`
   - LLM-backed → `llm-gates.ts`
2. Add its invocation in `agent/verifier/index.ts`'s `gates` array, in the right position (cheapest first; LLM calls last).
3. Write tests under `tests/verifier-*.test.ts`.
4. If it changes the PR body, update `buildPullBody`'s tests in `tests/task-runner.test.ts`.

## When changing the Orb Cloud API

- Real spec lives at `https://docs.orbcloud.dev/api-reference`. Re-fetch before editing the client.
- `liveUrl()` uses the server-provided `short_id` when available; don't hardcode `id.slice(0, 8)`.
- `promote`/`demote` require `{port}` body. `/v1/usage` requires `{start, end}` ISO query params.
