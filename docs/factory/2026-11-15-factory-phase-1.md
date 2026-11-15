# SaaS Factory Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A template repository in which pushing `GOALS.md` produces GitHub issues, one worker session at a time turns each issue into a CI-checked pull request, and the owner only merges.

**Architecture:** One deterministic GitHub Actions workflow (the dispatcher) recomputes all state from GitHub on every run and is the only thing that creates issues, changes labels or starts cloud sessions. One cloud routine runs in two roles, planner and worker, chosen by a `ROLE=` payload; role instructions are skills in the repo. The planner only writes `factory/plan.json`; a script validates it and syncs issues by task id.

**Tech Stack:** Node 22 (built-in `fetch`, `node:test`, no dependencies), GitHub Actions, GitHub REST API, Claude Code cloud routine with API trigger, bash + `jq` for the hook.

**Spec:** `docs/superpowers/specs/2026-11-15-saas-factory-design.md` (sections 2a and 3a)

## Global Constraints

- One worker. A session is fired only when no issue is `in-progress`; at most one fire per dispatcher run.
- All dispatcher runs share the Actions concurrency group `factory`.
- The dispatcher is level-triggered: it never reads the triggering event.
- One issue per task id, enforced by the hidden marker `<!-- factory-meta {...} -->`.
- Task ids match `G<n>-T<n>`; at most 25 tasks per plan; dependencies must appear earlier in the list.
- Limits: 3 attempts per task, 90-minute lease, planner at most 3 fires per `GOALS.md` commit and 60 minutes apart, at most 2 PRs awaiting merge.
- Fire payload is exactly `ROLE=planner SHA=<sha>` or `ROLE=worker ISSUE=<n>`.
- Protected paths for agents: `GOALS.md`, `.github/**`, `.claude/**`.
- Sessions use `gh api` REST only. They never change labels, never merge, never push to `main`.
- No workflow that holds `FACTORY_FIRE_TOKEN` runs code from a non-`main` branch.
- No usage credits, no production deploys, humans merge every PR.
- Tasks 1 to 3 are local files only. Tasks 4 and 5 create a repository and start cloud sessions and **must not begin until the owner approves this plan**. No new scheduled task is created: the existing paused routine `factory-probe` (`trig_01GdRbPgsojhNjA5TjaNbDad`) is repointed.

## Amendments (2026-11-15, owner approval of Tasks 1 to 4)

The code in `factory-template/` is authoritative where it differs from the code blocks below.

- **Model routing.** `/fire` accepts only `text`; the model belongs to the routine. The dispatcher picks a route per fire (`planner`, `worker`, `escalation`) and reads `FACTORY_ROUTINE_ID_<ROUTE>` / `FACTORY_FIRE_TOKEN_<ROUTE>`, falling back to the base pair. Tasks the planner marks `"difficulty": "hard"` and the last attempt of any task use `escalation`.
- **Stale workers.** Each attempt has its own branch `factory/<id>-a<attempt>`. The worker payload is `ROLE=worker ISSUE=<n> ATTEMPT=<k>`; the worker checks the issue marker before every push. The dispatcher only reads the current attempt's branch and PR, and closes open PRs from other attempts.
- **Leases.** Activity is read from the attempt branch, not the PR. A lease also ends 4 hours after it started, whatever the activity.
- **Fire results.** `refused` rolls the lease back; no answer keeps the lease so a possibly started session is never doubled.
- **Hook.** Also blocks merge calls. Its tests live in `.claude/hooks/guard.test.sh`.

## Amendment 2 (2026-11-15, owner: automatic merge)

Supersedes every step that has the owner merge a PR, the `awaiting-merge` state and `maxAwaitingMerge`. Design: spec section 3a, "Automatic merge". Implemented in `lib.mjs` (`in-review` state, `pickReview`, `weakened`, wider `PROTECTED`, `merge` and reviewer `fire` actions, duplicate repair), `run.mjs` (fresh PR details per commit, reviewer fire, merge call, created-issue registry), `factory.yml` (`contents: write`, reviewer route), `ci.yml` (`contents: read`, secret scan, `npm audit`), `.claude/skills/factory-reviewer/SKILL.md`, worker skill and `SETUP.md`. Task 4 smoke test: Sonnet for every role, at most five cloud sessions, expected three (planner, worker, reviewer).

## Review Focus

1. `GOALS.md` has no `## G<n>:` headings (fresh template, or the owner wrote free text): nothing is fired and the status issue says why. Test in Task 1.
2. `factory/plan.json` is not valid JSON or has no task array: nothing is created, the status issue shows "Plan rejected". Test in Task 1.
3. The same event arrives twice, or the hourly run overlaps an event run: no second issue and no second session. Tests in Task 1 (existing id is never recreated; `in-progress` blocks every fire).
4. The fire call fails (usage limit, expired token): the task returns to `ready` with no attempt spent. Checked live in Task 4 Step 4.
5. The owner closes a PR without merging, or merges while the issue stays open: the task returns to `ready`, or the issue is closed. Tests in Task 1.

## File Structure

All paths are inside a new local directory `/Users/ritik/Expo/auto-code/factory-template/`.

| File | Responsibility |
|---|---|
| `.github/factory/lib.mjs` | Pure logic: plan validation, issue rendering, marker parsing, `decide(state) → actions`. No I/O. |
| `.github/factory/lib.test.mjs` | Unit tests for `lib.mjs`. |
| `.github/factory/run.mjs` | GitHub and Anthropic I/O: load state, apply actions, write the status issue. |
| `.github/workflows/factory.yml` | Dispatcher triggers and concurrency. |
| `.github/workflows/ci.yml` | The `ci` check: factory unit tests plus the product's lint, typecheck, test, build. |
| `.claude/settings.json`, `.claude/hooks/guard.sh` | Block agent edits to protected paths and pushes to `main`. |
| `.claude/skills/factory-planner/SKILL.md` | Planner role instructions. |
| `.claude/skills/factory-worker/SKILL.md` | Worker role instructions. |
| `GOALS.md` | Owner's file, with the required heading format explained. |
| `.gitignore`, `docs/decisions/.gitkeep`, `SETUP.md` | Scratch-file ignore, decision records folder, one-time setup steps and the routine prompt. |

---

### Task 1: Dispatcher logic

**Files:**
- Create: `.github/factory/lib.mjs`
- Test: `.github/factory/lib.test.mjs`

**Interfaces:**
- Produces: `LIMITS`, `STATES`, `parseGoalIds(md) → string[]`, `touchesProtected(files) → boolean`, `stateOf(issue) → string|null`, `taskHash(task) → string`, `validatePlan(plan, goalIds) → string[]`, `parseMeta(body) → object|null`, `withMeta(text, meta) → string`, `renderIssue(task, meta) → {title, body}`, `ciState(checkRuns) → 'green'|'red'|'pending'`, `decide(state) → action[]`.
- State shape: `{ now, goalsSha, goalIds, plan, issues: [{ number, open, labels, meta: {id, hash, attempt, leaseAt}, pr: null | { number, state: 'open'|'closed'|'merged', ci, lastCommitAt, protectedFiles } }], status: { plannerFiredSha, plannerFiredAt, plannerFires }, mainCi }`.
- Action shapes: `{type:'create', task}`, `{type:'update', number, task}`, `{type:'supersede', number}`, `{type:'close', number}`, `{type:'state', number, to, reason?}`, `{type:'fire', role:'planner', sha, fires}`, `{type:'fire', role:'worker', number, attempt}`, `{type:'note', text}`.

- [ ] **Step 1: Create the directory and write the failing tests**

```bash
mkdir -p /Users/ritik/Expo/auto-code/factory-template/.github/factory
cd /Users/ritik/Expo/auto-code/factory-template && git init -b main
```

`.github/factory/lib.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decide, validatePlan, taskHash, parseGoalIds, parseMeta, withMeta,
  renderIssue, touchesProtected, ciState, LIMITS,
} from './lib.mjs';

const T1 = { id: 'G1-T1', goal: 'G1', title: 'Scaffold', acceptance: ['npm test passes'], depends_on: [] };
const T2 = { id: 'G1-T2', goal: 'G1', title: 'List page', acceptance: ['shows items'], depends_on: ['G1-T1'] };
const NOW = 1_000_000_000_000;
const issue = (task, number, label, extra = {}) => ({
  number, open: true, labels: ['factory-task', label],
  meta: { id: task.id, hash: taskHash(task), attempt: 0 }, pr: null, ...extra,
});
const state = (over = {}) => ({
  now: NOW, goalsSha: 'abc', goalIds: ['G1'],
  plan: { goals_sha: 'abc', tasks: [T1, T2] }, issues: [],
  status: { plannerFiredSha: null, plannerFiredAt: 0, plannerFires: 0 },
  mainCi: 'green', ...over,
});
const pr = (over = {}) => ({ number: 9, state: 'open', ci: 'pending', lastCommitAt: NOW, protectedFiles: false, ...over });

test('validatePlan accepts a valid plan', () => {
  assert.deepEqual(validatePlan({ goals_sha: 'abc', tasks: [T1, T2] }, ['G1']), []);
});

test('validatePlan rejects malformed plans', () => {
  const bad = (tasks) => validatePlan({ goals_sha: 'abc', tasks }, ['G1']).length > 0;
  assert.ok(bad(null));
  assert.ok(bad([T1, T1]));
  assert.ok(bad([{ ...T1, id: 'task-1' }]));
  assert.ok(bad([{ ...T1, id: 'G2-T1', goal: 'G2' }]));
  assert.ok(bad([{ ...T1, goal: 'G1', id: 'G3-T1' }]));
  assert.ok(bad([{ ...T1, acceptance: [] }]));
  assert.ok(bad([{ ...T1, acceptance: ['  '] }]));
  assert.ok(bad([{ ...T1, title: '' }]));
  assert.ok(bad([T2, T1]));
  assert.ok(bad([{ ...T1, depends_on: ['G1-T9'] }]));
  assert.ok(bad(Array.from({ length: LIMITS.maxTasks + 1 }, (_, n) => ({ ...T1, id: `G1-T${n + 1}` }))));
});

test('helpers', () => {
  assert.deepEqual(parseGoalIds('# P\n## G1: A\ntext\n## G2: B\n## Notes\n'), ['G1', 'G2']);
  assert.ok(touchesProtected(['src/a.ts', '.github/workflows/ci.yml']));
  assert.ok(touchesProtected(['GOALS.md']));
  assert.ok(!touchesProtected(['docs/GOALS.md', 'src/a.ts']));
  const body = withMeta('hello', { id: 'G1-T1', attempt: 2 });
  assert.deepEqual(parseMeta(body), { id: 'G1-T1', attempt: 2 });
  assert.deepEqual(parseMeta(withMeta(body, { id: 'G1-T1', attempt: 3 })), { id: 'G1-T1', attempt: 3 });
  assert.equal(parseMeta('no marker'), null);
  assert.equal(renderIssue(T1, { id: 'G1-T1' }).title, '[G1-T1] Scaffold');
  const run = (over) => ({ name: 'ci', status: 'completed', conclusion: 'success', started_at: '2026-01-01T00:00:00Z', ...over });
  assert.equal(ciState([]), 'pending');
  assert.equal(ciState([run({ name: 'vercel', conclusion: 'failure' })]), 'pending');
  assert.equal(ciState([run()]), 'green');
  assert.equal(ciState([run(), run({ conclusion: 'failure', started_at: '2026-01-02T00:00:00Z' })]), 'red');
  assert.equal(ciState([run(), run({ status: 'in_progress', started_at: '2026-01-02T00:00:00Z' })]), 'pending');
});

test('no goal headings: nothing fired, note explains', () => {
  const a = decide(state({ goalIds: [], plan: null }));
  assert.equal(a.length, 1);
  assert.equal(a[0].type, 'note');
});

test('stale plan fires the planner once', () => {
  assert.deepEqual(decide(state({ plan: null })), [{ type: 'fire', role: 'planner', sha: 'abc', fires: 1 }]);
  assert.deepEqual(decide(state({ plan: { goals_sha: 'old', tasks: [T1] } })), [{ type: 'fire', role: 'planner', sha: 'abc', fires: 1 }]);
});

test('planner is not refired inside the retry window, and stops after the cap', () => {
  const fired = (ago, fires) => ({ plannerFiredSha: 'abc', plannerFiredAt: NOW - ago, plannerFires: fires });
  assert.deepEqual(decide(state({ plan: null, status: fired(10 * 60000, 1) })), []);
  assert.deepEqual(decide(state({ plan: null, status: fired(61 * 60000, 1) })), [{ type: 'fire', role: 'planner', sha: 'abc', fires: 2 }]);
  assert.equal(decide(state({ plan: null, status: fired(61 * 60000, 3) }))[0].type, 'note');
});

test('planner waits while a worker is in progress', () => {
  const s = state({ plan: { goals_sha: 'old', tasks: [T1] }, issues: [issue(T1, 2, 'in-progress', { meta: { id: 'G1-T1', hash: 'x', attempt: 1, leaseAt: NOW } })] });
  assert.deepEqual(decide(s), []);
});

test('unparseable or invalid plan creates nothing', () => {
  const a = decide(state({ plan: { goals_sha: 'abc', tasks: null } }));
  assert.equal(a.length, 1);
  assert.match(a[0].text, /Plan rejected/);
});

test('sync creates each missing task once', () => {
  assert.deepEqual(decide(state()), [{ type: 'create', task: T1 }, { type: 'create', task: T2 }]);
  const a = decide(state({ issues: [issue(T1, 2, 'planned'), issue(T2, 3, 'planned')] }));
  assert.ok(!a.some((x) => x.type === 'create'));
  const closed = decide(state({ issues: [issue(T1, 2, 'planned', { open: false }), issue(T2, 3, 'planned')] }));
  assert.ok(!closed.some((x) => x.type === 'create'));
});

test('changed task updates only before work starts; removed task is superseded', () => {
  const changed = { ...T1, title: 'Scaffold app' };
  const plan = { goals_sha: 'abc', tasks: [changed] };
  assert.deepEqual(decide(state({ plan, issues: [issue(T1, 2, 'ready')] })), [{ type: 'update', number: 2, task: changed }]);
  const busy = issue(T1, 2, 'in-progress', { meta: { id: 'G1-T1', hash: taskHash(T1), attempt: 1, leaseAt: NOW } });
  assert.deepEqual(decide(state({ plan, issues: [busy] })), []);
  assert.deepEqual(
    decide(state({ plan: { goals_sha: 'abc', tasks: [T1] }, issues: [issue(T1, 2, 'ready'), issue(T2, 3, 'planned')] })),
    [{ type: 'supersede', number: 3 }],
  );
});

test('planned becomes ready only when dependencies are closed and not superseded', () => {
  const both = [issue(T1, 2, 'planned'), issue(T2, 3, 'planned')];
  assert.deepEqual(decide(state({ issues: both })), [{ type: 'state', number: 2, to: 'ready', reason: undefined }]);
  const done = [issue(T1, 2, 'awaiting-merge', { open: false }), issue(T2, 3, 'planned')];
  assert.deepEqual(decide(state({ issues: done })), [{ type: 'state', number: 3, to: 'ready', reason: undefined }]);
  const superseded = [issue(T1, 2, 'superseded', { open: false }), issue(T2, 3, 'planned')];
  assert.deepEqual(decide(state({ issues: superseded })), []);
});

test('fires one worker when nothing is in progress, none when something is', () => {
  const ready = [issue(T1, 2, 'ready'), issue(T2, 3, 'planned')];
  assert.deepEqual(decide(state({ issues: ready })), [{ type: 'fire', role: 'worker', number: 2, attempt: 1 }]);
  const lease = { meta: { id: 'G1-T1', hash: taskHash(T1), attempt: 1, leaseAt: NOW - 60000 } };
  assert.deepEqual(decide(state({ issues: [issue(T1, 2, 'in-progress', lease), issue(T2, 3, 'planned')] })), []);
  const T3 = { ...T1, id: 'G1-T3' };
  const plan = { goals_sha: 'abc', tasks: [T1, T3] };
  assert.deepEqual(decide(state({ plan, issues: [issue(T1, 2, 'in-progress', lease), issue(T3, 4, 'ready')] })), []);
});

test('in-progress transitions', () => {
  const lease = (ago, attempt = 1) => ({ meta: { id: 'G1-T1', hash: taskHash(T1), attempt, leaseAt: NOW - ago } });
  const one = (extra) => decide(state({ plan: { goals_sha: 'abc', tasks: [T1] }, issues: [issue(T1, 2, 'in-progress', extra)] }));
  assert.deepEqual(one({ ...lease(1000), pr: pr({ ci: 'green' }) }), [{ type: 'state', number: 2, to: 'awaiting-merge', reason: undefined }]);
  assert.equal(one({ ...lease(1000), pr: pr({ ci: 'green', protectedFiles: true }) })[0].to, 'needs-human');
  assert.deepEqual(one({ ...lease(1000), pr: pr({ ci: 'red' }) }), []);
  assert.equal(one(lease(LIMITS.leaseMs + 1))[0].to, 'ready');
  assert.deepEqual(one({ ...lease(LIMITS.leaseMs + 1), pr: pr({ lastCommitAt: NOW - 1000 }) }), []);
});

test('a ready task with attempts exhausted needs a human', () => {
  const spent = issue(T1, 2, 'ready', { meta: { id: 'G1-T1', hash: taskHash(T1), attempt: LIMITS.maxAttempts } });
  const a = decide(state({ plan: { goals_sha: 'abc', tasks: [T1] }, issues: [spent] }));
  assert.equal(a[0].to, 'needs-human');
});

test('awaiting-merge: closed PR returns to ready, merged PR closes the issue', () => {
  const one = (p) => decide(state({ plan: { goals_sha: 'abc', tasks: [T1] }, issues: [issue(T1, 2, 'awaiting-merge', { pr: p })] }));
  assert.equal(one(pr({ state: 'closed' }))[0].to, 'ready');
  assert.equal(one(pr({ ci: 'red' }))[0].to, 'ready');
  assert.deepEqual(one(pr({ state: 'merged' })), [{ type: 'close', number: 2 }]);
  assert.deepEqual(one(pr({ ci: 'green' })), []);
});

test('no new worker when main is red or two PRs await merge', () => {
  const ready = [issue(T1, 2, 'ready')];
  const plan = { goals_sha: 'abc', tasks: [T1] };
  assert.equal(decide(state({ plan, issues: ready, mainCi: 'red' }))[0].type, 'note');
  const ts = [1, 2, 3].map((n) => ({ ...T1, id: `G1-T${n}` }));
  const waiting = (t, n) => issue(t, n, 'awaiting-merge', { pr: pr({ ci: 'green' }) });
  const s = state({ plan: { goals_sha: 'abc', tasks: ts }, issues: [waiting(ts[0], 2), waiting(ts[1], 3), issue(ts[2], 4, 'ready')] });
  assert.deepEqual(decide(s), []);
});

test('all tasks closed reports Complete', () => {
  const issues = [issue(T1, 2, 'awaiting-merge', { open: false }), issue(T2, 3, 'awaiting-merge', { open: false })];
  assert.deepEqual(decide(state({ issues })), [{ type: 'note', text: 'Complete' }]);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test .github/factory/lib.test.mjs`
Expected: FAIL with `Cannot find module ... lib.mjs`.

- [ ] **Step 3: Write `lib.mjs`**

```js
import { createHash } from 'node:crypto';

export const LIMITS = {
  maxTasks: 25, maxAttempts: 3, leaseMs: 90 * 60000,
  plannerRetryMs: 60 * 60000, maxPlannerFires: 3, maxAwaitingMerge: 2,
};
export const STATES = ['planned', 'ready', 'in-progress', 'awaiting-merge', 'needs-human'];
const PROTECTED = [/^GOALS\.md$/, /^\.github\//, /^\.claude\//];
const ID = /^G\d+-T\d+$/;
const MARK = /<!-- factory-meta (.*?) -->/s;

export const parseGoalIds = (md) => [...md.matchAll(/^## (G\d+):/gm)].map((m) => m[1]);
export const touchesProtected = (files) => files.some((f) => PROTECTED.some((re) => re.test(f)));
export const stateOf = (issue) => STATES.find((s) => issue.labels.includes(s)) ?? null;
export const taskHash = (t) =>
  createHash('sha1').update(JSON.stringify([t.goal, t.title, t.acceptance, t.depends_on])).digest('hex').slice(0, 12);

export function parseMeta(body) {
  const m = MARK.exec(body ?? '');
  try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
}
export const withMeta = (text, meta) =>
  `${(text ?? '').replace(MARK, '').trimEnd()}\n\n<!-- factory-meta ${JSON.stringify(meta)} -->`;

export function renderIssue(t, meta) {
  const body = [
    `Goal: ${t.goal} (see GOALS.md)`, '',
    '## Acceptance criteria', ...t.acceptance.map((c) => `- [ ] ${c}`), '',
    `Depends on: ${t.depends_on.join(', ') || 'none'}`,
    `Branch: \`factory/${t.id}\``,
  ].join('\n');
  return { title: `[${t.id}] ${t.title}`, body: withMeta(body, meta) };
}

export function ciState(checkRuns) {
  const runs = checkRuns.filter((c) => c.name === 'ci')
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  if (!runs.length || runs[0].status !== 'completed') return 'pending';
  return runs[0].conclusion === 'success' ? 'green' : 'red';
}

export function validatePlan(plan, goalIds) {
  if (!plan || typeof plan.goals_sha !== 'string' || !Array.isArray(plan.tasks)) {
    return ['plan must have goals_sha (string) and tasks (array)'];
  }
  const errors = [];
  if (plan.tasks.length > LIMITS.maxTasks) errors.push(`more than ${LIMITS.maxTasks} tasks`);
  const seen = new Set();
  for (const t of plan.tasks) {
    const id = String(t?.id);
    if (!ID.test(id)) { errors.push(`bad id: ${id}`); continue; }
    if (seen.has(id)) errors.push(`duplicate id: ${id}`);
    seen.add(id);
    if (!goalIds.includes(t.goal) || !id.startsWith(`${t.goal}-`)) errors.push(`${id}: goal must be a GOALS.md heading and match the id prefix`);
    if (typeof t.title !== 'string' || !t.title.trim()) errors.push(`${id}: empty title`);
    if (!Array.isArray(t.acceptance) || !t.acceptance.length || t.acceptance.some((c) => typeof c !== 'string' || !c.trim())) {
      errors.push(`${id}: acceptance must be a non-empty list of non-empty strings`);
    }
    if (!Array.isArray(t.depends_on)) errors.push(`${id}: depends_on must be an array`);
  }
  if (errors.length) return errors;
  const index = new Map(plan.tasks.map((t, i) => [t.id, i]));
  plan.tasks.forEach((t, i) => {
    for (const d of t.depends_on) {
      if (!index.has(d)) errors.push(`${t.id}: unknown dependency ${d}`);
      else if (index.get(d) >= i) errors.push(`${t.id}: dependency ${d} must appear earlier in the list`);
    }
  });
  return errors;
}

// Returns the next batch of actions. The caller applies them, reloads state and
// calls again until the batch is empty or contains a fire or a note.
export function decide(s) {
  if (!s.goalIds.length) return [{ type: 'note', text: 'GOALS.md has no "## G<n>: title" headings. Nothing to plan.' }];
  const open = s.issues.filter((i) => i.open);
  const planCurrent = !!s.plan && s.plan.goals_sha === s.goalsSha;
  const early = ['planned', 'ready'];

  if (planCurrent) {
    const errors = validatePlan(s.plan, s.goalIds);
    if (errors.length) return [{ type: 'note', text: `Plan rejected: ${errors.join('; ')}` }];
    const sync = [];
    const byId = new Map(s.issues.map((i) => [i.meta.id, i]));
    for (const t of s.plan.tasks) {
      const i = byId.get(t.id);
      if (!i) sync.push({ type: 'create', task: t });
      else if (i.open && i.meta.hash !== taskHash(t) && early.includes(stateOf(i))) sync.push({ type: 'update', number: i.number, task: t });
    }
    const ids = new Set(s.plan.tasks.map((t) => t.id));
    for (const i of open) {
      if (!ids.has(i.meta.id) && early.includes(stateOf(i))) sync.push({ type: 'supersede', number: i.number });
    }
    if (sync.length) return sync;
  }

  const moves = [];
  const done = new Set(s.issues.filter((i) => !i.open && !i.labels.includes('superseded')).map((i) => i.meta.id));
  const taskById = new Map((planCurrent ? s.plan.tasks : []).map((t) => [t.id, t]));
  for (const i of open) {
    const st = stateOf(i);
    const pr = i.pr;
    const to = (state, reason) => moves.push({ type: 'state', number: i.number, to: state, reason });
    if (st === 'in-progress' || st === 'awaiting-merge') {
      if (pr?.state === 'merged') moves.push({ type: 'close', number: i.number });
      else if (pr?.protectedFiles) to('needs-human', 'PR touches protected paths');
      else if (st === 'in-progress' && pr?.state === 'open' && pr.ci === 'green') to('awaiting-merge');
      else if (st === 'awaiting-merge' && (pr?.state !== 'open' || pr.ci === 'red')) to('ready', 'PR closed or CI red');
      else if (st === 'in-progress' && s.now - Math.max(i.meta.leaseAt ?? 0, pr?.lastCommitAt ?? 0) > LIMITS.leaseMs) to('ready', 'lease expired');
    } else if (st === 'planned') {
      const t = taskById.get(i.meta.id);
      if (t && t.depends_on.every((d) => done.has(d))) to('ready');
    }
  }
  if (moves.length) return moves;

  if (open.some((i) => stateOf(i) === 'in-progress')) return [];
  if (!planCurrent) {
    const same = s.status.plannerFiredSha === s.goalsSha;
    const fires = same ? s.status.plannerFires : 0;
    if (same && s.now - s.status.plannerFiredAt < LIMITS.plannerRetryMs) return [];
    if (fires >= LIMITS.maxPlannerFires) return [{ type: 'note', text: `Planner produced no plan for ${s.goalsSha} after ${fires} runs. Needs human.` }];
    return [{ type: 'fire', role: 'planner', sha: s.goalsSha, fires: fires + 1 }];
  }
  if (s.mainCi === 'red') return [{ type: 'note', text: 'CI is red on main. No new work started.' }];
  if (open.filter((i) => stateOf(i) === 'awaiting-merge').length >= LIMITS.maxAwaitingMerge) return [];
  const next = s.plan.tasks.map((t) => open.find((i) => i.meta.id === t.id)).find((i) => i && stateOf(i) === 'ready');
  if (next) {
    return (next.meta.attempt ?? 0) >= LIMITS.maxAttempts
      ? [{ type: 'state', number: next.number, to: 'needs-human', reason: 'attempts exhausted' }]
      : [{ type: 'fire', role: 'worker', number: next.number, attempt: (next.meta.attempt ?? 0) + 1 }];
  }
  if (s.plan.tasks.every((t) => done.has(t.id))) return [{ type: 'note', text: 'Complete' }];
  return [];
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `node --test .github/factory/lib.test.mjs`
Expected: all tests pass, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add .github/factory && git commit -m "Add dispatcher decision logic"
```

---

### Task 2: Dispatcher runner and workflows

**Files:**
- Create: `.github/factory/run.mjs`
- Create: `.github/workflows/factory.yml`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: everything exported by `lib.mjs` (Task 1).
- Produces: the check run named `ci` that `ciState` reads; the fire payloads `ROLE=planner SHA=<sha>` and `ROLE=worker ISSUE=<n>`; the status issue labelled `factory-status`; repo secret `FACTORY_FIRE_TOKEN` and variable `FACTORY_ROUTINE_ID` as inputs.

`run.mjs` has no unit tests: it is thin I/O around `decide`, and is verified live in Task 4.

- [ ] **Step 1: Write `run.mjs`**

```js
import {
  decide, parseGoalIds, parseMeta, withMeta, renderIssue, taskHash,
  stateOf, touchesProtected, ciState, STATES,
} from './lib.mjs';

const { GITHUB_TOKEN, GITHUB_REPOSITORY: REPO, FACTORY_FIRE_TOKEN, FACTORY_ROUTINE_ID } = process.env;
const OWNER = REPO.split('/')[0];
const r = `/repos/${REPO}`;
const LABELS = [...STATES, 'superseded', 'factory-task', 'factory-status'];

async function gh(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 && method === 'GET') return null;
  if (res.status === 422 && path === `${r}/labels`) return null; // label already exists
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function all(path) {
  const out = [];
  for (let page = 1; ; page++) {
    const items = (await gh('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)) ?? [];
    out.push(...items);
    if (items.length < 100) return out;
  }
}

async function file(path, ref) {
  const f = await gh('GET', `${r}/contents/${path}?ref=${encodeURIComponent(ref)}`);
  return f ? Buffer.from(f.content, 'base64').toString() : null;
}

const ciOf = async (sha) => ciState((await gh('GET', `${r}/commits/${sha}/check-runs?per_page=100`))?.check_runs ?? []);

async function loadPr(id) {
  const prs = await gh('GET', `${r}/pulls?state=all&head=${OWNER}:factory/${id}&sort=created&direction=desc&per_page=1`);
  const p = prs?.[0];
  if (!p) return null;
  const head = await gh('GET', `${r}/commits/${p.head.sha}`);
  const files = (await all(`${r}/pulls/${p.number}/files`)).map((f) => f.filename);
  return {
    number: p.number,
    state: p.merged_at ? 'merged' : p.state,
    ci: await ciOf(p.head.sha),
    lastCommitAt: Date.parse(head.commit.committer.date),
    protectedFiles: touchesProtected(files),
  };
}

async function loadStatus() {
  let [s] = await gh('GET', `${r}/issues?state=open&labels=factory-status&per_page=1`);
  if (!s) s = await gh('POST', `${r}/issues`, { title: 'Factory status', body: withMeta('Starting.', {}), labels: ['factory-status'] });
  return { number: s.number, plannerFiredSha: null, plannerFiredAt: 0, plannerFires: 0, ...parseMeta(s.body) };
}

async function loadState() {
  const goalsSha = (await gh('GET', `${r}/commits?path=GOALS.md&sha=main&per_page=1`))?.[0]?.sha ?? null;
  let plan;
  try { plan = JSON.parse((await file('factory/plan.json', 'factory/plan')) ?? 'null'); } catch { plan = { goals_sha: goalsSha, tasks: null }; }
  const issues = [];
  for (const i of (await all(`${r}/issues?state=all&labels=factory-task`)).filter((x) => !x.pull_request)) {
    const meta = parseMeta(i.body);
    if (!meta?.id) continue;
    const issue = { number: i.number, open: i.state === 'open', labels: i.labels.map((l) => l.name), meta, body: i.body, pr: null };
    if (issue.open && ['in-progress', 'awaiting-merge'].includes(stateOf(issue))) issue.pr = await loadPr(meta.id);
    issues.push(issue);
  }
  const main = await gh('GET', `${r}/commits/main`);
  return {
    now: Date.now(), goalsSha, plan, issues,
    goalIds: parseGoalIds((await file('GOALS.md', 'main')) ?? ''),
    status: await loadStatus(),
    mainCi: await ciOf(main.sha),
  };
}

async function setState(issue, to, metaPatch = {}) {
  const labels = issue.labels.filter((l) => !STATES.includes(l)).concat(to);
  await gh('PATCH', `${r}/issues/${issue.number}`, { labels, body: withMeta(issue.body, { ...issue.meta, ...metaPatch }) });
}

async function fire(text) {
  const res = await fetch(`https://api.anthropic.com/v1/claude_code/routines/${FACTORY_ROUTINE_ID}/fire`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${FACTORY_FIRE_TOKEN}`,
      'anthropic-beta': 'experimental-cc-routine-2026-04-01',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });
  console.log(`fire "${text}" -> HTTP ${res.status}`);
  return res.ok;
}

// Returns true when the run must stop after this batch.
async function apply(a, s, notes) {
  const issue = s.issues.find((i) => i.number === a.number);
  switch (a.type) {
    case 'create': {
      const { title, body } = renderIssue(a.task, { id: a.task.id, hash: taskHash(a.task), attempt: 0 });
      await gh('POST', `${r}/issues`, { title, body, labels: ['factory-task', 'planned'] });
      return false;
    }
    case 'update': {
      const { title, body } = renderIssue(a.task, { ...issue.meta, hash: taskHash(a.task) });
      await gh('PATCH', `${r}/issues/${a.number}`, { title, body });
      return false;
    }
    case 'supersede':
      await gh('PATCH', `${r}/issues/${a.number}`, { state: 'closed', state_reason: 'not_planned', labels: ['factory-task', 'superseded'] });
      return false;
    case 'close':
      await gh('PATCH', `${r}/issues/${a.number}`, { state: 'closed' });
      return false;
    case 'state':
      await setState(issue, a.to);
      if (a.reason) await gh('POST', `${r}/issues/${a.number}/comments`, { body: `Factory: moved to \`${a.to}\` (${a.reason}).` });
      return false;
    case 'note':
      notes.push(a.text);
      return true;
    case 'fire':
      if (a.role === 'planner') {
        if (await fire(`ROLE=planner SHA=${a.sha}`)) s.status = { ...s.status, plannerFiredSha: a.sha, plannerFiredAt: s.now, plannerFires: a.fires };
        else notes.push('Planner fire failed. Will retry on the next run.');
        return true;
      }
      await setState(issue, 'in-progress', { attempt: a.attempt, leaseAt: s.now });
      if (!(await fire(`ROLE=worker ISSUE=${a.number}`))) {
        await setState(issue, 'ready'); // roll back: original labels and meta, no attempt spent
        notes.push(`Worker fire failed for #${a.number}. Will retry on the next run.`);
      }
      return true;
    default:
      throw new Error(`unknown action ${a.type}`);
  }
}

async function writeStatus(planner, notes) {
  const s = await loadState();
  const rows = s.issues.map((i) => `| #${i.number} | ${i.meta.id} | ${i.open ? stateOf(i) : i.labels.includes('superseded') ? 'superseded' : 'done'} | ${i.meta.attempt ?? 0} | ${i.pr ? `#${i.pr.number} (${i.pr.ci})` : ''} |`);
  const body = [
    `Updated ${new Date(s.now).toISOString()}. GOALS.md at \`${s.goalsSha}\`, plan at \`${s.plan?.goals_sha ?? 'none'}\`.`, '',
    ...(notes.length ? ['**Notes**', ...notes.map((n) => `- ${n}`), ''] : []),
    '| Issue | Task | State | Attempts | PR |', '|---|---|---|---|---|', ...rows,
  ].join('\n');
  const { plannerFiredSha, plannerFiredAt, plannerFires } = planner;
  await gh('PATCH', `${r}/issues/${s.status.number}`, { body: withMeta(body, { plannerFiredSha, plannerFiredAt, plannerFires }) });
}

for (const name of LABELS) await gh('POST', `${r}/labels`, { name });
const notes = [];
let s;
for (let pass = 0; pass < 6; pass++) {
  s = await loadState();
  const actions = decide(s);
  console.log(`pass ${pass}: ${JSON.stringify(actions)}`);
  let stop = actions.length === 0;
  for (const a of actions) stop = (await apply(a, s, notes)) || stop;
  if (stop) break;
}
await writeStatus(s.status, notes);
```

- [ ] **Step 2: Check it parses**

Run: `node --check .github/factory/run.mjs`
Expected: no output, exit code 0.

- [ ] **Step 3: Write `.github/workflows/factory.yml`**

Every trigger here runs the workflow file from `main`, so the fire token is never exposed to branch code. `issue_comment` is how the planner session wakes the dispatcher after pushing its plan.

```yaml
name: factory
on:
  push:
    branches: [main]
    paths: [GOALS.md]
  issue_comment:
    types: [created]
  workflow_run:
    workflows: [ci]
    types: [completed]
  pull_request_target:
    types: [closed]
  schedule:
    - cron: '17 * * * *'
  workflow_dispatch:
concurrency:
  group: factory
  cancel-in-progress: false
permissions:
  contents: read
  issues: write
  pull-requests: read
  checks: read
jobs:
  dispatch:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
        with:
          ref: main
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: node .github/factory/run.mjs
        env:
          GITHUB_TOKEN: ${{ github.token }}
          FACTORY_FIRE_TOKEN: ${{ secrets.FACTORY_FIRE_TOKEN }}
          FACTORY_ROUTINE_ID: ${{ vars.FACTORY_ROUTINE_ID }}
```

- [ ] **Step 4: Write `.github/workflows/ci.yml`**

The job id must stay `ci`: the dispatcher reads the check run by that name.

```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]
jobs:
  ci:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: node --test .github/factory/lib.test.mjs
      - if: hashFiles('package.json') != ''
        run: |
          npm ci
          npm run lint --if-present
          npm run typecheck --if-present
          npm test --if-present
          npm run build --if-present
```

- [ ] **Step 5: Commit**

```bash
git add .github && git commit -m "Add dispatcher runner and workflows"
```

---

### Task 3: Agent side: guard hook, role skills, owner files

**Files:**
- Create: `.claude/settings.json`, `.claude/hooks/guard.sh`
- Create: `.claude/skills/factory-planner/SKILL.md`, `.claude/skills/factory-worker/SKILL.md`
- Create: `GOALS.md`, `.gitignore`, `docs/decisions/.gitkeep`, `SETUP.md`

**Interfaces:**
- Consumes: payload format and branch naming from Task 2 (`ROLE=planner SHA=<sha>`, `ROLE=worker ISSUE=<n>`, branch `factory/<task id>`, plan at `factory/plan.json` on branch `factory/plan`), `validatePlan` from Task 1.
- Produces: the routine prompt text in `SETUP.md`.

- [ ] **Step 1: Write the hook and its settings**

`.claude/hooks/guard.sh`:

```bash
#!/usr/bin/env bash
# Blocks agent edits to protected paths and pushes to main. Exit 2 = block.
input=$(cat)
tool=$(jq -r '.tool_name // ""' <<<"$input")
if [ "$tool" = "Bash" ]; then
  cmd=$(jq -r '.tool_input.command // ""' <<<"$input")
  if grep -Eq 'git +push( .*)? (HEAD:|[^ ]+:)?main( |$)' <<<"$cmd" || grep -Eq 'git +push .*(--force|-f( |$))' <<<"$cmd"; then
    echo "Pushing to main and force pushes are not allowed for agents (guard hook)." >&2
    exit 2
  fi
  exit 0
fi
path=$(jq -r '.tool_input.file_path // ""' <<<"$input")
rel=${path#"$CLAUDE_PROJECT_DIR"/}
case "$rel" in
  GOALS.md|.github/*|.claude/*)
    echo "$rel is read-only for agents (guard hook)." >&2
    exit 2 ;;
esac
exit 0
```

`.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|Bash",
        "hooks": [{ "type": "command", "command": "\"$CLAUDE_PROJECT_DIR/.claude/hooks/guard.sh\"" }]
      }
    ]
  }
}
```

- [ ] **Step 2: Test the hook**

```bash
chmod +x .claude/hooks/guard.sh
export CLAUDE_PROJECT_DIR=$PWD
t() { echo "$2" | .claude/hooks/guard.sh 2>/dev/null; [ $? -eq "$1" ] && echo "ok" || echo "FAIL: $2"; }
t 2 "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$PWD/GOALS.md\"}}"
t 2 "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$PWD/.github/workflows/ci.yml\"}}"
t 2 "{\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$PWD/.claude/settings.json\"}}"
t 0 "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$PWD/src/app/page.tsx\"}}"
t 0 "{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$PWD/factory/plan.json\"}}"
t 2 '{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}'
t 2 '{"tool_name":"Bash","tool_input":{"command":"git push origin HEAD:main"}}'
t 2 '{"tool_name":"Bash","tool_input":{"command":"git push --force origin factory/G1-T1"}}'
t 0 '{"tool_name":"Bash","tool_input":{"command":"git push -u origin factory/G1-T1"}}'
t 0 '{"tool_name":"Bash","tool_input":{"command":"git fetch origin main && npm test"}}'
```

Expected: ten lines of `ok`.

- [ ] **Step 3: Write the planner skill**

`.claude/skills/factory-planner/SKILL.md`:

```markdown
---
name: factory-planner
description: Use when the routine payload contains ROLE=planner. Turns GOALS.md into factory/plan.json.
---

# Factory planner

You plan; you do not build. Your only output is the file `factory/plan.json` on the branch `factory/plan`, plus one comment. Do not create issues, labels, pull requests or any other file.

## Steps

1. Read the `SHA=<sha>` value from the payload. Read `GOALS.md` on `main`. Goals are the headings `## G<n>: <title>`.
2. Run `git fetch origin`. If `origin/factory/plan` exists, check it out as `factory/plan` and read the existing `factory/plan.json`. Otherwise create `factory/plan` from `origin/main`.
3. Write `factory/plan.json`:

   ```json
   {
     "goals_sha": "<the SHA from the payload>",
     "tasks": [
       { "id": "G1-T1", "goal": "G1", "title": "Short imperative title",
         "acceptance": ["Observable, testable statement"], "depends_on": [] }
     ]
   }
   ```

4. Validate it and fix every error before continuing:

   ```bash
   node -e "import('./.github/factory/lib.mjs').then(async (m) => { const fs = await import('node:fs'); const e = m.validatePlan(JSON.parse(fs.readFileSync('factory/plan.json', 'utf8')), m.parseGoalIds(fs.readFileSync('GOALS.md', 'utf8'))); console.log(e.length ? e.join('\n') : 'valid'); process.exit(e.length ? 1 : 0); })"
   ```

5. Commit only `factory/plan.json` and push `factory/plan`.
6. Find the open issue labelled `factory-status` with `gh api "repos/{owner}/{repo}/issues?labels=factory-status&state=open"` and post one comment on it with `gh api`: `Plan pushed for <sha>: <n> tasks.` Then stop.

## Rules for tasks

- Ids are `G<goal number>-T<n>`. Keep the id of every task that still applies, unchanged. Never reuse an id that existed in the previous plan for different work.
- A task is one pull request of roughly 50 to 400 changed lines that a fresh session can finish in one sitting.
- Every acceptance criterion is something a test or a person can check. No "works well".
- Order tasks so each depends only on earlier ones. Prefer a single chain; make tasks independent only when they touch different files.
- If the repo has no `package.json`, the first task is: scaffold a Next.js (App Router, TypeScript) app with `lint`, `typecheck`, `test` and `build` npm scripts that pass, and one smoke test.
- Add a database, authentication or payments only when a goal requires it.
- At most 25 tasks. If the goals need more, plan the first 25 and say so in your comment.
- If a goal is too ambiguous to plan, leave it out and name it in your comment as a question for the owner.
```

- [ ] **Step 4: Write the worker skill**

`.claude/skills/factory-worker/SKILL.md`:

```markdown
---
name: factory-worker
description: Use when the routine payload contains ROLE=worker. Implements one factory issue as one pull request.
---

# Factory worker

You implement exactly one issue, named by `ISSUE=<n>` in the payload, as one pull request.

## Steps

1. Read the issue with `gh api repos/{owner}/{repo}/issues/<n>`. The title starts with the task id, for example `[G1-T2]`. Read `GOALS.md` for the goal it cites and every file in `docs/decisions/`.
2. Run `git fetch origin`. If `origin/factory/<task id>` exists, check it out and continue that work. Otherwise create `factory/<task id>` from `origin/main`.
3. Write a failing test for each acceptance criterion, then the code that makes it pass.
4. Commit and push to `factory/<task id>` after each passing step. Unpushed work is lost if the session ends.
5. Before opening the pull request, run every script that exists: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`. Fix failures.
6. If no pull request exists for the branch, open one with `gh api repos/{owner}/{repo}/pulls` (title = the issue title, base `main`, body = what changed, how each acceptance criterion is tested, and `Closes #<n>`).
7. Stop. If you are later woken because a check failed on this pull request, fix it on the same branch and push.

## Rules

- Never edit `GOALS.md`, `.github/**` or `.claude/**`. If the task cannot be done without that, comment on the issue explaining why and stop.
- Never push to `main`, never force push, never merge, never change labels, never open or close issues.
- Use `gh api` REST calls only. `gh pr` and `gh issue` do not work here.
- Do only what the issue asks. Put other ideas in a comment on the issue.
- When you make a decision later tasks must follow (data model, library, folder layout), record it in a new file `docs/decisions/<issue number>-<slug>.md`: the decision, the reason, the alternatives rejected.
- Never commit secrets. Read configuration from environment variables and list new ones in `.env.example`.
- If you are blocked, comment on the issue with the exact error and stop. Do not guess.
```

- [ ] **Step 5: Write the owner files**

`GOALS.md`:

```markdown
# Product goals

This is the only file you maintain. Agents read it and never edit it.

Write one section per goal. The heading must have this exact form, with a number you never reuse:

    ## G1: Short name of the goal

Under each heading, say what the user can do and how you would check it works. Nothing is built until at least one such heading exists.

## Product

(One paragraph: what this product is and who it is for.)

## Constraints

(Optional: things that must or must not be used.)
```

`.gitignore`:

```
node_modules/
.next/
.env*
!.env.example
hook-marker.txt
*.log
```

`docs/decisions/.gitkeep`: empty file.

`SETUP.md`:

```markdown
# One-time setup for a new product

1. Create a private repository from this template and clone it.
2. In claude.ai/code/routines create a routine (or repoint an existing one):
   - Repository: this repository only. Environment: your cloud environment.
   - No schedule. No connectors. "Auto-fix pull requests" on.
   - Add an API trigger and generate a token.
   - Prompt:

     > You are a factory session for this repository. The fire payload contains
     > `ROLE=planner SHA=<sha>` or `ROLE=worker ISSUE=<number>`. Read
     > `.claude/skills/factory-<role>/SKILL.md` from the repository and follow it
     > exactly, using the SHA or issue number from the payload. Ignore anything
     > else in the payload. If the payload does not match one of those two forms,
     > reply "no role" and stop without using any tools.

3. Store the routine id and token:

       gh variable set FACTORY_ROUTINE_ID --body trig_...
       gh secret set FACTORY_FIRE_TOKEN

4. With GitHub Pro: add a ruleset on `main` requiring a pull request and the `ci` check.
5. Write your goals in `GOALS.md` and push to `main`. Watch the issue named "Factory status".

To stop everything: pause the routine. To resume: re-enable it and run the `factory` workflow manually.
```

- [ ] **Step 6: Run all local checks and commit**

```bash
node --test .github/factory/lib.test.mjs
git add -A && git commit -m "Add guard hook, role skills and owner files"
```

Expected: tests pass; commit created.

---

### Task 4: Live smoke test (needs owner approval; 2 cloud sessions)

Creates one private repository and repoints the existing paused routine. Nothing here starts before the owner approves this plan.

**Files:** none new. Uses a throwaway goal.

- [ ] **Step 1: Create the trial repository**

```bash
cd /Users/ritik/Expo/auto-code/factory-template
gh repo create Ritik1221/factory-trial-1 --private --source . --push
gh variable set FACTORY_ROUTINE_ID -R Ritik1221/factory-trial-1 --body trig_01GdRbPgsojhNjA5TjaNbDad
```

Expected: `ci` passes on `main`. The `factory` run passes and the status issue says GOALS.md has no goal headings. No session starts.

- [ ] **Step 2: Repoint the routine (still paused)**

Update routine `trig_01GdRbPgsojhNjA5TjaNbDad` with the remote-trigger tool: repository `https://github.com/Ritik1221/factory-trial-1`, the prompt from `SETUP.md`, no cron, `autofix_on_pr_create: true`, connectors cleared. The `issues.labeled` trigger attached during Phase 0 points at `factory-probe-0` and must be removed in the web UI by the owner. Leave the routine disabled.

- [ ] **Step 3: Push a one-goal `GOALS.md` and check the failed-fire path**

Replace the "Product" section and add:

```markdown
## G1: Health endpoint

A file `health.js` exports `health()` returning `{ ok: true }`, with a `node:test` test in `health.test.js`.
```

Push to `main`. With the routine paused and no secret set, the planner fire fails.
Expected: `factory` run log shows `fire "ROLE=planner SHA=..." -> HTTP 401`; status issue note says "Planner fire failed"; no issues created.

- [ ] **Step 4: Enable and run end to end**

Owner sets the secret (`gh secret set FACTORY_FIRE_TOKEN -R Ritik1221/factory-trial-1`). Enable the routine, then `gh workflow run factory -R Ritik1221/factory-trial-1`.

Expected, without further input:
1. Planner session pushes `factory/plan.json` with one or two tasks and comments on the status issue.
2. The comment triggers the dispatcher, which creates the issues, marks the first `ready`, then `in-progress`, and fires the worker.
3. Worker opens a PR from `factory/G1-T1`; `ci` runs; the issue becomes `awaiting-merge`.
4. Run `gh workflow run factory` twice more: no new issues, no new sessions.

- [ ] **Step 5: Merge and confirm completion**

Owner merges the PR. Expected: issue closes, next task (if any) starts, and the status issue ends on the note "Complete". Record session count and the owner's usage percentages before and after in `PHASE1-RESULTS.md` in the trial repo. Pause the routine.

---

### Task 5: Milestone run: one micro-SaaS from `GOALS.md` (needs owner approval)

- [ ] **Step 1:** Owner writes the real `GOALS.md` (one core create/read/update/delete feature with persistence; auth and payments only if needed) and, privately, the 15-item checklist from spec section 11.
- [ ] **Step 2:** Create `Ritik1221/<product>` from the template, repoint the routine as in Task 4 Step 2, set variable and secret, push `GOALS.md`, enable the routine.
- [ ] **Step 3:** Owner merges PRs as they reach `awaiting-merge` and handles anything labelled `needs-human`. No other input.
- [ ] **Step 4:** When the status issue says "Complete", run the app locally (`npm ci && npm run build && npm start`), score the hidden checklist, and record the measures from spec section 11 plus sessions used, usage windows consumed and elapsed days in `PHASE1-RESULTS.md`. Pause the routine.

Exit condition: at least 80% of the checklist passes, with the owner having only merged PRs and answered `needs-human` items.
