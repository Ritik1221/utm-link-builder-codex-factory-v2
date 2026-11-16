import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, goalSnapshotHash, makeGoalSnapshot, renderFinalReview, completionGate, taskHash, LIMITS, planVersionHash } from './lib.mjs';
import { emptyFactoryState } from './state.mjs';

const task = (id, title, depends_on = []) => ({ id, goal: 'G1', title, acceptance: ['observable behavior is tested'], depends_on });
const planFor = (snapshot) => ({
  goals_sha: snapshot.hash, goal_snapshot_sha: snapshot.hash,
  architecture: { components: ['web'], data_model: [], security_boundaries: ['no secrets in worker'] },
  assumptions: ['The disposable repository has no production users'],
  constraints: ['No paid APIs'],
  decisions: [{ id: 'ADR-001', decision: 'Use a small web service', rationale: 'It directly exercises the product flow', alternatives: ['CLI only'], requires_human_approval: false }],
  invariants: ['A failed review cannot merge'],
  requirements: [{ id: 'REQ-001', description: 'A real product flow', acceptance_tests: ['the result is visible'], tasks: ['G1-T1', 'G1-T2'] }],
  completion: { required_checks: ['ci', 'e2e'], smoke_test: { name: 'product flow', command: 'npm run e2e', assertions: ['input produces visible result'] } },
  tasks: [task('G1-T1', 'Build core flow'), task('G1-T2', 'Add final behavior', ['G1-T1'])],
});
const issue = (t, number, label = 'planned', extra = {}) => ({
  number, open: true, labels: ['factory-task', label], meta: { id: t.id, hash: taskHash(t), attempt: 0, tries: 0 },
  pr: null, ...extra,
});
const pr = (sha, extra = {}) => ({ number: 90, state: 'open', ci: 'green', headSha: sha, protectedFiles: false, weakened: null, files: 2, mergeable: true, behind: false, ...extra });

test('mocked goal-to-deliverable run survives rejection, retry and final reconciliation', () => {
  const snapshot = makeGoalSnapshot({ number: 7, title: 'Product goal', body: '## G1: Product\nBuild a useful product.' });
  const plan = planFor(snapshot);
  let issues = [issue(plan.tasks[0], 11), issue(plan.tasks[1], 12)];
  const base = () => ({ now: 10_000, goalsSha: null, goalIds: [], goalCandidate: null, goalSnapshot: snapshot, plan, issues,
    status: { plannerFiredSha: null, plannerFiredAt: 0, plannerFires: 0, finalReviewAt: 0, finalReviewFires: 0, canonical: emptyFactoryState() },
    mainCi: 'green', mainSha: 'main-1', mainChecks: { ci: 'green', e2e: 'green' }, finalReview: null });

  let s = base();
  assert.equal(decide(s)[0].type, 'state');
  issues[0].labels = ['factory-task', 'ready'];
  assert.equal(decide(base())[0].role, 'worker');

  issues[0] = issue(plan.tasks[0], 11, 'in-progress', { meta: { ...issues[0].meta, attempt: 1, tries: 1, leaseAt: s.now }, pr: pr('task-1') });
  assert.equal(decide(base())[0].role, 'reviewer');
  issues[0].labels = ['factory-task', 'in-review'];
  issues[0].meta = { ...issues[0].meta, reviewSha: 'task-1', reviewAt: 1 };
  issues[0].review = { sha: 'task-1', verdict: 'reject', at: 2, findings: [{ id: 'REV-001', severity: 'blocking', file: 'src/core.js', evidence: 'core path has no assertion', affected_commit: 'task-1', problem: 'missing test', required_test: 'add core flow test' }] };
  const rejected = decide(base());
  assert.equal(rejected[0].to, 'ready');
  assert.deepEqual(rejected[0].meta.reviewFindings, issues[0].review.findings);

  issues[0].labels = ['factory-task', 'ready'];
  issues[0].meta = { ...issues[0].meta, attempt: 1, tries: 1 };
  assert.equal(decide(base())[0].role, 'worker');
  issues[0] = issue(plan.tasks[0], 11, 'in-review', { meta: { ...issues[0].meta, attempt: 2, tries: 2, reviewSha: 'task-2', reviewAt: 3 }, pr: pr('task-2'), review: { sha: 'task-2', verdict: 'approve', at: 4, findings: [] } });
  assert.equal(decide(base())[0].type, 'merge');
  issues[0].open = false;
  issues[1].labels = ['factory-task', 'ready'];
  assert.equal(decide(base())[0].role, 'worker');
  issues[1] = issue(plan.tasks[1], 12, 'in-review', { meta: { ...issues[1].meta, attempt: 1, tries: 1, reviewSha: 'task-3', reviewAt: 5 }, pr: pr('task-3'), review: { sha: 'task-3', verdict: 'approve', at: 6, findings: [] } });
  assert.equal(decide(base())[0].type, 'merge');
  issues[1].open = false;
  assert.equal(decide(base())[0].role, 'final-reviewer');
  assert.equal(decide(base())[0].route, 'final-reviewer');

  const finalReview = { sha: 'main-1', goal_snapshot_sha: snapshot.hash, verdict: 'approve', findings: [], reconciliation: [{ id: 'G1', status: 'satisfied', evidence: 'e2e result' }] };
  s = { ...base(), finalReview };
  assert.deepEqual(completionGate(s), { ok: true, legacy: false, missing: [] });
  assert.deepEqual(decide(s), [{ type: 'note', text: 'Complete' }]);
  assert.equal(goalSnapshotHash(snapshot.body, snapshot.title), snapshot.hash);
  assert.match(renderFinalReview(finalReview), /factory-final-review/);
});

test('final review creates bounded corrective tasks for an omitted original-goal requirement', () => {
  const snapshot = makeGoalSnapshot({ number: 7, title: 'Product goal', body: '## G1: Product\nUsers can export a report.' });
  const plan = planFor(snapshot);
  const closed = plan.tasks.map((value, index) => issue(value, 20 + index, 'in-review', { open: false }));
  const canonical = emptyFactoryState();
  canonical.provider.active = 'claude';
  const finalReview = {
    sha: 'main-1', goal_snapshot_sha: snapshot.hash, verdict: 'reject',
    reconciliation: [{ id: 'G1-export', status: 'not_satisfied', evidence: 'No export control exists in the delivered UI.' }],
    findings: [{
      id: 'FINAL-EXPORT', severity: 'blocking', file: 'src/export.js',
      evidence: 'The UI has no export action.', affected_commit: 'main-1',
      problem: 'The original goal requires report export, which the plan omitted.',
      required_test: 'An end-to-end test exports and verifies a report.', autonomous_fix: true,
      acceptance_tests: ['Export produces a non-empty report with the displayed data.'],
    }],
  };
  const state = {
    now: 20_000, goalsSha: null, goalIds: [], goalSnapshot: snapshot, plan, issues: closed,
    status: { finalReviewAt: 10, finalReviewFires: 1, canonical }, mainCi: 'green', mainSha: 'main-1',
    mainChecks: { ci: 'green', e2e: 'green' }, finalReview,
  };
  const action = decide(state)[0];
  assert.equal(action.type, 'add-corrections');
  assert.equal(action.round, 1);
  assert.equal(action.tasks[0].source_finding, 'final:FINAL-EXPORT');
  assert.match(action.tasks[0].acceptance.join(' '), /end-to-end/i);

  state.status.canonical.corrections = { round: 1, tasks: action.tasks, exhausted: false };
  assert.equal(decide(state)[0].type, 'create');

  state.status.canonical.corrections.round = LIMITS.maxCorrectionRounds;
  state.status.canonical.corrections.tasks = [];
  assert.match(decide(state)[0].text, /budget exhausted/i);
});

test('ambiguous final-review correction escalates instead of inventing work', () => {
  const snapshot = makeGoalSnapshot({ number: 7, title: 'Goal', body: '## G1: Product\nUse the approved tax interpretation.' });
  const plan = planFor(snapshot);
  const findings = [{ id: 'FINAL-TAX', severity: 'blocking', file: 'src/tax.js', evidence: 'No allocation rule is specified.', affected_commit: 'm1', problem: 'Tax allocation is ambiguous.', required_test: 'Verify the approved allocation.', autonomous_fix: false }];
  const s = {
    now: 20_000, goalSnapshot: snapshot, goalIds: [], plan,
    issues: plan.tasks.map((value, index) => issue(value, 30 + index, 'in-review', { open: false })),
    status: { finalReviewAt: 1, finalReviewFires: 1, canonical: emptyFactoryState() },
    mainCi: 'green', mainSha: 'm1', mainChecks: { ci: 'green', e2e: 'green' },
    finalReview: { sha: 'm1', goal_snapshot_sha: snapshot.hash, verdict: 'reject', findings,
      reconciliation: [{ id: 'G1', status: 'not_satisfied', evidence: 'No approved interpretation was supplied.' }] },
  };
  assert.match(decide(s)[0].text, /Needs human/);
});

test('provider changes are explicit, blocked while busy, and never implicit fallback', () => {
  const canonical = emptyFactoryState();
  canonical.provider.active = 'claude';
  const base = { now: 1, goalsSha: 'abc', goalIds: ['G1'], plan: { goals_sha: 'abc', tasks: [task('G1-T1', 'Task')] },
    issues: [], status: { canonical }, desiredProvider: 'codex', mainCi: 'green' };
  assert.deepEqual(decide(base), [{ type: 'switch-provider', from: 'claude', to: 'codex' }]);
  const busy = issue(base.plan.tasks[0], 4, 'in-progress', { meta: { id: 'G1-T1', hash: taskHash(base.plan.tasks[0]), attempt: 1, leaseAt: 1 } });
  assert.match(decide({ ...base, issues: [busy] })[0].text, /waiting for active leases/);
  canonical.provider.blocked = 'quota exhausted';
  assert.equal(decide({ ...base, desiredProvider: 'claude' })[0].type, 'note');
  assert.deepEqual(decide({ ...base, desiredProvider: 'claude', providerResumeNonce: 'resume-1' }),
    [{ type: 'resume-provider', provider: 'claude', nonce: 'resume-1' }]);
});

test('GitHub-only mode advances projections but never emits an agent fire', () => {
  const t = task('G1-T1', 'Task');
  const canonical = emptyFactoryState();
  canonical.provider.active = 'claude';
  const s = { now: 1, goalsSha: 'abc', goalIds: ['G1'], plan: { goals_sha: 'abc', tasks: [t] },
    issues: [issue(t, 4, 'ready')], status: { canonical }, desiredProvider: 'claude',
    agentsDisabled: true, mainCi: 'green' };
  const actions = decide(s);
  assert.equal(actions.some((action) => action.type === 'fire'), false);
  assert.match(actions[0].text, /disabled/);
});

test('global invocation budget prevents unbounded subscription usage', () => {
  const t = task('G1-T1', 'Task');
  const canonical = emptyFactoryState();
  canonical.provider.active = 'claude';
  canonical.invocations = Array.from({ length: LIMITS.maxInvocations }, (_, index) => ({ id: `inv_${index}`, status: 'completed' }));
  const actions = decide({ now: 1, goalsSha: 'abc', goalIds: ['G1'], plan: { goals_sha: 'abc', tasks: [t] },
    issues: [issue(t, 4, 'ready')], status: { canonical }, desiredProvider: 'claude', mainCi: 'green' });
  assert.equal(actions.some((action) => action.type === 'fire'), false);
  assert.match(actions[0].text, /budget/);
});

test('a lower per-goal invocation budget is enforced for bounded live experiments', () => {
  const t = task('G1-T1', 'Task');
  const canonical = emptyFactoryState();
  canonical.provider.active = 'codex';
  canonical.invocations = Array.from({ length: 4 }, (_, index) => ({ id: `inv_${index}`, status: 'completed' }));
  const actions = decide({ now: 1, goalsSha: 'abc', goalIds: ['G1'], plan: { goals_sha: 'abc', tasks: [t] },
    issues: [issue(t, 4, 'ready')], status: { canonical }, desiredProvider: 'codex', invocationLimit: 4, mainCi: 'green' });
  assert.equal(actions.some((action) => action.type === 'fire'), false);
  assert.match(actions[0].text, /budget of 4/);
});

test('a bounded live experiment rejects a planner that exceeds its task cap', () => {
  const snapshot = makeGoalSnapshot({ number: 7, title: 'Goal', body: '## G1: Product' });
  const plan = planFor(snapshot);
  plan.tasks.push(task('G1-T3', 'Unexpected third task', ['G1-T2']));
  const actions = decide({ now: 1, goalSnapshot: snapshot, goalIds: [], plan, taskLimit: 2, issues: [],
    status: { plannerFiredSha: snapshot.hash, plannerFiredAt: 0, plannerFires: 1, canonical: emptyFactoryState() }, mainCi: 'green' });
  assert.match(actions[0].text, /task limit of 2/);
  assert.equal(actions.some((action) => action.type === 'create'), false);
});

test('an offline queued Codex workflow preserves its lease instead of spending a new invocation', () => {
  const t = task('G1-T1', 'Task');
  const canonical = emptyFactoryState();
  canonical.provider.active = 'codex';
  const leased = issue(t, 4, 'in-progress', { meta: { id: t.id, hash: taskHash(t), attempt: 1, tries: 1, leaseAt: 1 } });
  const actions = decide({ now: LIMITS.maxLeaseMs + 100, goalsSha: 'abc', goalIds: ['G1'], plan: { goals_sha: 'abc', tasks: [t] },
    issues: [leased], status: { canonical }, desiredProvider: 'codex', mainCi: 'green',
    activeAgentInvocations: [{ id: 'inv_1', role: 'worker', task_id: t.id }] });
  assert.deepEqual(actions, []);
});

test('high-impact architecture decisions require an owner-authenticated approval record', () => {
  const snapshot = makeGoalSnapshot({ number: 7, title: 'Goal', body: '## G1: App' });
  const plan = planFor(snapshot);
  plan.decisions[0].requires_human_approval = true;
  const canonical = emptyFactoryState();
  const base = { now: 1, goalSnapshot: snapshot, goalIds: [], plan, issues: [], status: { canonical }, mainCi: 'green', mainChecks: {} };
  assert.match(decide(base)[0].text, /Human architecture approval required/);
  const planHash = planVersionHash(plan);
  assert.deepEqual(decide({ ...base, decisionApprovals: [{ id: 'ADR-001', plan_hash: planHash }] }), [{ type: 'record-decision-approvals', planHash, decisions: ['ADR-001'] }]);
  canonical.decisions['plan:ADR-001'] = { id: 'plan:ADR-001', status: 'approved', plan_hash: planHash };
  assert.equal(decide(base)[0].type, 'create');
});

test('duplicate goal events snapshot once and never create duplicate task ownership', () => {
  const candidate = { number: 8, title: 'Idempotent goal', body: '## G1: Product' };
  const snapshot = makeGoalSnapshot(candidate);
  const state = {
    now: 1, goalsSha: null, goalIds: [], goalCandidate: candidate, goalSnapshot: null,
    plan: null, issues: [], status: { plannerFiredSha: null, plannerFiredAt: 0, plannerFires: 0 }, mainCi: 'green',
  };
  assert.deepEqual(decide(state), [{ type: 'snapshot-goal', issue: 8 }]);
  const resumed = { ...state, goalSnapshot: snapshot, goalCandidate: candidate };
  assert.notEqual(decide(resumed)[0].type, 'snapshot-goal');
});

test('/goal issue intake is idempotent and records explicit provider before snapshot', () => {
  const candidate = { number: 9, title: '/goal codex Build app', body: '## G1: App', needsIntake: true, requestedProvider: 'codex' };
  const state = { now: 1, goalsSha: null, goalIds: [], goalCandidate: candidate, goalSnapshot: null,
    plan: null, issues: [], status: { canonical: emptyFactoryState() }, mainCi: 'green' };
  assert.deepEqual(decide(state), [{ type: 'intake-goal', issue: 9, provider: 'codex' }]);
  candidate.needsIntake = false;
  assert.deepEqual(decide(state), [{ type: 'snapshot-goal', issue: 9 }]);
});
