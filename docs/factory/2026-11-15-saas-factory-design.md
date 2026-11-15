# Autonomous micro-SaaS factory: design

Date: 2026-11-15
Status: Phase 0 complete (section 2a). Phase 1 design in section 3a, awaiting approval of its implementation plan. Nothing of the factory is built.

## 1. Goal

A reusable system in which the owner maintains one file, `GOALS.md`, per product. The system plans, implements, tests, reviews and prepares a deployable application, across restarts and context exhaustion, without repeated prompting.

Success means completed products with few human interventions. Agent count is not a goal.

### Decisions already made by the owner

- GitHub hosts code and task state.
- Next.js on Vercel is the default stack. Database, auth and payments are added only when a goal needs them.
- `GOALS.md` is the only file the owner must maintain. Issues, PRs and all other files are maintained by the system.
- ~~Merges start human-approved.~~ Changed by the owner on 2026-11-15: ordinary application PRs are merged automatically (section 3a, "Automatic merge"). The owner edits `GOALS.md` and handles `needs-human` only.
- Architectural decisions and recovery state persist outside any session.
- No reliance on unlimited or unverified subscription usage.

## 2. Feasibility findings (verified 2026-11-15)

Sources are the official Claude Code docs, Anthropic's consumer terms and the local install (`claude` 2.1.296, signed in on a **Pro** plan, `gh` authenticated).

| Capability | Finding | Consequence |
|---|---|---|
| Cloud sessions on Pro | Available. Share one usage pool with everything else on the account. | Concurrency starts at 1. Usage credits stay off so spend is capped. |
| Cloud scheduled tasks ("routines") | Available on Pro. Research preview. Each run is a fresh session, starting in auto mode. | Fits "one task, one fresh context". Interface may change. |
| Schedule trigger | Minimum interval one hour. | Usable only for the sweeper. |
| GitHub trigger | Pull request, release and issue events. **No push event, no CI/check event.** Filters are documented for pull requests only. | A push to `GOALS.md` and a CI result cannot start a session natively. |
| API trigger | `POST https://api.anthropic.com/v1/claude_code/routines/{id}/fire`, bearer token, beta header `experimental-cc-routine-2026-04-01`, optional free-text `text`. 30 fires/hour per task, 100/hour per account, no overage. | One uniform way to start any role. Caps are far above what this design needs. |
| Creating routines | Web, desktop or `/schedule`. No documented creation API. | One manual setup step per project. |
| Repo hooks and permission rules | Load in a cloud session attached to **one** repository. Do **not** load in Projects threads. | One repo per session. Projects cannot be the execution layer. |
| GitHub access from a session | Through a proxy using the owner's identity. `gh api` (REST) works for the attached repo. **GraphQL is rejected**, so `gh pr` and `gh issue` fail. Built-in tools read issues, list PRs, fetch diffs, post comments. | All GitHub writes use REST. Enabling GitHub auto-merge (GraphQL only) is impossible from a session. |
| Pushes | The proxy does not limit which branch is pushed. Auto mode allows pushing to the default branch. | A branch ruleset on `main` is mandatory, not optional. |
| Merging | Auto mode blocks merging a PR no human approved, approving its own PR, disabling CI checks, production deploys and force pushes. | Matches "human-approved merges first". Any later auto-merge must be a deterministic workflow outside Claude. |
| Unattended stops | A run waits for a human on an `ask` rule or after 3 blocks in a row / 20 in total. | The sweeper must detect a waiting session. |
| Session VM | 4 vCPU, 16 GB RAM, 30 GB disk; Node, Docker, PostgreSQL 16, Redis, Chrome, `gh` pre-installed. Pauses after a few idle minutes; uncommitted work can be lost if the VM is reclaimed. | Workers can run tests locally. Workers commit and push early. |
| Network | Default allowlist covers package registries and GitHub. Vercel is not listed. | Sessions never deploy. Vercel's own GitHub integration builds previews. |
| Secrets | Environment variables are readable by anyone using the environment; the docs warn against storing secrets there. | App secrets live in Vercel and GitHub Actions secrets, never in the session. |
| Claude in GitHub Actions | `claude-code-action` accepts `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`; runs draw on the subscription. | Documented fallback if routines fail a probe. |
| Terms | Consumer terms bar access "through automated or non-human means" except with an API key "or where we otherwise explicitly permit it". Scheduled tasks, their triggers and the GitHub Action are Anthropic's documented automation surfaces. | The design uses only those surfaces. Self-run `claude -p` loops on a server with a subscription login are avoided. This is a reading of the terms, not legal advice. |

### Critical gaps and the smallest alternative

1. **No push or CI trigger.** One GitHub Actions workflow (the dispatcher, section 4) listens to GitHub events and calls the API trigger. It contains no LLM.
2. **No GraphQL.** Role prompts use `gh api repos/...` for issues, labels, comments and PRs.
3. **No programmatic routine creation.** Each project gets exactly one routine, created once. The role is passed in `text`, and role instructions live in the repo.
4. **Projects cannot enforce hooks or be scripted.** Not used.

### Phase 0 probes

Results are in section 2a. The native path passed; the `claude-code-action` fallback is not needed.

### Final review before Phase 0 (2026-11-15)

Corrections and simplifications:

- **Routines can be created from a Claude Code session.** The session's remote-trigger tool creates, updates, runs and inspects routines and reads run logs. Gap 3 shrinks to "no public API"; project setup can be scripted from a local session. The fire token may still need generating in the web UI.
- **Native event triggers accept a structured filter.** If an issue-label or PR filter works (probe P8), some dispatcher paths could become native triggers. The dispatcher stays the single writer of state either way.
- **Native PR auto-fix** may cover CI-failure retries (probe P9). If it does, the dispatcher's CI-failed path is removed and only the attempt counter remains.
- **Roles start at two.** Phase 1 ships planner and worker only. Test-author and reviewer are added in Phase 2 only if Phase 1 data shows they are needed as separate sessions.

Failure cases added:

| Failure | Response |
|---|---|
| `GOALS.md` changes while work is in flight | Planner closes superseded issues with a `superseded` label; dispatcher closes their PRs. Unchanged issues are untouched. |
| PR conflicts with `main` (GitHub sends no event) | Sweeper checks `mergeable` on open PRs and re-fires the worker to rebase. Counts as an attempt. |
| Duplicate fire for one issue | The lease carries a run id; a worker whose id does not match the lease exits without pushing. |
| Planner creates too many issues | Hard cap per planner run (20). Over the cap, the planner stops and posts to the status issue. |
| Events raised with the Actions `GITHUB_TOKEN` do not trigger workflows | The dispatcher never relies on its own label changes to trigger itself; it does all follow-on steps in the same run. |
| Actions minutes exhausted on a private repo | Status issue stops updating; sweeper absence is the signal. Human action. |
| Fire token leaked or rotated | Token lives only in a repo secret; rotation is one secret update. |

Additional probes: P8 native event trigger with a label filter; P9 native auto-fix reacting to a failed check in a routine-started session.

## 2a. Phase 0 results (2026-11-15)

Run on Claude Pro and GitHub Free in the private repo `Ritik1221/factory-probe-0`, with four short cloud sessions. Evidence is in that repo's `PHASE0-RESULTS.md`.

| Probe | Result | Evidence |
|---|---|---|
| P1 Actions workflow fires the routine and `text` arrives | PASS | `fire` run 43693173421 returned HTTP 200 with a session id; the session echoed the nonce sent by the workflow. The first attempt failed with 401 because no API token had been generated. |
| P2 Repo hooks run in a routine session | PASS | SessionStart hook ran; PreToolUse hook blocked an edit of `GOALS.md`. |
| P3 `gh api` REST writes through the proxy | PASS | Label, issue, comments and PR created by the session. |
| P4 Session-opened PR starts CI | PASS | CI ran on PRs #2 and #3. |
| P5 Auto mode completes a worker task without stopping | PASS | Branch, commit, push and PR in 53 s, no permission stop. |
| P6 Branch protection on a private repo | FAIL | GitHub Free returns 403 for rulesets and classic protection on private repos. |
| P7 Usage per small task | PARTIAL | Wall time only: 5 to 53 s per trivial session. Usage percentages are not readable programmatically. |
| P8 Native issue-label trigger | PARTIAL | Fires within about 10 s and passes the issue number. No label filter was accepted, so it fires on every label event. |
| P9 Auto-fix reacts to a failed check | PASS | With `autofix_on_pr_create` on, the session that opened the PR was woken by the failed check and pushed a fix 27 s later. |

Consequences for the design:

1. **The Actions dispatcher is the only way sessions start.** The native label trigger is not used: it cannot filter and would spend a session per label change.
2. **The fire payload is delivered as data, not instructions.** The dispatcher sends only `ROLE=<role>` plus an issue number or commit SHA. The routine prompt tells the session to load the matching role skill from the repo.
3. **CI-failure retries are native.** Auto-fix replaces the dispatcher's "CI failed, fire worker again" path. The dispatcher keeps only a lease timeout and an attempt counter.
4. **A cloud Stop hook makes sessions commit untracked files.** Every repo ships a `.gitignore` for scratch files. Stray `claude/*` branches are harmless and pruned by hand for now.
5. **The VM is cached between runs.** No state is kept in the VM; all state is in GitHub.
6. **`main` cannot be protected on GitHub Free private repos.** Production assumes GitHub Pro and a ruleset. Until then the guards are the repo hooks, auto mode, and the dispatcher refusing any PR that touches protected paths.
7. **Routine setup needs one web-UI visit.** The environment and the API token are set there. New routines inherit every account connector and must have them cleared.
8. **The routine can be paused and resumed from a session**, which is the emergency stop.

## 3a. Phase 1 design (supersedes sections 3 to 5 where they differ)

Phase 1 is the complete `GOALS.md` → issues → worker → PR → CI pipeline with one worker, two roles and no reviewer, test-author or sweeper role. Sections 4 and 5 describe the later target.

### Pipeline

```
push GOALS.md (main) ─┐
push factory/plan     ├─▶ dispatcher (Actions, serialised, no LLM)
ci run completed      │     reads all state from GitHub, decides, acts
PR closed             │
hourly cron / manual ─┘
dispatcher: plan stale, nothing in progress   ─▶ fire ROLE=planner SHA=<sha>
planner session: writes factory/plan.json on branch factory/plan. Nothing else.
dispatcher: validates plan.json ─▶ creates/updates/supersedes issues by task id
dispatcher: deps closed ─▶ ready;  nothing in progress ─▶ fire ROLE=worker ISSUE=<n> ATTEMPT=<k>
worker session: branch factory/<task id>-a<attempt> ─▶ commits ─▶ PR "Closes #n"
CI red  ─▶ native auto-fix wakes the same session
CI green ─▶ dispatcher fires reviewer (in-review) ─▶ verdict ─▶ dispatcher merges that exact commit ─▶ issue closes
all tasks closed and plan current ─▶ status issue "Complete"
```

### Planner: LLM proposes, script disposes

The planner session's only output is `factory/plan.json` on the branch `factory/plan`:

```json
{ "goals_sha": "<commit of GOALS.md it planned from>",
  "tasks": [ { "id": "G1-T1", "goal": "G1", "title": "...",
               "acceptance": ["..."], "depends_on": [] } ] }
```

The dispatcher validates it before anything is created: ids match `G<n>-T<n>` and are unique, every `goal` is a `## G<n>:` heading in `GOALS.md`, acceptance criteria are non-empty, dependencies exist and are acyclic, at most 25 tasks. An invalid plan creates nothing and is reported on the status issue. The planner keeps ids of unchanged tasks and never reuses a retired id.

### Idempotency

- **The dispatcher is level-triggered.** Every run recomputes the full state from GitHub and applies the difference. The event that woke it is ignored, so repeated or reordered events cannot create work.
- **One issue per task id.** Each issue body carries a hidden marker with the task id and a content hash. An issue is created only if no issue, open or closed, has that id.
- **Changed tasks** update the issue only while it is `planned` or `ready`. **Removed tasks** in those states are closed as `superseded`. Work already started is left alone and listed on the status issue.

### Session control

- All dispatcher runs share one Actions concurrency group, so they never overlap.
- A session is fired only when no issue is `in-progress`. At most one fire per dispatcher run.
- The lease (timestamp and attempt) is written to the issue before the fire. If the fire call fails, the lease is rolled back and no attempt is spent.
- No new worker starts while the plan is stale, while `main` CI is red, or while any task is in progress or in review (main is strictly serial).
- The planner is fired at most three times per `GOALS.md` commit, at least 60 minutes apart.
- A lease with no new commit for 90 minutes returns the task to `ready`. The third expiry labels it `needs-human`.
- A PR that touches `GOALS.md`, `.github/**` or `.claude/**` is labelled `needs-human` and is never merged automatically. The list now also covers secrets and `.env` files, Dockerfiles, deployment and infrastructure configuration, and `migrations/` folders.

### Stale workers

A worker can outlive its lease: the session started late, or stalled and resumed. Three things stop it from doing harm:

1. **Its own branch.** Attempt `k` works only on `factory/<id>-a<k>`. The next attempt gets a new branch, started from the old one so work is kept. A late push from attempt `k` lands on a branch nobody reads.
2. **Its PR is closed.** The dispatcher reads only the current attempt's PR and closes open PRs from other attempts, so an old PR cannot be reviewed or merged by mistake.
3. **It checks before acting.** The payload carries `ATTEMPT=<k>`. The worker compares it with the issue marker before every push and stops on a mismatch. This is a courtesy check; points 1 and 2 hold even if it is skipped.

Writes to `main` are blocked by the repo hook now and by the GitHub Pro ruleset in production.

### Model routing

The fire call cannot choose a model; the model belongs to the routine. The dispatcher therefore chooses a routine per fire: `planner`, `worker` or `escalation` (tasks marked `hard` by the planner, and the last attempt of any task). Each route has its own routine id and token and falls back to the single base routine when unset. Suggested: Opus for planner and escalation, Sonnet for worker.

### Automatic merge (owner decision 2026-11-15; supersedes "owner merges" everywhere in this document)

The dispatcher, and only the dispatcher, merges. Its workflow token has `contents: write` for that one call; CI runs with `contents: read`; sessions never merge.

1. A current-attempt PR with green `ci` moves the task to `in-review`. The dispatcher records the head SHA and the time, then fires a reviewer session (`ROLE=reviewer ISSUE PR SHA`, its own route so it can run on Sonnet).
2. The reviewer checks the diff against the acceptance criteria and that no test or check was weakened, then posts one PR comment ending in `<!-- factory-review {"sha","verdict"} -->`.
3. The dispatcher merges (squash, `PUT pulls/<n>/merge` with `sha`) only if all of this holds for one commit: the PR is open and belongs to the current attempt; `ci` is green and was reported by GitHub Actions; the verdict is `approve`, names that SHA and was posted after the reviewer was fired; the head has not moved since; the branch contains everything on `main` (so the squash commit has the tree CI tested); GitHub reports no conflict; no protected path; no removed `lint`/`typecheck`/`test`/`build` script and no deleted test file; at most 100 changed files.
4. Outcomes: `reject`, conflict or a branch behind `main` return the task to `ready` for a new attempt, which reads the review. A moved head or red CI returns it to `in-progress`. No verdict within 45 minutes refires the reviewer, at most 2 reviews per attempt. Protected paths, weakened CI, an oversized PR, the review limit or a refused merge label the task `needs-human`. Three tries per task as before.

The review verdict is not a security boundary: worker and reviewer share one GitHub identity, so a worker could forge it. The checks in step 3 that the dispatcher computes itself are the boundary. On GitHub Free two holes remain and are accepted for disposable trial code only: `main` is unprotected, and a workflow file pushed to any branch can read repository secrets (verified on the trial repo with a dummy secret). GitHub Pro closes both (ruleset on `main`; fire token in an environment limited to `main`).

Issue creation is idempotent against GitHub's lagging issue list: created issue numbers are recorded in the status marker and read by number until listed, and a duplicate that appears anyway is superseded, keeping the issue furthest along.

### Phase 1 states

`planned` → `ready` → `in-progress` → `in-review` → closed, plus `needs-human` and `superseded`. There is no `awaiting-merge` state and no `attempt:n` label; the attempt count lives in the issue marker.

### Human actions in Phase 1

Editing `GOALS.md`, merging PRs, one-time repo and routine setup, and anything labelled `needs-human`. Production deployment is out of scope for agents.

## 3. Components

All reusable parts live in a **template repository**. A new product is a repo created from the template plus one routine.

| Component | Type | Responsibility |
|---|---|---|
| `GOALS.md` | Human file | Product intent, requirements, acceptance criteria, answers to questions. Agents never edit it. |
| Status issue (#1) | GitHub issue | Human-readable dashboard, last planned commit SHA, open questions. |
| Task issues | GitHub issues | One unit of work each: goal reference, acceptance criteria, dependencies, attempt count. Labels hold state. |
| Dispatcher | Actions workflow, no LLM | The only writer of task state transitions and the only caller of the API trigger. Enforces concurrency and retry limits. |
| Sweeper | Hourly Actions cron, no LLM | Releases stale leases and re-runs the dispatcher. |
| Factory routine | One cloud routine per repo | Starts a fresh session in a role given by `text`. |
| Role skills | `.claude/skills/factory-{planner,test-author,worker,reviewer}` | Instructions for each role. Loaded from the clone. |
| Guard hooks | `.claude/settings.json` | Block edits to protected paths inside a session. |
| CI | Actions workflow | Types, lint, unit tests, acceptance tests, path guard. The primary quality gate. |
| Branch ruleset | GitHub setting | `main` accepts changes only through a PR with passing checks. |
| Decision records | `docs/decisions/{issue}-{slug}.md` | One file per architectural decision, written in the PR that makes it. One file each avoids merge conflicts. |
| Vercel integration | Vercel GitHub app | Preview deployment per PR. No Claude involvement. |

Protected paths: `GOALS.md`, `.github/**`, `.claude/**`, `tests/acceptance/**` (except for the test-author role).

## 4. Event flow (target design; Phase 1 implements section 3a)

```
push GOALS.md ─▶ dispatcher ─▶ fire ROLE=planner
                                   planner diffs GOALS.md against last planned SHA,
                                   creates/updates issues, updates status issue
issue labelled / PR closed / cron ─▶ dispatcher picks next ready issue (deps closed,
                                   in-progress < limit) ─▶ fire ROLE=worker ISSUE=n
worker session ─▶ branch factory/issue-n ─▶ commits ─▶ PR "Closes #n"
PR opened/updated ─▶ CI
CI failed  ─▶ dispatcher: attempt < 3 ? fire ROLE=worker PR=m with log excerpt
                                      : label needs-human
CI passed  ─▶ dispatcher ─▶ fire ROLE=reviewer PR=m
reviewer   ─▶ comment + label review:pass | review:changes
review:changes ─▶ counts as an attempt, back to worker
review:pass    ─▶ label awaiting-merge, status issue updated ─▶ human merges
merge ─▶ issue closes ─▶ dispatcher unblocks dependents
```

Rules that keep state uncorrupted:

- **Single writer.** Only the dispatcher changes state labels and assigns work. Sessions report outcomes through PRs and comments.
- **One issue, one branch, one PR.** Workers never share a branch.
- **Every issue cites a goal line.** The planner may not create an issue without one. Follow-up ideas go to the status issue as proposals; they become work only when the owner adds them to `GOALS.md`.
- **Tests before code.** For each goal the planner creates a test-author issue that the implementation issue depends on. Workers cannot edit acceptance tests.
- **Dispatcher runs are serialised** with an Actions concurrency group, so two events cannot assign the same issue.

## 5. Task state machine (target design; Phase 1 implements section 3a)

States are mutually exclusive labels on the issue.

| State | Entered when | Leaves to |
|---|---|---|
| `planned` | Planner creates the issue | `ready` when all dependencies are closed |
| `ready` | Dependencies met, or a retry is released | `in-progress` when dispatched |
| `in-progress` | Dispatcher fires a worker and records a lease (timestamp, session URL, attempt) | `in-review` on PR with CI green; `ready` on failure with attempts left; `needs-human` at 3 attempts |
| `in-review` | CI passed, reviewer fired | `awaiting-merge` on pass; `ready` on changes requested |
| `awaiting-merge` | Review passed | closed on merge |
| `needs-human` | Retries exhausted, session waiting on approval, or an open question | `ready` when the owner answers in `GOALS.md` or relabels |
| closed | PR merged | terminal |

Attempt count is a label (`attempt:1` to `attempt:3`). It increments on CI failure, review rejection and lease expiry alike.

## 6. Failure recovery

| Failure | Detection | Response |
|---|---|---|
| Context exhaustion | Not applicable by design | Every role run is a fresh session that reads the issue, the PR and `docs/decisions/`. |
| Session crash or VM reclaimed | Lease older than 90 minutes with no new commit or comment | Sweeper returns the issue to `ready`, attempt + 1. The next worker continues the existing branch. |
| Session waiting for approval | Same lease timeout | Same, plus a note in the status issue naming the blocked action. |
| Usage limit reached | Fire is rejected, or lease expires | Dispatcher leaves the issue `ready` without spending an attempt and retries on the next sweep. No usage credits. |
| Trigger cap or API error | Non-2xx from `/fire` | Same as above. |
| GitHub disconnected | Routine pauses, turns off after 72 hours | Status issue shows no progress; owner reconnects. Human action. |
| CI red on `main` | CI on push to `main` | Dispatcher halts new work and opens a top-priority fix issue. |
| Planner produces nothing | Planner comment "no changes" | No work created. |
| Repeated failure on one task | `attempt:3` | `needs-human`. Other independent tasks continue. |

## 7. Completion detection

A product is complete when all three hold:

1. Every issue linked to a goal is closed.
2. The acceptance suite passes on `main`.
3. A planner run against the current `GOALS.md` creates no issue.

The dispatcher then marks the status issue "Complete" and fires nothing until `GOALS.md` changes. There is no idle work.

## 8. Human intervention

Required:

- One-time setup per project: create the repo from the template, create the routine, store its token as a repo secret, connect Vercel, add the ruleset.
- Merging PRs (Phase 1 to 3). One action per PR, possible from a phone.
- Secrets, paid services and any production promotion.
- Answering a `needs-human` question, by editing `GOALS.md`.
- Any change to protected paths.
- Reconnecting GitHub or waiting out a usage limit.

Not required: assigning tasks, prompting sessions, choosing implementation details, restarting failed work.

Known weakness: sessions act with the owner's GitHub identity, so the path guard and labels are not a hard security boundary against a misbehaving session. Auto mode, the hooks and the CI guard reduce this. A separate bot identity is the later fix if the experiment shows it is needed.

## 9. Auto-merge evaluation (after the experiment)

Auto-merge is considered only if the experiment shows zero merged PRs that later failed acceptance. If adopted, it is a deterministic Actions step that merges when CI is green, review passed, the diff touches no protected path and the PR is under a size limit. Claude never merges.

## 10. Usage and cost

- Plan in use: Pro. One worker at a time. Parallel workers are a configuration value in the dispatcher, raised only if measurement shows spare usage.
- Usage credits off. The system waits for the limit to reset.
- Actions minutes: the dispatcher is seconds per run. CI dominates.
- Expect a small product to span several days of usage windows on Pro. Phase 0 measures this before any plan decision.

## 11. First end-to-end experiment

Input: one `GOALS.md` describing a small product with one core create/read/update/delete feature and persistence. Auth and payments only if the owner's product needs them. Before starting, the owner writes about 15 expected behaviours in a private checklist the system never sees.

Run: the owner pushes `GOALS.md`, then only merges PRs and answers questions.

| Measure | Target |
|---|---|
| Hidden checklist items passing on the deployed preview | at least 80% |
| Human interventions, excluding setup and merges | 5 or fewer |
| Owner time, including merges | under 60 minutes |
| Tasks reaching `awaiting-merge` on the first attempt | reported |
| Merged PRs that later failed acceptance | reported; zero is the bar for auto-merge |
| Tasks ending in `needs-human` | reported |
| Usage windows consumed and elapsed days | reported |
| Completion detected correctly, with no work created afterwards | yes |

Failure reading: a checklist score under 80% with green CI means the acceptance tests are too weak, which is a planner and test-author problem, not an orchestration problem.

## 12. Roadmap

| Phase | Deliverable | Exit condition |
|---|---|---|
| 0 | Throwaway repo and routine running probes P1 to P9 | Done 2026-11-15. Native path chosen (section 2a) |
| 1 | Template repo per section 3a: dispatcher, planner and worker skills, hooks, CI, status issue. One worker. | One small micro-SaaS built from `GOALS.md` with the owner only merging PRs |
| 2 | Only what Phase 1 data shows is missing: test-author, reviewer, GitHub Pro ruleset, Vercel previews | Injected failures recover as in section 6 |
| 3 | The experiment in section 11 | Measures reported |
| 4 | Second project from the template; setup script for the manual steps | Setup under 15 minutes |
| 5 | Auto-merge evaluation, parallel workers, plain-language digest | Decided from Phase 3 data |

## 13. Out of scope

- Agent-to-agent messaging, Agent Teams and Projects.
- Self-hosted orchestrators (Gas Town, OpenHands, Agent Orchestrator) unless Phase 0 fails both the native path and the Actions fallback.
- Stacks other than Next.js on Vercel.
- Production deploys by agents.
- Multiple Claude accounts.
