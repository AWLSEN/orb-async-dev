# Launch materials — orb-async-dev

## Launch tweet (draft, v1)

> I built **orb-async-dev**: an OSS async coding agent that runs on your own [Orb Cloud](https://orbcloud.dev) account.
>
> Comment `@orb fix the unicode login bug` on any GitHub issue →
> a persistent sub-agent wakes in ~1s, runs a 10-gate verifier
> (build, tests, mutation check, self-review, red team…), and replies
> with a PR. Sleeps between LLM calls at ~$0/hr.
>
> Devin clone. $0/mo infra idle. MIT, self-host in 60s.
>
> github.com/nextbysam/orb-async-dev

**Alternate hook (shorter):**

> Text your repo. Come back to a PR.
>
> orb-async-dev: self-hosted coding agent that wakes on webhook, runs
> a 10-gate verifier on itself, opens a PR. $0/hr idle. MIT.
>
> github.com/nextbysam/orb-async-dev

## Demo gif checklist

Record at 1200×700, 15 fps, 20s max:
1. iPhone mirrored to screen, GitHub Mobile open on a private demo issue
2. Type `@orb fix the unicode email 500` and send
3. Cut to terminal showing `[orchestrator] accepted task from @sam`
4. Cut to `/logs` page auto-refreshing with gate results streaming in
5. End on the PR in the thread with the `## Verifier` block visible

Export as `docs/demo.gif` and reference from the README hero.

## Post-launch follow-ups (ordered by value)

1. Telegram adapter (DM surface in addition to GH comments)
2. Multi-repo support (one Orb computer, N connected repos)
3. Dependabot-style continuous loop — wake on `new dependency release` webhook, open bump PR
4. Public install metrics dashboard (opt-in via `ORB_TELEMETRY=1`)

## Pilot-customer filter

Look for dev-twitter accounts retweeting the launch who:
- Maintain ≥3 public repos AND
- Tweet about dev tooling or infra in the last 30 days AND
- Follow ≥1 of: @cognition_labs, @cursor_ai, @vercel, @railway

DM with a custom demo gif of a PR on *their* repo if the dogfood can cover it.

## Failure modes to watch in the first 100 installs

- `auto-register` hit rate on Orb (high = docs onboarding works; low = need clearer copy)
- Ratio of hard-failed gates to opened PRs (> 30% hard = system prompt needs sharpening)
- Cost watchdog trip rate (any trip = investigate runaway loops)
- `/logs` 404 rate (indicates users setting `logStore` improperly)

Every one of these is already in the log lines we emit; grep your deploy's output file.
