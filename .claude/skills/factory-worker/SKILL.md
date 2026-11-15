---
name: factory-worker
description: Use when the routine payload contains ROLE=worker. Implements one factory issue as one pull request.
---

# Factory worker

You implement exactly one issue, named by `ISSUE=<n> ATTEMPT=<k>` in the payload, as one pull request.

## The assignment check

The issue body ends with a marker like `<!-- factory-meta {"id":"G1-T2","attempt":2,...} -->`. You hold the assignment only while both are true:

- the issue is open and has the label `in-progress`
- the marker's `attempt` equals your `ATTEMPT`

Run this check at the start, before every `git push`, and before opening the pull request. If it fails, the task was reassigned or finished without you: stop immediately. Do not push, comment, or open anything.

## Steps

1. Read the issue with `gh api repos/{owner}/{repo}/issues/<n>` and run the assignment check. The title starts with the task id, for example `[G1-T2]`. Read `GOALS.md` for the goal it cites and every file in `docs/decisions/`.
2. Run `git fetch origin`. Your branch is `factory/<task id>-a<k>`, and only that branch.
   - If it already exists on origin, check it out and continue.
   - Otherwise, if `k` is greater than 1 and `origin/factory/<task id>-a<k-1>` exists, create your branch from it so earlier work is kept.
   - Otherwise create it from `origin/main`.
3. Write a failing test for each acceptance criterion, then the code that makes it pass.
4. Commit and push to your branch after each passing step. Unpushed work is lost if the session ends.
5. Before opening the pull request, run every script that exists: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`. Fix failures.
6. If no pull request exists for your branch, open one with `gh api repos/{owner}/{repo}/pulls` (title = the issue title, base `main`, body = what changed, how each acceptance criterion is tested, and `Closes #<n>`).
7. Stop. If you are later woken because a check failed on this pull request, run the assignment check, then fix it on the same branch and push.

## Rules

- Never edit `GOALS.md`, `.github/**` or `.claude/**`. If the task cannot be done without that, comment on the issue explaining why and stop.
- Never push to `main` or to any branch but your own, never force push, never merge, never change labels, never open or close issues.
- Use `gh api` REST calls only. `gh pr` and `gh issue` do not work here.
- Do only what the issue asks. Put other ideas in a comment on the issue.
- When you make a decision later tasks must follow (data model, library, folder layout), record it in a new file `docs/decisions/<issue number>-<slug>.md`: the decision, the reason, the alternatives rejected.
- Never commit secrets. Read configuration from environment variables and list new ones in `.env.example`.
- If you are blocked, comment on the issue with the exact error and stop. Do not guess.
