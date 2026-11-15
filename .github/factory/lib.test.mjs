import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decide, validatePlan, taskHash, parseGoalIds, parseMeta, withMeta,
  renderIssue, touchesProtected, ciState, branchOf, fireOutcome, pickReview, weakened, LIMITS,
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
const pr = (over = {}) => ({ number: 9, state: 'open', ci: 'pending', headSha: 'h1', protectedFiles: false, weakened: null, files: 3, mergeable: true, behind: false, ...over });

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
  const run = (over) => ({ name: 'ci', app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success', started_at: '2026-01-01T00:00:00Z', ...over });
  assert.equal(ciState([]), 'pending');
  assert.equal(ciState([run({ name: 'vercel', conclusion: 'failure' })]), 'pending');
  assert.equal(ciState([run()]), 'green');
  assert.equal(ciState([run({ app: { slug: 'some-other-app' } })]), 'pending'); // only GitHub Actions can vouch for CI
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
  const done = [issue(T1, 2, 'in-review', { open: false }), issue(T2, 3, 'planned')];
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
  assert.deepEqual(one({ ...lease(1000), pr: pr({ ci: 'green' }) }), [{ type: 'fire', role: 'reviewer', number: 2, pr: 9, sha: 'h1', reviews: 1, route: 'reviewer' }]);
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

const plan1 = { goals_sha: 'abc', tasks: [T1] };
const reviewing = (extra = {}, metaOver = {}) => issue(T1, 2, 'in-review', {
  meta: { id: 'G1-T1', hash: taskHash(T1), attempt: 1, tries: 1, leaseAt: NOW - 5000, reviewSha: 'h1', reviewAt: NOW - 1000, reviews: 1, ...metaOver },
  pr: pr({ ci: 'green' }), review: { sha: 'h1', verdict: 'approve', at: NOW - 500 }, ...extra,
});
const rv = (extra, metaOver) => decide(state({ plan: plan1, issues: [reviewing(extra, metaOver)] }));

test('merges exactly the commit that passed CI and review', () => {
  assert.deepEqual(rv(), [{ type: 'merge', number: 9, issue: 2, sha: 'h1' }]);
});

test('stale or missing approvals never merge', () => {
  assert.deepEqual(rv({ review: { sha: 'h0', verdict: 'approve', at: NOW - 500 } }), []); // approval of another commit
  assert.deepEqual(rv({ review: { sha: 'h1', verdict: 'approve', at: NOW - 2000 } }), []); // posted before this review began
  assert.deepEqual(rv({ review: null }), []);
  const moved = rv({ pr: pr({ ci: 'green', headSha: 'h2' }), review: { sha: 'h2', verdict: 'approve', at: NOW - 500 } });
  assert.deepEqual(moved.map((x) => [x.type, x.to]), [['state', 'in-progress']]); // commit changed after review started
});

test('an approved PR still has to pass the dispatcher own checks', () => {
  assert.deepEqual(rv({ pr: pr({ ci: 'pending' }) }), []);
  assert.equal(rv({ pr: pr({ ci: 'red' }) })[0].to, 'in-progress');
  assert.equal(rv({ pr: pr({ ci: 'green', protectedFiles: true }) })[0].to, 'needs-human');
  assert.equal(rv({ pr: pr({ ci: 'green', weakened: 'PR deletes tests' }) })[0].to, 'needs-human');
  assert.equal(rv({ pr: pr({ ci: 'green', files: LIMITS.maxFiles + 1 }) })[0].to, 'needs-human');
  assert.equal(rv({ pr: pr({ ci: 'green', behind: true }) })[0].to, 'ready');
  assert.equal(rv({ pr: pr({ ci: 'green', mergeable: false }) })[0].to, 'ready');
  assert.deepEqual(rv({ pr: pr({ ci: 'green', mergeable: null }) }), []);
});

test('review outcomes: reject retries, merged closes, closed PR retries', () => {
  const rejected = rv({ review: { sha: 'h1', verdict: 'reject', at: NOW - 500 } });
  assert.equal(rejected[0].to, 'ready');
  assert.match(rejected[0].reason, /review rejected/);
  assert.deepEqual(rv({ pr: pr({ state: 'merged' }) }), [{ type: 'close', number: 2 }]);
  assert.equal(rv({ pr: pr({ state: 'closed' }) })[0].to, 'ready');
});

test('a silent reviewer is refired within the review limit, then a human is needed', () => {
  const late = { reviewAt: NOW - LIMITS.reviewLeaseMs - 1 };
  assert.deepEqual(rv({ review: null }, late), [{ type: 'fire', role: 'reviewer', number: 2, pr: 9, sha: 'h1', reviews: 2, route: 'reviewer' }]);
  assert.equal(rv({ review: null }, { ...late, reviews: LIMITS.maxReviews })[0].to, 'needs-human');
  const again = issue(T1, 2, 'in-progress', { meta: { id: 'G1-T1', hash: taskHash(T1), attempt: 1, leaseAt: NOW, reviews: LIMITS.maxReviews }, pr: pr({ ci: 'green' }) });
  assert.equal(decide(state({ plan: plan1, issues: [again] }))[0].to, 'needs-human');
});

test('a task in review blocks every other session', () => {
  const T3 = { ...T1, id: 'G1-T3' };
  const s = state({ plan: { goals_sha: 'abc', tasks: [T1, T3] }, issues: [reviewing({ review: null }), issue(T3, 4, 'ready')] });
  assert.deepEqual(decide(s), []);
  assert.deepEqual(decide(state({ plan: { goals_sha: 'old', tasks: [T1] }, issues: [reviewing({ review: null })] })), []);
});

test('no new worker when main is red', () => {
  assert.equal(decide(state({ plan: plan1, issues: [issue(T1, 2, 'ready')], mainCi: 'red' }))[0].type, 'note');
});

test('pickReview takes the latest well-formed verdict', () => {
  const c = (body, t) => ({ body, created_at: new Date(NOW + t * 1000).toISOString() });
  const mark = (o) => `Findings.\n<!-- factory-review ${JSON.stringify(o)} -->`;
  assert.equal(pickReview([c('looks good', 0)]), null);
  assert.equal(pickReview([c(mark({ sha: 'h1', verdict: 'maybe' }), 0)]), null);
  assert.deepEqual(pickReview([c(mark({ sha: 'h1', verdict: 'reject' }), 0), c(mark({ sha: 'h1', verdict: 'approve' }), 5)]), { sha: 'h1', verdict: 'approve', at: NOW + 5000 });
});

test('sensitive paths are never eligible for automatic merge', () => {
  for (const f of ['.env', '.env.production', 'Dockerfile', 'docker-compose.yml', 'vercel.json', 'infra/main.tf', 'deploy/run.sh', 'fly.toml', '.npmrc', 'certs/server.pem', 'CODEOWNERS', '.claude/settings.json', 'app/wrangler.toml', 'db/migrations/001.sql']) {
    assert.ok(touchesProtected([f]), f);
  }
  for (const f of ['.env.example', 'src/app/page.tsx', 'package.json', 'docs/decisions/1-x.md', 'src/deploy-banner.ts']) {
    assert.ok(!touchesProtected([f]), f);
  }
});

test('removing a CI script or deleting tests is flagged', () => {
  const f = (filename, status = 'modified') => ({ filename, status });
  const scripts = { test: 'node --test', lint: 'eslint .' };
  assert.equal(weakened([f('src/a.js')], scripts, scripts), null);
  assert.equal(weakened([f('src/a.js')], {}, scripts), null); // the scaffold task adds scripts
  assert.equal(weakened([f('src/a.js')], scripts, { ...scripts, test: 'node --test --experimental-test-coverage' }), null);
  assert.match(weakened([f('package.json')], scripts, { lint: 'eslint .' }), /test/);
  assert.match(weakened([f('package.json')], scripts, { ...scripts, test: ' ' }), /test/);
  assert.match(weakened([f('src/a.test.js', 'removed')], scripts, scripts), /deletes tests/);
  assert.match(weakened([f('__tests__/a.js', 'removed')], scripts, scripts), /deletes tests/);
  assert.equal(weakened([f('src/b.test.js', 'renamed')], scripts, scripts), null);
});

test('all tasks closed reports Complete', () => {
  const issues = [issue(T1, 2, 'in-review', { open: false }), issue(T2, 3, 'in-review', { open: false })];
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
  assert.deepEqual(run('in-review', { open: false }), [{ type: 'closePr', number: 7, issue: 2 }, { type: 'closePr', number: 9, issue: 2 }]);
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
  const merged = issue(T1, 2, 'in-review', { pr: pr({ state: 'merged' }) });
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

test('duplicate issues for one task are superseded, keeping the one furthest along', () => {
  const started = issue(T1, 4, 'in-progress', { meta: { id: 'G1-T1', hash: taskHash(T1), attempt: 1, leaseAt: NOW } });
  assert.deepEqual(decide(state({ plan: plan1, issues: [issue(T1, 3, 'ready'), started] })), [{ type: 'supersede', number: 3 }]);
  assert.deepEqual(decide(state({ plan: plan1, issues: [issue(T1, 3, 'planned'), issue(T1, 4, 'planned')] })), [{ type: 'supersede', number: 4 }]);
  // also while the plan is unusable, and never touching closed or superseded issues
  assert.deepEqual(decide(state({ plan: null, issues: [issue(T1, 3, 'ready'), issue(T1, 4, 'ready')] }))[0], { type: 'supersede', number: 4 });
  const done = issue(T1, 2, 'in-review', { open: false });
  assert.deepEqual(decide(state({ plan: plan1, issues: [done, issue(T1, 5, 'ready')] })), [{ type: 'supersede', number: 5 }]);
});

test('a superseded duplicate never closes the pull request of the live issue', () => {
  const openPrs = [{ number: 5, attempt: 1 }];
  const dup = issue(T1, 3, 'superseded', { open: false, labels: ['factory-task', 'superseded'], openPrs });
  const live = issue(T1, 4, 'in-progress', { meta: { id: 'G1-T1', hash: taskHash(T1), attempt: 1, leaseAt: NOW }, openPrs });
  assert.deepEqual(decide(state({ plan: plan1, issues: [dup, live] })), []);
  // a task dropped from the plan still has its pull request closed
  const T9 = { ...T1, id: 'G1-T9' };
  assert.deepEqual(decide(state({ plan: { goals_sha: 'abc', tasks: [T9] }, issues: [dup, issue(T9, 6, 'ready')] }))[0], { type: 'closePr', number: 5, issue: 3 });
});
