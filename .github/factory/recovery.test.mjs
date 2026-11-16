import test from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_TRANSPORT_LIMITS, approveExactCommit, reconcileAgentExecution, reconcileAttempt, reconcileMerge, reconcileReview, reconcileTaskCreation } from './recovery.mjs';
import { decide } from './lib.mjs';

test('task creation resumes safely after crashes before and after GitHub side effects', () => {
  const pending = { status: 'pending', started_at: 1000 };
  assert.equal(reconcileTaskCreation(pending, [], 2000).action, 'wait');
  assert.deepEqual(reconcileTaskCreation(pending, [{ number: 14 }], 2000), { action: 'complete', issue: 14 });
  assert.equal(reconcileTaskCreation(pending, [], 1000 + 11 * 60_000).action, 'retry');
  assert.equal(reconcileTaskCreation(pending, [{ number: 14 }, { number: 15 }], 2000).action, 'needs-human');
});

test('a PR created before dispatcher state was recorded is adopted by branch attempt', () => {
  assert.equal(reconcileAttempt(2, [{ number: 9, attempt: 2, state: 'open' }]).pullRequest.number, 9);
  assert.equal(reconcileAttempt(2, [{ number: 9, attempt: 2, state: 'closed', merged_at: 'now' }]).pullRequest.number, 9);
  assert.equal(reconcileAttempt(2, [{ number: 8, attempt: 1, state: 'open' }]).action, 'wait');
  assert.equal(reconcileAttempt(2, [{ number: 9, attempt: 2, state: 'open' }, { number: 10, attempt: 2, state: 'open' }]).action, 'needs-human');
});

test('unknown merge outcomes retry only when GitHub proves the merge did not happen', () => {
  assert.equal(reconcileMerge({ state: 'open', merged_at: null, head: { sha: 'h1' } }, 'h1').action, 'retry');
  assert.equal(reconcileMerge({ state: 'closed', merged_at: 'now', head: { sha: 'h1' } }, 'h1').action, 'complete');
  assert.equal(reconcileMerge({ state: 'open', merged_at: null, head: { sha: 'h2' } }, 'h1').action, 'needs-human');
  assert.equal(reconcileMerge({ state: 'closed', merged_at: null, head: { sha: 'h1' } }, 'h1').action, 'needs-human');
});

test('partial reviews resume only for the leased exact SHA and timestamp', () => {
  const lease = { reviewSha: 'h1', reviewAt: 1000 };
  const pr = { state: 'open', headSha: 'h1' };
  assert.equal(reconcileReview(lease, pr, null).action, 'wait');
  assert.equal(reconcileReview(lease, pr, { sha: 'h1', at: 1100, verdict: 'approve' }).action, 'complete');
  assert.equal(reconcileReview(lease, { ...pr, headSha: 'h2' }, null).action, 'retry-worker');
  assert.equal(reconcileReview(lease, pr, { invalid: 'unauthorized' }).action, 'needs-human');
});

test('Codex workflow recovery waits for active runs, retries canceled runs and is bounded', () => {
  const invocation = { id: 'inv_1', status: 'accepted', started_at: 1, last_dispatch_at: 1, transport_attempts: 1 };
  const active = [{ display_title: 'codex-inv_1', status: 'queued', created_at: new Date(2).toISOString() }];
  assert.equal(reconcileAgentExecution(invocation, active, 1_000_000).action, 'wait');
  const canceled = [{ display_title: 'codex-inv_1', status: 'completed', conclusion: 'cancelled', created_at: new Date(2).toISOString(), updated_at: new Date(3).toISOString() }];
  assert.equal(reconcileAgentExecution(invocation, canceled, 1_000_000).action, 'retry');
  assert.equal(reconcileAgentExecution({ ...invocation, transport_attempts: 3 }, canceled, 1_000_000).action, 'needs-human');
  assert.equal(reconcileAgentExecution({ ...invocation, result_digest: 'done' }, canceled, 1_000_000).action, 'complete');
});

test('dispatcher prioritizes durable operation recovery after restart', () => {
  const state = { now: 1, goalsSha: 'g', goalIds: ['G1'], plan: null, issues: [],
    status: { canonical: { provider: { active: 'claude' } } },
    operationRecoveries: [{ id: 'create:G1-T1', type: 'create-task', issue: 14 }], mainCi: 'green' };
  assert.deepEqual(decide(state), [{ type: 'recover-operations', operations: state.operationRecoveries }]);
});

const MINUTE = 60_000;
const at = (ms) => new Date(ms).toISOString();
const codexRun = (id, created, extra = {}) => ({ id, display_title: 'codex-inv_2', status: 'in_progress', created_at: at(created), updated_at: at(created), ...extra });
const job = (name, status, extra = {}) => ({ name, status, conclusion: status === 'completed' ? 'success' : null, ...extra });
const pending = { id: 'inv_2', status: 'accepted', started_at: 0, last_dispatch_at: 0, transport_attempts: 1 };

test('an offline self-hosted runner is cancelled after the bounded queue window, never waited on for 24 hours', () => {
  const { queueWindowMs, graceMs } = CODEX_TRANSPORT_LIMITS;
  const runs = [codexRun(41, 0)];
  const jobsByRun = { 41: [job('prepare', 'completed'), job('execute', 'queued')] };
  assert.equal(reconcileAgentExecution(pending, runs, queueWindowMs, { jobsByRun }).action, 'wait');
  const stale = reconcileAgentExecution(pending, runs, queueWindowMs + graceMs + 1, { jobsByRun });
  assert.equal(stale.action, 'cancel');
  assert.deepEqual(stale.runs, [41]);
  assert.match(stale.reason, /runner/);
});

test('a running execution is never preempted inside its timeout, and a hung one is cancelled after it', () => {
  const { executeTimeoutMs, graceMs, queueWindowMs } = CODEX_TRANSPORT_LIMITS;
  const runs = [codexRun(42, 0)];
  const startedAt = queueWindowMs - MINUTE;
  const jobsByRun = { 42: [job('prepare', 'completed'), job('execute', 'in_progress', { started_at: at(startedAt) })] };
  assert.equal(reconcileAgentExecution(pending, runs, startedAt + executeTimeoutMs, { jobsByRun }).action, 'wait');
  assert.equal(reconcileAgentExecution(pending, runs, startedAt + executeTimeoutMs + graceMs + 1, { jobsByRun }).action, 'cancel');
});

test('a requested cancellation is not repeated and becomes a human decision if GitHub never honours it', () => {
  const { queueWindowMs, graceMs } = CODEX_TRANSPORT_LIMITS;
  const runs = [codexRun(43, 0)];
  const jobsByRun = { 43: [job('execute', 'queued')] };
  const cancelledAt = queueWindowMs + graceMs + 1;
  const record = { ...pending, cancelled_runs: [{ id: 43, at: cancelledAt }] };
  assert.equal(reconcileAgentExecution(record, runs, cancelledAt + MINUTE, { jobsByRun }).action, 'wait');
  assert.equal(reconcileAgentExecution(record, runs, cancelledAt + 2 * graceMs + 1, { jobsByRun }).action, 'needs-human');
});

test('a run whose execution failed before publication is retried promptly even while its reconcile job is still running', () => {
  const { resultSettleMs } = CODEX_TRANSPORT_LIMITS;
  const done = 10 * MINUTE;
  const runs = [codexRun(44, 0)];
  const jobsByRun = { 44: [
    job('prepare', 'completed', { completed_at: at(MINUTE) }),
    job('execute', 'completed', { conclusion: 'failure', completed_at: at(done) }),
    job('publish', 'completed', { conclusion: 'skipped', completed_at: at(done) }),
    job('reconcile', 'in_progress'),
  ] };
  assert.equal(reconcileAgentExecution(pending, runs, done + resultSettleMs - 1, { jobsByRun }).action, 'wait');
  assert.equal(reconcileAgentExecution(pending, runs, done + resultSettleMs + 1, { jobsByRun }).action, 'retry');
});

test('a fresh transport retry is not redispatched again before GitHub lists its new run', () => {
  const { dispatchSettleMs } = CODEX_TRANSPORT_LIMITS;
  const oldRun = codexRun(45, 0, { status: 'completed', conclusion: 'cancelled', updated_at: at(MINUTE) });
  const redispatchedAt = 60 * MINUTE;
  const record = { ...pending, transport_attempts: 2, last_dispatch_at: redispatchedAt };
  assert.equal(reconcileAgentExecution(record, [oldRun], redispatchedAt + MINUTE).action, 'wait');
  assert.equal(reconcileAgentExecution(record, [oldRun], redispatchedAt + dispatchSettleMs + 1).action, 'retry');
  assert.equal(reconcileAgentExecution({ ...record, transport_attempts: 3 }, [oldRun], redispatchedAt + dispatchSettleMs + 1).action, 'needs-human');
});

test('an older still-active run of the same invocation is cancelled rather than allowed to execute beside a newer dispatch', () => {
  const { queueWindowMs, graceMs } = CODEX_TRANSPORT_LIMITS;
  const now = 2 * (queueWindowMs + graceMs);
  const record = { ...pending, transport_attempts: 2, last_dispatch_at: now - MINUTE };
  const runs = [codexRun(46, 0), codexRun(47, now - MINUTE, { status: 'queued' })];
  const jobsByRun = { 46: [job('execute', 'queued')], 47: [] };
  const decision = reconcileAgentExecution(record, runs, now, { jobsByRun });
  assert.equal(decision.action, 'cancel');
  assert.deepEqual(decision.runs, [46]);
});

test('dispatcher cancels stale Codex runs before any transport retry', () => {
  const state = { now: 1, goalsSha: 'g', goalIds: ['G1'], plan: null, issues: [],
    status: { canonical: { provider: { active: 'codex' } } },
    agentCancellations: [{ invocation: 'inv_2', runs: [41], reason: 'offline' }],
    agentRecoveries: [{ invocation: { id: 'inv_3' }, reason: 'missing' }], mainCi: 'green' };
  assert.deepEqual(decide(state), [{ type: 'cancel-agent-runs', cancellations: state.agentCancellations }]);
});

test('a successful execution whose publish job is still queued is not cancelled', () => {
  const { publishTimeoutMs, graceMs } = CODEX_TRANSPORT_LIMITS;
  const executed = 40 * MINUTE;
  const runs = [codexRun(48, 0)];
  const jobsByRun = { 48: [job('prepare', 'completed'), job('execute', 'completed', { completed_at: at(executed) }), job('publish', 'queued')] };
  assert.equal(reconcileAgentExecution(pending, runs, executed + MINUTE, { jobsByRun }).action, 'wait');
  assert.equal(reconcileAgentExecution(pending, runs, executed + publishTimeoutMs + graceMs + 1, { jobsByRun }).action, 'cancel');
});

test('the dispatcher approves exactly the reviewed commit before merging, once', async () => {
  const calls = [];
  const reviews = [];
  const gh = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    if (method === 'GET') return reviews;
    const review = { user: { login: 'github-actions[bot]' }, state: 'APPROVED', commit_id: body.commit_id };
    reviews.push(review);
    return review;
  };
  assert.equal(await approveExactCommit(gh, '/repos/o/r', 9, 'h1', 'github-actions[bot]', 'owner'), 'approved');
  assert.deepEqual(reviews.map((review) => review.commit_id), ['h1']);
  assert.equal(await approveExactCommit(gh, '/repos/o/r', 9, 'h1', 'github-actions[bot]', 'owner'), 'already-approved');
  assert.equal(calls.filter((call) => call.startsWith('POST')).length, 1);
  // An approval of an older head does not count for the new one.
  assert.equal(await approveExactCommit(gh, '/repos/o/r', 9, 'h2', 'github-actions[bot]', 'owner'), 'approved');
});

test('self-approval and unavailable Actions approval fail closed before merge', async () => {
  let called = 0;
  const untouched = async () => { called++; return []; };
  assert.equal(await approveExactCommit(untouched, '/repos/o/r', 9, 'h1', 'github-actions[bot]', 'github-actions[bot]'), 'self-approval');
  assert.equal(called, 0);
  const gh = async (method) => {
    if (method === 'GET') return [];
    throw new Error('POST /repos/o/r/pulls/9/reviews: 422 GitHub Actions is not permitted to approve pull requests.');
  };
  assert.equal(await approveExactCommit(gh, '/repos/o/r', 9, 'h1', 'github-actions[bot]', 'owner'), 'not-permitted');
});
