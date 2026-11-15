# Phase 1 smoke test results

Date: 2026-11-15. Repository: `Ritik1221/factory-trial-1` (private, disposable). Routine: `factory-probe`, Sonnet 5.5 for every role. The routine is paused again.

## Result

Passed. One edit to `GOALS.md` (goal G2, a `/version` endpoint) was planned, built, reviewed and merged to `main` with no human action on the pull request. One defect was found and fixed on the way (see Failures).

| Measure | Value |
|---|---|
| Cloud sessions used | 3 of 5 allowed (planner, worker, reviewer) |
| Session run time | planner 34 s, worker 24 s plus three short wake-ups, reviewer about 25 s |
| Time from worker start to merge | 1 min 35 s (13:44:36 to 13:46:11 UTC) |
| Time from pushing G2 to merge | 6 min 21 s, of which about 4 min was the pause to fix the hook |
| Task tries | 1 of 3 |
| Reviews | 1 of 2 |
| Duplicate issues or pull requests | none |
| Human actions on the PR | none |
| Usage before | session 23 %, weekly 64 % (after: owner to read off) |

## What ran

1. 13:39:50 push of `GOALS.md` (`d25d602`). Dispatcher fired the planner (HTTP 200).
2. 13:40:02 planner session. Pushed `factory/plan.json` with G1-T1 kept and G2-T1 added. It did not post its status comment (see Failures).
3. 13:44:04 push of the hook fix. CI green on `main`; the dispatcher read the plan, created issue #6 once, set it `ready`, fired the worker.
4. 13:44:36 worker session. Branch `factory/G2-T1-a1`, PR #7, 22 lines added in `package.json`, `src/server.mjs`, `src/server.test.mjs`.
5. 13:45:04 CI on PR #7: success, reported by GitHub Actions.
6. 13:45:32 reviewer session, fired for commit `f5cb21f`. Posted one comment at 13:45:53 with verdict `approve` for that commit.
7. 13:46:11 dispatcher merged PR #7 as `app/github-actions` (squash, `b1b7410`), closed #6, status "Complete".

## CI outcomes

| Run | Result |
|---|---|
| `ci` on `main` after the G2 push | success |
| `ci` on `main` after the hook fix | success |
| `ci` on PR #7 (`f5cb21f`) | success |
| `ci` on `main` after the merge | did not run (see Limitations) |

## Merge result

- Merged by the dispatcher's workflow token, not by a session and not by the owner.
- The tree on `main` after the merge is identical to the tree CI tested on the PR (`1d8e1e6`).
- Checked by hand afterwards from a fresh pull: `npm test` 2/2 pass; `GET /version` returns 200 `{"version":"1.0.0"}`; `GET /health` 200; unknown path 404.

## Failures

1. **Guard hook blocked the planner (fixed).** The hook treated any `>` earlier in a command line (`2>&1`, the `=>` in the plan validator) as a write to a protected path named later, so the planner could not read `GOALS.md` from the shell or run the validator. It pushed a correct plan anyway, prompted by the platform's "uncommitted changes" stop hook, but skipped its status comment, so nothing woke the dispatcher. I paused the routine, reproduced the three blocked commands as failing tests, narrowed the pattern (34/34 hook tests, now also run in CI), and resumed. The planner was not refired, because the dispatcher validates the plan itself and accepted it.
2. No other failure. The earlier local rehearsal found and fixed two dispatcher bugs (duplicate task issue; superseded duplicate closing the live PR); neither recurred.

## Remaining limitations

- **GitHub Free security.** `main` is unprotected and a workflow file pushed to any branch can read the fire token. Accepted for disposable code only. GitHub Pro (ruleset on `main`, token in an environment limited to `main`) is required before the real product.
- **The review verdict can be forged** by a worker, since both roles share one GitHub identity. The dispatcher's own checks are the boundary; they do not judge whether the code meets the acceptance criteria.
- **No CI run on `main` after an automatic merge**, because merges by the workflow token do not trigger workflows. The merged tree is proven equal to the tested tree instead.
- **Planner output was pushed unvalidated by the session** in this run. The dispatcher's validation caught nothing because the plan was valid, but the path "planner pushes, then comments" was not exercised end to end.
- **Not exercised live:** review rejection and retry, red CI fixed by the worker, branch behind `main`, conflict, lease expiry, `needs-human`, a multi-task plan with dependencies, the hourly sweep. All are covered by the 38 unit tests; red CI and wrong-commit approval were also covered in the local rehearsal.
- **PR subscription wakes the worker** three times after it finishes (subscribe, CI done, merged). Each wake-up took 3 to 5 seconds; it is a small recurring cost per task.
- **The status table shows no PR number** for finished tasks.
- **One model for all roles.** Routing planner or hard tasks to Opus needs a second routine, which was not created.
- Usage cost per task on Pro is not yet measured; it needs the owner's before and after percentages.

## State left behind

Routine paused. Fire token still stored in the trial repository. Open in the trial repository: only the status issue #1. Branches `factory/plan`, `factory/G1-T1-a1` and `factory/G2-T1-a1` remain. Task 5 not started; no product repository created.
