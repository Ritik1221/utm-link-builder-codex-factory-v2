# Factory handoff: state on 2026-11-15, plan for Wednesday

Phase 1 is finished. Resume from here; nothing in Phase 1 needs repeating.

## Where everything is

| Thing | Location |
|---|---|
| Factory code (the template) | Local: `/Users/ritik/Expo/auto-code/factory-template`. Remote: `Ritik1221/factory-trial-1`, branch `main` |
| Trial product and test history | Same repository: `src/`, `package.json`, issues #1 to #7, PRs #5 and #7 |
| Design, plan, results, this file | Local: `/Users/ritik/Expo/auto-code/` (`docs/superpowers/`, `PHASE1-RESULTS.md`, `NEXT-STEPS.md`). Copies in the trial repository under `docs/factory/` |
| Decision ledger | `/Users/ritik/Expo/auto-code/.superpowers/sdd/2026-11-15-factory-phase-1/progress.md` (local only) |
| Routine | `factory-probe`, id `trig_01GdRbPgsojhNjA5TjaNbDad`, Sonnet 5.5, API trigger only, attached to `factory-trial-1`, **paused** |
| Cloud environment | `env_01V6iEeUi5ptgrEuGHFCQJrP` |
| Fire token | Stored as the secret `FACTORY_FIRE_TOKEN` in `factory-trial-1`. It exists nowhere else |

The template has no repository of its own. It lives inside the trial repository, mixed with the trial product. That is the first thing to change on Wednesday.

## Architecture in one page

- You edit `GOALS.md` on `main`. Nothing else is your job.
- **Dispatcher** (`.github/workflows/factory.yml` running `.github/factory/run.mjs` and `lib.mjs`): a deterministic GitHub Actions job, no AI. It always runs the copy on `main`. It reads issues, pull requests and CI, decides the next step, and is the only thing that starts sessions or merges.
- **Sessions**: Claude Code cloud sessions started through a routine's API trigger. The message is one of `ROLE=planner SHA=…`, `ROLE=worker ISSUE=… ATTEMPT=…`, `ROLE=reviewer ISSUE=… PR=… SHA=…`. Each role follows `.claude/skills/factory-<role>/SKILL.md`.
- **Flow**: `GOALS.md` changes → planner writes `factory/plan.json` on branch `factory/plan` → dispatcher validates it and creates one issue per task → worker opens a PR from `factory/<task>-a<attempt>` → `ci` runs → reviewer posts a verdict for one commit → dispatcher merges that exact commit → issue closes → next task.
- **Limits**: one task in progress at a time; 3 tries per task; 2 reviews per try; 3 planner fires per `GOALS.md` version; 25 tasks per plan; 100 files per PR; worker lease 90 minutes.
- **Never merged automatically**: `GOALS.md`, `.github/**`, `.claude/**`, secrets and `.env` files, Dockerfiles, deployment and infrastructure configuration, `migrations/` folders. Those go to `needs-human`.
- **Guard hook** (`.claude/hooks/guard.sh`): stops sessions from editing protected paths, pushing to `main`, force pushing or merging. It catches mistakes; it is not a sandbox.
- **Emergency stop**: pause the routine.

## Working versus not yet

### Working, proven live on the trial repository

- Planner, worker and reviewer sessions on Sonnet 5.5, three sessions for one task.
- Automatic merge of the exact reviewed and CI-tested commit by the dispatcher's own token.
- A red CI holds the task; an approval naming another commit is ignored (local rehearsal against the real repository).
- No duplicate issues or PRs; rerunning the dispatcher changes nothing.
- A paused routine refuses fires and the dispatcher rolls its state back.

### Built and unit-tested (38 tests), never run live

- Model routing by route (see below).
- Review rejection and retry, worker fixing red CI, branch behind `main`, conflicts, lease expiry, `needs-human`, multi-task plans with dependencies, the hourly sweep.
- The planner's status comment. In the live run a hook defect stopped it; the hook is fixed but the comment path has not been seen working.

### Not built

- A standalone template repository and a one-command way to start a product from it.
- A second (Opus) routine.
- Any deployment or preview URL.
- GitHub Pro protections.
- A measured cost per task. The before figures were session 23 %, weekly 64 %; the after figures were not recorded.

## Model routing

A routine runs one model and a fire call cannot change it, so routing means one routine per model. The dispatcher already picks a route for every fire:

| Route | When the dispatcher uses it | Model wanted | Variable | Secret |
|---|---|---|---|---|
| planner | `GOALS.md` changed | Opus | `FACTORY_ROUTINE_ID_PLANNER` | `FACTORY_FIRE_TOKEN_PLANNER` |
| worker | a task marked `routine`, tries 1 and 2 | Sonnet | `FACTORY_ROUTINE_ID_WORKER` | `FACTORY_FIRE_TOKEN_WORKER` |
| escalation | a task the planner marked `hard`, or the third and last try of any task | Opus | `FACTORY_ROUTINE_ID_ESCALATION` | `FACTORY_FIRE_TOKEN_ESCALATION` |
| reviewer | every review | Sonnet | `FACTORY_ROUTINE_ID_REVIEWER` | `FACTORY_FIRE_TOKEN_REVIEWER` |

A route with no variable and secret falls back to `FACTORY_ROUTINE_ID` and `FACTORY_FIRE_TOKEN`.

Smallest configuration for two models:

- Base pair → the Sonnet routine. This covers worker and reviewer.
- `PLANNER` and `ESCALATION` pairs → the Opus routine (same id and token under both names).

Expected Opus use: one planner session per `GOALS.md` edit, plus one session per `hard` task, plus one for any task that fails twice. The planner skill tells the planner to mark a task `hard` only for real design work (data model, authentication, payments, concurrency, migrations) and to expect one or two per plan.

Unverified: whether a Pro plan can run Opus in a routine at all, and what an Opus planner session costs. Both are on the Wednesday checklist before the product starts.

## Multi-repository setup

Each product gets its own private repository containing a copy of the factory files. The factory files are small (17 files) and are copied, not shared, so a product keeps working if the template changes.

A routine is attached to one repository. Simplest arrangement while only one product is being built at a time: keep two routines in total (Sonnet and Opus) and repoint both to the active product. Whether one routine can serve several repositories is unverified; do not rely on it.

### Exact steps to start a new product (after the one-time work in the checklist)

1. Create an empty private repository `Ritik1221/<product>`.
2. Copy the template into it: `.claude/`, `.github/`, `.gitignore`, `SETUP.md` and a blank `GOALS.md`. Do not copy `src/`, `package.json`, `docs/` or the `factory/plan` branch.
3. Apply the GitHub Pro settings from the Security section.
4. Point the Sonnet and Opus routines at the new repository (repository and working branch; prompt unchanged). Keep them paused.
5. Generate a fresh API token for each routine and store the ids and tokens in the new repository:
   - `gh variable set FACTORY_ROUTINE_ID -R Ritik1221/<product> --body <sonnet routine id>`
   - `gh secret set FACTORY_FIRE_TOKEN -R Ritik1221/<product> --env factory`
   - the same for `FACTORY_ROUTINE_ID_PLANNER`, `FACTORY_ROUTINE_ID_ESCALATION` and their two secrets, using the Opus routine.
   Type tokens into the prompt `gh` shows; never paste them into a chat.
6. Write the product into `GOALS.md`, enable the routines, push. Watch the issue "Factory status".

Regenerating a routine's token invalidates the old one, so the trial repository stops being able to fire. That is the intended way to retire it while keeping its history.

## Security: what GitHub Pro fixes and what it does not

Verified problem on GitHub Free: a workflow file pushed to any branch can read repository secrets, and `main` has no protection.

### GitHub Pro configuration, per product repository

1. **Ruleset on `main`**: require a pull request; require the status check `ci`; block force pushes; block deletion. Add yourself (repository admin) as a bypass actor so you can still push `GOALS.md` directly.
2. **Environment `factory`**: deployment branches limited to `main`. Move every `FACTORY_FIRE_TOKEN*` secret into it and delete the repository-level copies. Add `environment: factory` to the `dispatch` job in `factory.yml`.
3. **Actions settings**: default workflow permissions read-only; "Allow GitHub Actions to create and approve pull requests" off.
4. Repeat the dummy-secret probe from Phase 1 on the new repository and confirm a branch workflow can no longer read the secret. Do not trust the settings until that probe fails.

### What the upgrade does not fix

- **A branch workflow can still ask for a write token.** A workflow file on a branch may request `contents: write`, and that token could merge a pull request whose `ci` it also controls. The ruleset cannot tell that token apart from the dispatcher's. The real fix is at the source: confirm that a session cannot push workflow files at all. This is unverified and is the most important check on Wednesday.
- **The review verdict can be forged**, because worker and reviewer act as the same GitHub user. The dispatcher's own checks remain the boundary, and they do not judge whether code is correct.
- **The guard hook is advisory.** It lives in the repository and a determined session could work around it.
- **The fire token** can only start sessions of its routine. A leak costs allowance, not code or data.

### Credential isolation for a real product

- No product credential in GitHub at all: no database URL, payment key or deploy token as a repository secret. Sessions and CI should never need them.
- Keep runtime secrets in the hosting provider only.
- No secrets and no connectors in the Claude cloud environment.
- CI keeps `contents: read`. Only the dispatcher has `contents: write`.

## Deployment (decide Wednesday, not built)

Simplest route to a preview URL: connect the product repository to a host through its GitHub integration, so the host builds every branch and `main` itself. Vercel fits if the product is a Next.js app, which is what the planner scaffolds by default; the free tier is for non-commercial use.

Why this route: no deploy credential enters GitHub, the factory code needs no change, and every PR gets its own preview URL. Open points: the factory does not yet read the preview URL or test against it, host configuration files are protected paths and need you to merge them, and you ruled out production deployment in Phase 1, so decide whether `main` may deploy.

## Remaining blockers before a real product

1. No standalone template repository.
2. GitHub Pro not active; protections above not applied or probed.
3. Whether sessions can push workflow files is unknown.
4. No Opus routine; Opus availability and cost on Pro unknown.
5. Cost per task unmeasured.
6. Product not chosen.
7. Deployment approach not decided.

## Wednesday checklist, in order

Steps marked (you) need your account; the rest I do.

1. (you) Report current usage percentages. Confirm the routine is still paused.
2. (you) Choose the product. Short design discussion, then a first `GOALS.md` of three to five goals.
3. (you) Upgrade to GitHub Pro. Approve the creation of two repositories and one routine.
4. Create the private template repository `Ritik1221/saas-factory-template` from the factory files only, marked as a template. Add a `new-product` script that performs steps 1, 2 and 5 of the product setup. Local tests only.
5. Create the product repository from the template. Apply the ruleset, the `factory` environment and the Actions settings.
6. Run the dummy-secret probe. Expect the branch workflow to fail to read the secret. Stop if it can.
7. (you) Create the Opus routine with the same prompt as `factory-probe`; point both routines at the product repository; generate tokens and store them with `gh secret set`. Keep both paused.
8. Verify the routines before any product work: fire each once with a payload that matches no role. Each should answer "no role" without using tools. This confirms model, trigger and repository for the cost of two near-empty sessions. Stop if Opus is not available.
9. Check whether a session can push a workflow file: one Sonnet session on the product repository, before any secret that matters exists. Record the result in `SETUP.md`.
10. Decide deployment and, if chosen, connect the host to the repository. No credentials in GitHub.
11. (you) Give an explicit GO with a session limit. Enable the routines, push `GOALS.md`.
12. Watch the first task end to end. Stop at the first unexpected behaviour and diagnose before any refire. Record usage after the first merged task to get the cost per task.
13. Continue task by task within the limit. Pause the routines at the end of the day and write the results.

## Rules that stay in force

- Existing subscription allowance only. No paid usage credits, no plan change without your say.
- One active worker, strict retry limits, no extra agents.
- No production deployment without your decision.
- The fire tokens never pass through a chat.
- `factory-trial-1` and its results are preserved as they are.

## Small known issues, deferred

- The status table shows no PR number for finished tasks.
- The PR subscription wakes a finished worker session three times, a few seconds each.
- No CI run on `main` after an automatic merge; the merged tree is proven equal to the tested tree instead.
- The trial repository's dispatcher still runs hourly on GitHub Actions (about 24 short runs a day against the free minutes). It starts nothing while the routine is paused. Disable the `factory` workflow there if you want it silent.
