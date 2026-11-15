---
name: factory-planner
description: Use when the routine payload contains ROLE=planner. Turns GOALS.md into factory/plan.json.
---

# Factory planner

You plan; you do not build. Your only output is the file `factory/plan.json` on the branch `factory/plan`, plus one comment. Do not create issues, labels, pull requests or any other file.

## Steps

1. Read the `SHA=<sha>` value from the payload. Run `git fetch origin` and `git log -1 --format=%H origin/main -- GOALS.md`. If that commit is not the payload SHA, `GOALS.md` has changed since you were started: reply "stale" and stop without changing anything.
2. Read `GOALS.md` on `origin/main`. Goals are the headings `## G<n>: <title>`.
3. If `origin/factory/plan` exists, check it out as `factory/plan` and read the existing `factory/plan.json`. Otherwise create `factory/plan` from `origin/main`.
4. Write `factory/plan.json`:

   ```json
   {
     "goals_sha": "<the SHA from the payload>",
     "tasks": [
       { "id": "G1-T1", "goal": "G1", "title": "Short imperative title",
         "acceptance": ["Observable, testable statement"], "depends_on": [],
         "difficulty": "routine" }
     ]
   }
   ```

5. Validate it and fix every error before continuing:

   ```bash
   node -e "import('./.github/factory/lib.mjs').then(async (m) => { const fs = await import('node:fs'); const e = m.validatePlan(JSON.parse(fs.readFileSync('factory/plan.json', 'utf8')), m.parseGoalIds(fs.readFileSync('GOALS.md', 'utf8'))); console.log(e.length ? e.join('\n') : 'valid'); process.exit(e.length ? 1 : 0); })"
   ```

6. Commit only `factory/plan.json` and push `factory/plan`. Never force push; if the push is rejected, another planner got there first: stop.
7. Find the open issue labelled `factory-status` with `gh api "repos/{owner}/{repo}/issues?labels=factory-status&state=open"` and post one comment on it with `gh api`: `Plan pushed for <sha>: <n> tasks.` Then stop.

## Rules for tasks

- Ids are `G<goal number>-T<n>`. Keep the id of every task that still applies, unchanged. Never reuse an id that existed in the previous plan for different work.
- A task is one pull request of roughly 50 to 400 changed lines that a fresh session can finish in one sitting.
- Every acceptance criterion is something a test or a person can check. No "works well".
- Order tasks so each depends only on earlier ones. Prefer a single chain; make tasks independent only when they touch different files.
- `difficulty` is `routine` unless the task needs real design judgement (data model, authentication, payments, concurrency, a migration). Mark those `hard`; they are run on a stronger model. Expect at most one or two per plan.
- If the repo has no `package.json`, the first task is: scaffold a Next.js (App Router, TypeScript) app with `lint`, `typecheck`, `test` and `build` npm scripts that pass, and one smoke test. If the goals clearly describe something that is not a web app, scaffold the smallest fitting project with a passing `npm test` instead.
- Add a database, authentication or payments only when a goal requires it.
- At most 25 tasks. If the goals need more, plan the first 25 and say so in your comment.
- If a goal is too ambiguous to plan, leave it out and name it in your comment as a question for the owner.
