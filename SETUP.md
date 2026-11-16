# One-time setup for a new product

1. Create a **public** repository on GitHub Free from this template. Public is what
   makes environments, required reviews and branch rules available without a paid plan.
   Keep products' secrets out of it entirely.
2. Connect your Claude account to GitHub with a **fine-grained personal access token**,
   not the Claude GitHub App. The app holds `workflows` and `actions` write, so a session
   could add a workflow whose own token can approve, merge and write as
   `github-actions[bot]`. Create the token for this repository only with Contents,
   Issues and Pull requests read/write and Metadata, Checks, Commit statuses and Actions
   read; no Workflows, Administration, Environments, Secrets or Webhooks. Then run
   `GH_TOKEN=<token> claude` and `/web-setup` (it sends the `gh` token to your Claude account).
3. In claude.ai/code/routines create **two** routines with the identical prompt below,
   one on Opus and one on Sonnet. A routine runs one model and a fire cannot change it.
   - Repository: this repository only. Cloud environment: no secrets, no connectors.
   - No schedule. "Auto-fix pull requests" off (the dispatcher decides retries).
   - Add an API trigger to each and generate its token.
   - Prompt:

     > You are a factory session for this repository. The fire payload starts with
     > `ROLE=<role>` where role is planner, worker, corrective-worker, reviewer or
     > final-reviewer, followed by fields such as `INVOCATION_ID`, `ISSUE`, `PR`, `SHA`,
     > `ATTEMPT`, `GOAL_VERSION`, `CONTRACT` and `EXPECTED_MODEL`.
     > Read `.claude/skills/factory-planner/SKILL.md` for planner,
     > `.claude/skills/factory-worker/SKILL.md` for worker and corrective-worker, or
     > `.claude/skills/factory-reviewer/SKILL.md` for reviewer and final-reviewer, and
     > follow it exactly using the payload fields. If the payload has no valid role,
     > reply "no role" and stop without using any tools.

4. Store the routines. Ids are variables; tokens are secrets of the `factory`
   environment, which may deploy only from `main`:

       gh api -X PUT repos/<owner>/<repo>/environments/factory -F deployment_branch_policy[protected_branches]=false -F deployment_branch_policy[custom_branch_policies]=true
       gh api -X POST repos/<owner>/<repo>/environments/factory/deployment-branch-policies -f name=main -f type=branch
       gh variable set FACTORY_ROUTINE_ID_OPUS --body trig_...
       gh variable set FACTORY_ROUTINE_ID_SONNET --body trig_...
       gh secret set FACTORY_FIRE_TOKEN_OPUS --env factory
       gh secret set FACTORY_FIRE_TOKEN_SONNET --env factory

5. Protect `main` (branch protection): require a pull request with **1 approval** and
   dismissal of stale approvals, require the `ci` and `e2e` checks, include
   administrators, block force pushes and deletion. In Actions settings set default
   workflow permissions to read-only and allow GitHub Actions to approve pull requests.
   Agent sessions act as you and cannot approve their own pull requests; the
   dispatcher approves exactly the reviewed commit and then merges it.
6. Set the variables `FACTORY_ACTIVE_PROVIDER=claude`, `FACTORY_CREDENTIAL_ISOLATED=false`,
   `FACTORY_WORKER_LOGIN` and `FACTORY_REVIEWER_LOGIN`. These identities must be
   distinct from one another and from `FACTORY_DISPATCHER_LOGIN`. A worker and
   reviewer sharing one GitHub identity is rejected: a secret published in a mutable
   review comment can be replayed after the original comment is edited or deleted.
   If Claude sessions can only use one identity, Claude review requires a human gate;
   use the credential-isolated Codex transport for unattended review.
   Also set `FACTORY_OWNER_LOGIN` (only issues this account opens become goals; on a public
   repository everyone else's `/goal` issues are ignored), `FACTORY_MAX_INVOCATIONS` and
   `FACTORY_MAX_TASKS`.
7. As the `FACTORY_OWNER_LOGIN` account, open an issue whose title starts with `/goal claude` and watch the issue "Factory status".

## What you do, and what you never do

You edit `GOALS.md`. The factory plans, builds, reviews and merges. A pull request is merged
only when, for one and the same commit: `ci` passed on GitHub Actions, a separate reviewer
session approved it after it was asked to, the branch contains everything on `main`, there is
no conflict, and the dispatcher's own checks found no protected path, no removed CI script, no
deleted test and no more than 100 changed files. Anything else is retried (three tries per
task) or labelled `needs-human`. The protected paths are the `PROTECTED` list in
`.github/factory/lib.mjs`: `GOALS.md`, `.github/**`, `.claude/**`, secrets and `.env` files,
Dockerfiles, deployment and infrastructure configuration, and `migrations/` folders.

If an issue lands in `needs-human`, read its last comment, fix the cause, and set its label back to `ready`; it gets a fresh set of tries.

To stop everything: set `FACTORY_AGENT_EXECUTION=disabled` (reconciliation continues, no agent is fired) and pause both routines. To resume: re-enable them, remove the variable and run the `factory` workflow manually.

## Model routing

| Route | Used for | Model routine |
|---|---|---|
| planner | turning the goal into the plan | Opus |
| escalation | tasks the planner marks `hard` (including generated corrections) and the last attempt of any task | Opus |
| final-reviewer | reconciling the delivered product with the original goal | Opus |
| worker | routine tasks | Sonnet |
| reviewer | independent review of one pull request commit | Sonnet |

Model-tier pairs are preferred. Existing role-specific pairs and the original single
routine pair remain supported when the higher-priority pair is entirely absent; a
partially configured pair fails closed. Each fire carries `EXPECTED_MODEL`, and a
session on another model family stops without acting and says so.

To pause everything, pause both routines.
