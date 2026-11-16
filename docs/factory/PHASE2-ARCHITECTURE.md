# Phase 2 hardened factory architecture

## Scope and status

This design extends the existing GitHub Actions dispatcher and state machine. It
does not replace them and does not add a database, dashboard or parallel
factory. Local behavior is covered by mocks; GitHub side effects and real agent
execution are not proven until the two live stages in `PHASE2-INTEGRATION.md`
pass.

## Components and trust boundaries

| Component | Responsibility | May write | Must not do |
|---|---|---|---|
| Goal issue | Human product request and initial provider selection | Owner | Mutate the immutable snapshot |
| Dispatcher | Deterministic transitions, journal, leases, mechanical exact-SHA approval after independent review, merge | Factory status, task issues, authorized approvals/merges | Implement code or supply the independent review verdict |
| Provider adapter | Translate one provider-neutral invocation | Invocation result only | Select another provider or decide completion |
| Codex execution job | Run one invocation against a credential-free exact-SHA archive | Bounded result artifact only | Receive GitHub credentials, `.git`, publish or merge |
| Trusted publisher | Validate a Codex result and project it into GitHub; use the owner's narrowly scoped PAT only for branch push and PR authorship | Attempt/plan branch and owner-authored PR; dispatcher token writes review/receipt projections | Expose the PAT to Codex, approve/merge, or make lifecycle/completion decisions |
| Worker | Implement one assigned attempt | Snapshot working copy only in credential-isolated mode | Review, merge, labels, factory controls |
| Reviewer | Review one exact SHA | One structured review result | Modify code, merge or change state |
| GitHub Actions CI | Produce check evidence | Check runs | Declare product completion |
| Status renderer | Generate the human status/audit report | Status issue body projection | Become an independent state store |

The dispatcher remains provider-independent. Planner, worker,
corrective-worker, reviewer and final-reviewer all receive the same versioned,
content-addressed invocation contract. Claude and Codex adapters implement that
contract; lifecycle logic exists only in the dispatcher.

For Codex, the invocation also fixes the role-selected model and reasoning
effort. The isolated CLI receives those explicit values with strict config and
ignores user configuration; an unavailable or rejected model fails that
invocation without provider or billing fallback.

## State ownership

The authoritative project record is a dispatcher-authored, hash-chained event
journal in comments on the single `factory-status` issue. The `factory-state`
JSON in the issue body is a versioned materialized checkpoint, not an
independent history. The dispatcher verifies the complete journal chain against
that checkpoint and replays any committed tail on every run.

| Fact | Authoritative source | Projection/evidence |
|---|---|---|
| Original requirements | Immutable goal snapshot in canonical state and dispatcher-authored goal comment | Current goal issue body is non-authoritative after intake |
| Selected provider and switches | Canonical provider history | Goal label and repository variable are requested configuration |
| Accepted plan, assumptions, constraints, architecture and requirement mapping | Accepted plan copy in canonical state | `factory/plan.json` is the proposed artifact |
| Task lifecycle, attempts and leases | Canonical task and operation records | Task issues and labels are operational projections |
| Code and commit identity | Git commits and PR head SHA | Task record references exact SHAs |
| CI and e2e result | GitHub Actions check run for exact SHA | Status summary |
| Audit finding and resolution | Canonical finding history | Authorized review comment is signed evidence by identity/SHA/time window |
| Architecture rationale added during work | Git-tracked ADR content plus canonical path/blob/commit index | Generated status summary |
| Completion | Canonical completion record after all gates | Closed issues alone have no completion authority |

The status record retains the full original goal, accepted plan, task attempts,
agent invocation summaries and immutable context hashes, operations, provider
history, findings with resolution history, ADR indexes and completion evidence.
The append-only journal preserves earlier versions when the current checkpoint
is compacted.

Plan decisions declare whether owner approval is required. Only a comment of the
form `/approve ADR-NNN <64-character-plan-hash>` from `FACTORY_OWNER_LOGIN` becomes a canonical approval;
pending decisions appear in the report and block task creation.

## Persistence protocol and limits

Each canonical change uses this protocol:

1. Read the status checkpoint and all authenticated journal events.
2. Validate event hashes, sequence and predecessor chain; replay a committed
   tail after an interrupted checkpoint write.
3. Compare the recovered revision/head with the dispatcher's starting revision.
4. Append one content-addressed event comment containing the state patch.
5. Re-read the journal. A duplicate sequence with another event is a fork and
   fails closed.
6. Materialize the compact checkpoint and human report into the issue body.

Workflow concurrency serializes normal GitHub runs, while revision/head checks
and fork detection protect against delayed or concurrent writers. GitHub does
not provide one transaction spanning comments, issues, PRs and merges. The
event-first protocol plus operation intents is therefore a recoverable saga,
not ACID storage. A credential with dispatcher authority remains a trust root.

Local safety ceilings are 48 KiB for checkpoint JSON, 56 KiB per event, 60 KiB
for the complete status body and 2,000 state-changing events. No-op status
refreshes do not consume journal entries. At the journal ceiling the factory
stops for an owner-approved archive/rollover; it never discards audit history
silently. Full-history pagination will eventually increase dispatch latency.
Automated journal rollover is intentionally not claimed as implemented.

State and event schemas are independently versioned. Version 1 checkpoints are
migrated to version 2 in memory and re-materialized through the journal.
Unsupported versions, missing events, edited events, deleted events, forks and
unauthorized event authors fail closed.

## Recovery model

Before a non-idempotent GitHub side effect, the dispatcher records an operation
intent. After restart it consults GitHub evidence:

| Interruption | Proven recovery | Unsafe case |
|---|---|---|
| Task issue creation | Adopt one issue with the exact task marker; wait for consistency before retry | More than one matching owner |
| Worker created PR before recording | Adopt the unique open/merged PR for the assigned attempt branch | Multiple PRs for one attempt |
| Expired worker/reviewer | Return to `ready` after bounded lease | Active lease is not preempted |
| Journal appended, checkpoint not written | Replay the authenticated event tail | Missing/forked/tampered tail |
| Label changed, event not written | Adopt only a valid adjacent transition with matching task and goal hashes | Impossible/reverse or unrecognized transition |
| Merge response lost | Mark complete if GitHub shows the expected SHA merged; retry only if it proves the exact SHA is still open | Closed, missing or changed head |
| Review interrupted | Accept only one authorized result after lease time for the exact SHA and goal | Duplicate, stale, malformed or unauthorized result |
| Dispatcher restart | Rebuild from checkpoint, journal and GitHub evidence | Conflicting evidence becomes `needs-human` |

Potentially destructive actions are never repeated solely because a network
response was lost.

## Audit and autonomous correction

Task and final findings require a stable id, severity, evidence, affected commit,
file/behavior, problem and required corrective test. A final blocking or major
finding must explicitly state whether autonomous correction is safe. Safe
findings generate hard corrective tasks linked to the finding and routed through
the normal worker, CI and independent-review path.

Correction is bounded to two final-review rounds and six generated tasks per
round. Ambiguous findings, exhausted budgets or non-autonomous requirements move
to human attention. A corrected finding remains
`corrected-pending-final-review` until a new final review approves the new main
SHA and reconciles the original goal.

Completion requires all base and corrective tasks done, exact-main CI and e2e
checks green, a meaningful non-placeholder smoke contract, one authorized final
review of the exact main SHA and goal version, full original-goal reconciliation
and no unresolved blocking or major finding.

## Provider contract and switching

Every invocation includes contract version, invocation id, goal id/version,
role, explicit provider, repository, base SHA, task/issue/PR references, attempt,
timeout, retry budget, immutable context and output schema. History stores the
content hash and stable references; provider-specific output cannot mutate
dispatcher decisions directly.

An issue beginning `/goal`, `/goal claude` or `/goal codex` is idempotently
labelled and snapshotted as intake. `provider:claude` or `provider:codex` on the goal chooses the initial provider.
`FACTORY_ACTIVE_PROVIDER` explicitly overrides it for a run. There is no
fallback. A change is journaled and waits for active leases to expire. Provider
authentication, quota or availability failures block the selected provider.
The owner can switch providers or set a new one-time
`FACTORY_PROVIDER_RESUME_NONCE` after restoring the same provider.

`FACTORY_AGENT_EXECUTION=disabled` is the GitHub-only/emergency pause. In that
mode reconciliation and deterministic projections continue, but no planner,
worker or reviewer invocation is emitted.

### Subscription boundary

OpenAI documents that signing Codex CLI in with ChatGPT uses the ChatGPT plan,
while an API key uses API pricing. The Codex adapter therefore calls only an
explicit trusted runner and does not accept or forward an OpenAI API key. The
runner launches `codex exec` with restricted environment variables, bounded
output, a timeout, an ephemeral session and role-specific sandbox. Long-lived,
unattended refresh of an individual's ChatGPT login on a self-hosted runner is
not established here; runner availability and login preflight remain an
operational boundary.

Anthropic documents local Claude Code login with Claude Pro/Max separately from
Console/API billing. The existing Claude cloud-routine endpoint is preserved,
but this implementation has not proven that its unattended execution and
billing are equivalent to a local subscription login. It must be validated in
a bounded authorized experiment.

References:

- https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan
- https://developers.openai.com/blog/codex-as-a-platform
- https://docs.anthropic.com/en/docs/claude-code/getting-started
- https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency

## Security controls and residual risks

- Exact-SHA CI, review and merge checks remain mandatory.
- Protected factory, secret, deployment, infrastructure and migration paths do
  not auto-merge.
- Worker and reviewer role contracts prohibit crossing authority boundaries;
  reviewers must use a distinct configured GitHub identity.
- Repository content, issue text, PR text, documents and tool output are treated
  as untrusted prompt material.
- The Codex runner strips arbitrary environment variables, never uses a shell,
  gives reviewers read-only filesystem access and caps process time/output.
- The Codex child process receives no GitHub token or model API key. Git global
  and system credential lookup and interactive Git prompts are disabled. The
  GitHub-hosted prepare job exports a credential-free exact-SHA archive without
  `.git`; the isolated wrapper computes a content-addressed bounded change set;
  and the GitHub-hosted publisher revalidates and applies it. Results are
  idempotent by invocation and digest, and conflicting receipts fail closed.
- Attempts, review fires, final reviews, corrective rounds and task count are
  bounded; a goal also stops at 100 recorded agent invocations.

Remaining risks are material: this Codex artifact path is locally tested but not
yet exercised by GitHub or a real agent; GitHub Actions permissions are repository-scoped,
GitHub has no cross-resource transaction, a compromised dispatcher credential
can rewrite trusted state, role separation is only real when distinct GitHub
identities/tokens and runner accounts are configured, and subscription-backed
unattended sessions can expire or require interaction. These are live-integration
and operations concerns, not properties established by mocks.
