import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEvent, emptyFactoryState, migrateFactoryState, parseEventComments, parseFactoryState,
  prepareEvent, recordFinding, recordInvocation, recordOperation, recoverFactoryState,
  renderEvent, stateDiff, statusSummary, withFactoryState,
} from './state.mjs';

const comment = (event, id = event.seq, author = 'github-actions[bot]') => ({
  id, body: renderEvent(event), user: { login: author }, created_at: new Date(event.at).toISOString(),
});

test('event-first persistence recovers a committed update after snapshot materialization crashes', () => {
  const snapshot = emptyFactoryState();
  const draft = { ...snapshot, goal: { issue: 10, title: 'Goal', body: '## G1: App', hash: 'g1' } };
  const event = prepareEvent(snapshot, 'goal-snapshotted', { issue: 10 }, stateDiff(snapshot, draft), 1000);
  const recovered = recoverFactoryState(snapshot, parseEventComments([comment(event)], 'github-actions[bot]'));
  assert.equal(recovered.ambiguous, false);
  assert.equal(recovered.state.goal.issue, 10);
  assert.equal(recovered.state.journal.head, event.id);
  assert.equal(recovered.state.revision, 1);
});

test('materialized state survives restart and duplicate event delivery without repeating work', () => {
  const start = emptyFactoryState();
  const draft = recordOperation(start, { id: 'create:G1-T1', type: 'create-task', status: 'completed', issue: 12 });
  const event = prepareEvent(start, 'operation-completed', { id: 'create:G1-T1' }, stateDiff(start, draft), 1000);
  const materialized = applyEvent(start, { ...event, comment_id: 1 });
  const restarted = parseFactoryState(withFactoryState('Status', materialized));
  const recovered = recoverFactoryState(restarted, parseEventComments([comment(event), comment(event, 2)], 'github-actions[bot]'));
  assert.equal(recovered.ambiguous, false);
  assert.equal(recovered.state.operations['create:G1-T1'].issue, 12);
  assert.equal(recovered.state.journal.count, 1);
});

test('forks, missing history and unauthorized journal comments fail closed', () => {
  const start = emptyFactoryState();
  const a = prepareEvent(start, 'a', {}, { completion: { status: 'running', missing: ['a'] } }, 1000);
  const b = prepareEvent(start, 'b', {}, { completion: { status: 'running', missing: ['b'] } }, 1001);
  assert.match(recoverFactoryState(start, parseEventComments([comment(a), comment(b)], 'github-actions[bot]')).error, /fork/);

  const one = applyEvent(start, a);
  const two = prepareEvent(one, 'two', {}, {}, 2000);
  assert.match(recoverFactoryState(one, parseEventComments([comment(two)], 'github-actions[bot]')).error, /missing sequence 1/);
  const ignored = parseEventComments([comment(a, 1, 'attacker')], 'github-actions[bot]');
  assert.deepEqual(ignored, []);
});

test('tampered event hashes are rejected and create a detectable history gap', () => {
  const start = emptyFactoryState();
  const event = prepareEvent(start, 'safe', {}, {}, 1000);
  const bad = { ...event, payload: { changed: true } };
  assert.deepEqual(parseEventComments([{ id: 1, body: `<!-- factory-event ${JSON.stringify(bad)} -->`, user: { login: 'github-actions[bot]' } }], 'github-actions[bot]'), []);
  const snapshot = applyEvent(start, event);
  assert.match(recoverFactoryState(snapshot, []).error, /missing sequence/);
});

test('audit findings, operations and invocation identity survive serialization', () => {
  let state = emptyFactoryState();
  state = recordInvocation(state, { id: 'inv_1', role: 'worker', provider: 'codex', status: 'completed' });
  state = recordInvocation(state, { id: 'inv_1', role: 'worker', provider: 'codex', status: 'completed' });
  state = recordOperation(state, { id: 'merge:9:h1', type: 'merge', status: 'pending' });
  state = recordFinding(state, { id: 'REV-1', severity: 'blocking', affected_commit: 'c1', status: 'open' });
  state = recordFinding(state, { id: 'REV-1', severity: 'blocking', affected_commit: 'c2', status: 'verified' });
  const restarted = parseFactoryState(withFactoryState('Status report', state));
  assert.equal(restarted.invocations.length, 1);
  assert.equal(restarted.operations['merge:9:h1'].status, 'pending');
  assert.equal(restarted.findings['REV-1'].history.length, 2);
  assert.equal('history' in restarted.findings['REV-1'].history[1], false);
  assert.equal(statusSummary(restarted).findings.verified, 1);
});

test('v1 state migrates without becoming a second source of truth', () => {
  const migrated = migrateFactoryState({ version: 1, goal: { issue: 1 }, tasks: {}, findings: {}, invocations: [], decisions: [], completion: { status: 'running', missing: [] } });
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.operations, {});
  assert.equal(migrated.migration.from, 1);
});

test('malformed, unsupported and over-sized snapshots fail safely', () => {
  assert.equal(parseFactoryState('<!-- factory-state {"version":99} -->'), null);
  assert.equal(parseFactoryState('<!-- factory-state not-json -->'), null);
  const huge = { ...emptyFactoryState(), plan: { content: 'x'.repeat(60 * 1024) } };
  assert.throws(() => withFactoryState('Status', huge), /limit/);
});
