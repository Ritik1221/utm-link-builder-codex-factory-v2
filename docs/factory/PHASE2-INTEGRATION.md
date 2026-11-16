# Phase 2 integration protocols

Do not run either stage against an existing product repository. Keep
`factory-probe` paused. Zero additional GitHub or infrastructure subscription
cost is a hard constraint.

## Stage A — GitHub only

Purpose: validate GitHub events, permissions, journal replay, idempotency,
concurrency, issue creation and crash recovery without invoking Claude or Codex.

1. Assemble a fresh repository from an explicit synthetic-file allowlist. Do
   not copy an existing Git history, product source, secrets or customer data.
2. Create a disposable **public** personal repository on GitHub Free. Protect
   `main` with strict `ci` and `e2e` checks, PR-only updates, admin enforcement,
   conversation resolution, linear history, and force-push/deletion blocks.
   Do not claim that application checks or an unaffiliated review comment are
   equivalent to a GitHub-enforced required approval.
3. Configure repository variables:
   - `FACTORY_AGENT_EXECUTION=disabled`
   - `FACTORY_ACTIVE_PROVIDER=<selection only; no call is made>`
   - `FACTORY_REVIEWER_LOGIN=<unaffiliated public test identity>`
   - `FACTORY_WORKER_LOGIN=<different unaffiliated public test identity>`
   - `FACTORY_OWNER_LOGIN=<your GitHub login>`
   Leave every routine, Codex runner and API credential unset.
4. Manually dispatch the factory once. Confirm exactly one `factory-status`
   issue exists and its journal is authored by `github-actions[bot]`.
5. Disable only the disposable factory workflow, open one `/goal` issue, verify
   that no dispatcher consumed the event, re-enable the workflow, and dispatch
   reconciliation manually. Confirm one immutable snapshot and one canonical
   goal even though the original event was dropped.
6. Read the snapshot hash from the status issue. Locally create a valid
   `factory/plan.json` tied to that hash, including architecture, assumptions,
   constraints, decisions, invariants, requirement/test mappings and a real e2e
   contract. Push only this fixture plan to `factory/plan` in the disposable repo.
7. Use guarded disposable-repository failpoints to crash once after journal
   append and once after task issue creation. Rerun normally and confirm event
   replay materializes the snapshot and adopts the unique task issue.
8. Dispatch at least three duplicate runs together. GitHub may retain one
   running and one pending concurrency member while canceling an older pending
   run. Confirm the survivors reconcile authoritative state and do not create
   duplicate ownership.
9. Edit a task label to one legal adjacent state and rerun; confirm an audited
   reconciliation. Introduce an impossible transition or duplicate task marker;
   confirm the factory stops with `needs-human`/an unsafe-state note.
10. Delete or edit a copied journal event only in this disposable repository.
    Confirm the hash chain fails closed. Restore the repository from the test
    backup rather than manually inventing a new event.
11. Prove the unaffiliated worker cannot create an upstream ref, a forged
    non-dispatcher journal comment is ignored, exact-main CI runs on the current
    main SHA, and no provider secret or invocation exists.
12. Record issue numbers, event ids, Actions run ids, cancellation points and all
    human actions. Keep or delete the public repository only after evidence is
    exported.

Stage A passes only if no provider endpoint was contacted, duplicate delivery
created no duplicate ownership, interruption replayed safely and ambiguous state
failed closed.

## Stage B — one bounded real provider

Run only after Stage A passes and the owner explicitly names `claude` or `codex`.
Use a fresh disposable private repository and one goal with two or three tasks.
The scenario must include one deliberately review-rejected defect and a final
review omission that is safe to correct automatically.

### Common setup

1. Set `FACTORY_AGENT_EXECUTION=enabled` (or remove the disabled value).
2. Set exactly one `FACTORY_ACTIVE_PROVIDER`. Do not configure silent fallback.
3. Do not give planner, worker or reviewer processes any GitHub credential. The
   GitHub-hosted dispatcher is the only repository writer. Configure
   `FACTORY_OWNER_LOGIN`; decisions marked as requiring human approval proceed
   only after that account comments exactly
   `/approve ADR-NNN <plan-hash-shown-by-the-dispatcher>` on the goal.
4. On a GitHub Free personal private repository, treat branch protection as
   unavailable unless the repository API proves otherwise. Preserve exact-SHA,
   protected-path and reviewer checks in the dispatcher, but report them as
   application controls—not equivalent GitHub enforcement.
5. Set a hard experiment budget: maximum 3 task attempts, 2 task reviews, 2 final
   reviews, 2 correction rounds, 6 correction tasks and the existing workflow
   timeout. Pause immediately on unexpected billing, credential prompts or
   authority-boundary violations.
6. Confirm the provider preflight before opening the goal. Capture versions and
   authentication mode without printing tokens.

### Codex-only setup

1. Use a disposable local VM or a dedicated OS account that contains no personal
   files, SSH keys, GitHub credentials or cloud credentials. A VM is preferred:
   a same-kernel macOS account reduces filesystem exposure but does not provide a
   hard VM boundary. The Codex process necessarily has access to its own ChatGPT
   login material, which remains a residual credential risk.
2. Install the reviewed Codex CLI version in that environment and sign in
   interactively with the intended ChatGPT account. Do not set `OPENAI_API_KEY`;
   the execution wrapper does not forward it. Confirm `codex --version` and
   `codex login status` without printing token files.
3. Create two local identities: `factory-runner` owns only the GitHub Actions
   runner installation; `factory-codex` owns only `CODEX_HOME`, a disposable
   home, and working directories. Neither account has a Git credential helper,
   repository clone or personal files. Register only `factory-runner` with label
   `factory-codex-isolated`. Do not add a public tunnel.
4. From the exact owner-approved factory commit, install the complete
   `.github/factory` directory root-owned and non-writable at
   `/usr/local/libexec/factory-codex/app`. Install the reviewed
   `runner/execute-launcher.sh` root-owned at
   `/usr/local/libexec/factory-codex/execute`. Create root-owned mode-0600
   `/etc/factory-codex-runner.conf` containing only
   `FACTORY_RUNNER_TEMP_ROOT`, `FACTORY_CODEX_HOME`, `FACTORY_AGENT_UID`,
   `FACTORY_AGENT_GID` and the absolute reviewed `FACTORY_NODE_BIN`. The launcher accepts only the fixed
   `factory-input`/`factory-result` directories under that runner temp root and
   clears its environment before starting the installed Node wrapper.

   The sudoers entry for `factory-runner` permits only this fixed root-owned
   launcher, not a shell, `env`, `node`, arbitrary arguments to another program,
   or package installation. Verify all installed files are owned by root and not
   writable by either runtime account.
5. The implemented broker now exports an exact-SHA archive with no `.git`,
   rejects symlinks, hashes every file, caps source/result size and file count,
   strips GitHub/API credentials, and gives reviewers a read-only Codex sandbox.
   A root-owned wrapper computes the change set; the GitHub-hosted publisher
   revalidates hashes, exact base content, role-specific paths and structured
   output before creating branches, PRs or review comments. Codex never receives
   a repository credential.
6. Configure the private disposable repository variables:
   - `FACTORY_ACTIVE_PROVIDER=codex`
   - `FACTORY_AGENT_EXECUTION=enabled`
   - `FACTORY_CODEX_EXECUTION_MODE=github-actions`
   - `FACTORY_CREDENTIAL_ISOLATED=true`
   - `FACTORY_DISPATCHER_LOGIN=github-actions[bot]`
   - `FACTORY_OWNER_LOGIN=<owner login>`
   - `FACTORY_MAX_INVOCATIONS=12`
   - `FACTORY_MAX_TASKS=2`

   Leave every Claude routine/token, OpenAI API key, runner token and personal
   access token absent from repository secrets. The temporary GitHub runner
   registration token is used only during runner setup and is not exposed to the
   Codex child.
7. In GitHub billing, verify included Actions compute/storage remains and create
   a zero-dollar Actions budget with **Stop usage when budget limit is reached**.
   Private-repository prepare, publish and CI jobs consume the included
   GitHub-hosted allowance; self-hosted execution itself is free. Do not start if
   GitHub would permit overage billing.
8. Keep the host awake and online for the bounded experiment. Each dispatch
   carries a `not_after` deadline 20 minutes ahead. The root-owned wrapper
   refuses to start Codex after it (no result, no receipt, no ledger attempt).
   The dispatcher inspects the run's jobs: an `execute` job still waiting for a
   runner 25 minutes after the run was created, or running 35 minutes after it
   started, is cancelled with an audited `agent-transport-cancelled` event. A
   cancelled, failed or receipt-less concluded run is redispatched under the same
   invocation id after a 60-second settle, at most three dispatches in total,
   then `needs-human`. A cancellation GitHub does not honour within 10 minutes
   also becomes `needs-human`. A queued/running invocation preserves its factory
   lease rather than spending a new product attempt. The local ledger re-delivers
   a completed result without another model call; the input `digest` excludes
   the per-dispatch deadline so redispatches still match. A superseded delayed
   invocation is rejected before publication. Authentication expiry and quota
   errors block the selected provider and never fall back to an API key or Claude.
9. Publication and reconciliation. The publisher idempotently posts one receipt
   for every result and never dispatches another workflow. It exits non-zero for
   any status other than `completed`, so a failed agent turns the `codex-agent`
   run red. One trailing `reconcile` job runs with `if: always()` and dispatches
   `factory.yml` once per bounded transport run, including when execute or
   publication failed. Comments made with `GITHUB_TOKEN` start no workflow.
10. Isolated job layout. The wrapper copies the input artifact (regular files
    only) into a root-private staging directory before verifying it, and gives
    the agent account only paths it can reach: traverse-only `0711` job parents,
    a root-owned read-only `control/schema.json`, an agent-owned `workspace/` and
    `output/`. The trusted baseline and staged input stay root `0700`. All
    agent-UID processes are killed before Codex starts, after it exits and when
    the step is cancelled. `factory-result` is handed back to the runner account
    so it can upload and clean `_temp`.
11. Codex 0.146.0 sandboxes commands with bubblewrap, which needs user
    namespaces. Docker's default seccomp profile blocks them, so run the runner
    container with `--security-opt seccomp=unconfined` (or a profile that allows
    `clone`/`unshare` with user namespaces). Verify without a model call:
    `docker exec --user factory-codex <container> codex sandbox -P :workspace -C /tmp -- true`.

The broker, idempotency and adversarial behavior are tested locally. The Linux
account, mode and launcher boundary is tested in Docker with a probe in place of
Codex: `sh .github/factory-runner-test/run.sh`. Actions artifact provenance,
private-repository token permissions, real `codex exec` inside the bubblewrap
sandbox and real ChatGPT subscription behavior remain unverified until the
owner-approved live run.

### First Codex-only goal: UTM Link Builder

Use one `/goal codex` issue with this body. Do not pre-create tasks:

> ## G1: UTM Link Builder
>
> Build a polished, mobile-friendly single-page web app that turns a valid
> `http` or `https` destination URL into a campaign URL. It must require source,
> medium and campaign; support optional term and content; preserve unrelated
> existing query parameters and fragments; deterministically replace existing
> `utm_*` parameters with the entered values; show field-level validation; show
> the generated URL live; and provide an accessible copy action with visible
> success/failure feedback. Use no authentication, database, analytics, paid API,
> external backend or deployment. Keep all data in the current browser session.
> Decompose this bounded experiment into at most two implementation tasks.
>
> Unit tests must cover URL validation, encoding, existing query strings,
> fragments and replacement behavior. A meaningful browser-level or HTTP-level
> e2e test must enter realistic values, generate the exact expected URL and
> exercise the copy interaction or its deterministic adapter. Lint, tests, build
> and e2e must pass. The final reviewer must reconcile every sentence above
> against the exact final main SHA.

Expected normal budget is six invocations: one planner, two workers, two task
reviews and one final review. The hard cap of 12 unique invocations permits one task rejection and
one final-review correction cycle. A root-owned local ledger uses an atomic,
durable claim and permits at most one actual Codex process start per invocation,
including after interruption (12 in the pathological worst case; normally six),
while completed results are redelivered without another model call. Any thirteenth invocation, protected-path
request, provider switch, paid-billing prompt, ambiguous product decision or
credential-boundary failure stops the experiment.

### Launch checklist

- [ ] New disposable private repository contains only the approved factory
      template and synthetic UTM goal; FreightLens and existing repositories are untouched.
- [ ] Local regression suite, guard test, secret scan and YAML parse pass at the
      exact factory commit copied to the repository.
- [ ] Root-owned launcher hash and installed factory code hash are recorded.
- [ ] Dedicated runner and Codex identities/VM contain no unrelated files or credentials.
- [ ] `codex login status` says ChatGPT login; no OpenAI/Anthropic API key exists.
- [ ] GitHub runner is online with only `self-hosted,factory-codex-isolated` labels.
- [ ] Repository variables above are exact; no provider or PAT secrets exist.
- [ ] GitHub Actions overage spending is blocked and included usage is available.
- [ ] Owner records the starting main SHA, Actions run ids and ChatGPT usage view.
- [ ] Owner opens the single `/goal codex` issue and performs no task management.
- [ ] Stop immediately on a security-boundary violation, unexpected billing or
      any request to weaken CI/protected paths.

### Claude-only setup

1. Explicitly authorize use of the existing Claude routine and verify its
   subscription/billing behavior in the Anthropic account before firing it.
2. Configure only the existing route-specific routine ids/tokens and the dedicated
   reviewer identity. Do not configure Anthropic API billing as an implicit
   fallback.
3. Keep `FACTORY_ACTIVE_PROVIDER=claude` for the complete run.

### Required observed sequence

Capture evidence for:

`goal snapshot → validated plan → task issues → worker PR → CI → independent task review → exact-SHA merge → exact-main CI/e2e → final goal reconciliation → complete`

If either reviewer finds a genuine defect, also require the corresponding
`structured reject → bounded corrective task/attempt → regression test → new
review of the new exact SHA` sequence. Do not deliberately ship a known defect
into the UTM experiment merely to force this path; the rejection and final
correction loops remain locally demonstrated until a genuine live finding or a
separately approved fault-injection experiment exercises them.

For every invocation record provider, invocation id, role, attempt, external id,
observable subscription usage, result, retry and intervention. A pass requires
no manual task management, no stale-SHA acceptance, no unresolved blocking
finding and no completion before original-goal reconciliation.
