import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decide, validatePlan, taskHash, parseGoalIds, parseMeta, withMeta,
  renderIssue, touchesProtected, ciState, branchOf, fireOutcome, LIMITS,
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
  assert.deepEqual(decide(state({ plan: null })), [{ type: 'fire', role: 'planner', sha: 'abc', fires: 1, route: 'planner' }]);
  assert.deepEqual(decide(state({ plan: { goals_sha: 'old', tasks: [T1] } })), [{ type: 'fire', role: 'planner', sha: 'abc', fires: 1, route: 'planner' }]);
});

test('planner is not refired inside the retry window, and stops after the cap', () => {
  const fired = (ago, fires) => ({ plannerFiredSha: 'abc', plannerFiredAt: NOW - ago, plannerFires: fires });
  assert.deepEqual(decide(state({ plan: null, status: fired(10 * 60000, 1) })), []);
  assert.deepEqual(decide(state({ plan: null, status: fired(61 * 60000, 1) })), [{ type: 'fire', role: 'planner', sha: 'abc', fires: 2, route: 'planner' }]);
  assert.equal(decide(state({ plan: null, status: fired(61 * 60000, 3) }))[0].type, 'note');
});

test('planner waits while a worker is in progress', () => {
  const s = state({ plan: { goals_sha: 'old', tasks: [T1] }, issues: [issue(T1, 2, 'in-progress', { meta: { id: 'G1-T1', hash: 'x', attempt: 1, leaseAt: NOW } })] });
  assert.deepEqual(decide(s), []);
});

test('unparseable or invalid plan creates nothing', () => {
  const a = decide(state({ plan: { goals_sha: 'abc', tasks: null } }));
  assert.deepEqual(a.map((x) => x.type), ['note', 'fire']);
  assert.match(a[0].text, /Plan rejected/);
  assert.equal(a[1].role, 'planner');
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
  // the superseded task is recreated first; its dependant stays planned
  assert.deepEqual(decide(state({ issues: superseded })), [{ type: 'create', task: T1 }]);
});

test('fires one worker when nothing is in progress, none when something is', () => {
  const ready = [issue(T1, 2, 'ready'), issue(T2, 3, 'planned')];
  assert.deepEqual(decide(state({ issues: ready })), [{ type: 'fire', role: 'worker', number: 2, attempt: 1, tries: 1, route: 'worker' }]);
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
  assert.deepEqual(one({ ...lease(LIMITS.leaseMs + 1), lastCommitAt: NOW - 1000 }), []);
  assert.equal(one({ ...lease(LIMITS.maxLeaseMs + 1), lastCommitAt: NOW - 1000 })[0].to, 'ready');
});

test('a ready task with attempts exhausted needs a human', () => {
  const spent = issue(T1, 2, 'ready', { meta: { id: 'G1-T1', hash: taskHash(T1), attempt: 3, tries: LIMITS.maxAttempts } });
  const a = decide(state({ plan: { goals_sha: 'abc', tasks: [T1] }, issues: [spent] }));
  assert.equal(a[0].to, 'needs-human');
  assert.deepEqual(a[0].meta, { tries: 0 }); // the owner relabelling to ready grants a fresh set of tries
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

test('difficulty is optional but must be routine or hard', () => {
  assert.deepEqual(validatePlan({ goals_sha: 'abc', tasks: [{ ...T1, difficulty: 'hard' }] }, ['G1']), []);
  assert.ok(validatePlan({ goals_sha: 'abc', tasks: [{ ...T1, difficulty: 'epic' }] }, ['G1']).length > 0);
});

test('hard tasks and the last attempt are routed to escalation', () => {
  const hard = { ...T1, difficulty: 'hard' };
  const a = decide(state({ plan: { goals_sha: 'abc', tasks: [hard] }, issues: [issue(hard, 2, 'ready')] }));
  assert.deepEqual(a, [{ type: 'fire', role: 'worker', number: 2, attempt: 1, tries: 1, route: 'escalation' }]);
  const last = issue(T1, 2, 'ready', { meta: { id: 'G1-T1', hash: taskHash(T1), attempt: 7, tries: LIMITS.maxAttempts - 1 } });
  const b = decide(state({ plan: { goals_sha: 'abc', tasks: [T1] }, issues: [last] }));
  assert.deepEqual(b, [{ type: 'fire', role: 'worker', number: 2, attempt: 8, tries: LIMITS.maxAttempts, route: 'escalation' }]);
});

test('PRs from other attempts are closed; the current attempt and needs-human are left alone', () => {
  assert.equal(branchOf('G1-T1', 2), 'factory/G1-T1-a2');
  const plan = { goals_sha: 'abc', tasks: [T1] };
  const meta = { id: 'G1-T1', hash: taskHash(T1), attempt: 2, leaseAt: NOW };
  const openPrs = [{ number: 7, attempt: 1 }, { number: 9, attempt: 2 }];
  const run = (label, extra = {}) => decide(state({ plan, issues: [issue(T1, 2, label, { meta, openPrs, ...extra })] }));
  assert.deepEqual(run('in-progress'), [{ type: 'closePr', number: 7, issue: 2 }]);
  assert.deepEqual(run('needs-human'), []);
  assert.deepEqual(run('ready').filter((x) => x.type === 'closePr').map((x) => x.number), [7, 9]);
  assert.deepEqual(run('awaiting-merge', { open: false }), [{ type: 'closePr', number: 7, issue: 2 }, { type: 'closePr', number: 9, issue: 2 }]);
});

test('an exhausted ready task keeps its PR open for the human', () => {
  const meta = { id: 'G1-T1', hash: taskHash(T1), attempt: 3, tries: LIMITS.maxAttempts };
  const a = decide(state({ plan: { goals_sha: 'abc', tasks: [T1] }, issues: [issue(T1, 2, 'ready', { meta, openPrs: [{ number: 7, attempt: 3 }] })] }));
  assert.deepEqual(a.map((x) => x.type), ['state']);
  assert.equal(a[0].to, 'needs-human');
});

test('fire outcome: only a 4xx proves no session started', () => {
  assert.equal(fireOutcome(200), 'ok');
  assert.equal(fireOutcome(401), 'refused');
  assert.equal(fireOutcome(429), 'refused');
  assert.equal(fireOutcome(502), 'unknown');
  assert.equal(fireOutcome(null), 'unknown');
});

test('a superseded id that returns to the plan gets a new issue', () => {
  const old = issue(T1, 2, 'superseded', { open: false, labels: ['factory-task', 'superseded'] });
  const a = decide(state({ plan: { goals_sha: 'abc', tasks: [T1] }, issues: [old] }));
  assert.deepEqual(a, [{ type: 'create', task: T1 }]);
});

test('housekeeping continues while the plan is rejected or goals are missing', () => {
  const merged = issue(T1, 2, 'awaiting-merge', { pr: pr({ state: 'merged' }) });
  assert.deepEqual(decide(state({ plan: { goals_sha: 'abc', tasks: null }, issues: [merged] })), [{ type: 'close', number: 2 }]);
  assert.deepEqual(decide(state({ goalIds: [], plan: null, issues: [merged] })), [{ type: 'close', number: 2 }]);
});

test('a rejected plan stops refiring at the planner cap', () => {
  const status = { plannerFiredSha: 'abc', plannerFiredAt: NOW - 61 * 60000, plannerFires: LIMITS.maxPlannerFires };
  const a = decide(state({ plan: { goals_sha: 'abc', tasks: null }, status }));
  assert.deepEqual(a.map((x) => x.type), ['note', 'note']);
});

test('an open task with no state label goes to needs-human and keeps its PRs', () => {
  const odd = { ...issue(T1, 2, 'ready'), labels: ['factory-task'], openPrs: [{ number: 7, attempt: 1 }] };
  const a = decide(state({ plan: { goals_sha: 'abc', tasks: [T1] }, issues: [odd] }));
  assert.deepEqual(a.map((x) => [x.type, x.to]), [['state', 'needs-human']]);
});

test('over-long titles are rejected', () => {
  assert.ok(validatePlan({ goals_sha: 'abc', tasks: [{ ...T1, title: 'x'.repeat(201) }] }, ['G1']).length > 0);
});
