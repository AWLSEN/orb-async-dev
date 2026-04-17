# Changelog

## 0.1.0 — 2026-04-17

Initial MIT release. End-to-end async coding agent on Orb Cloud:

- **Deploy pipeline**: typed OrbClient matching docs.orbcloud.dev, orb.toml generator, idempotent deploy script with `.orb-state/`.
- **GitHub adapter**: HMAC-SHA256 webhook verify, `@orb` mention parser (code-block + quote-line aware), event router for issues + issue_comment + pr_review_comment, thin GithubClient for branches + PRs + comments.
- **Orchestrator**: `/health`, `/github/webhook`, `/logs`. Webhook pipeline = verify → route → dedup → ack → enqueue.
- **Sub-agent**: Claude tool-use loop with jailed read_file / write_file / edit_file / list_files / run_bash tools.
- **Task runner**: ensure repo → git worktree per task → sub-agent → 10-gate verifier → commit + push → open PR → reply in thread.
- **10-gate verifier**: scope → secret_scan → new_tests → build → tests → lint → typecheck → mutation → self_review → red_team.
- **Health loops**: jittered scheduler, hourly canary, 10-min cost watchdog, 5-min stuck-task reaper.
- **CLI**: `npx orb-async-dev init` 4-question wizard.
- **Logs page**: in-memory ring buffer + auto-refreshing HTML dashboard.

253 tests, strict TypeScript + `exactOptionalPropertyTypes`, Bun runtime.
