import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyFactoryState } from './state.mjs';
import { renderProjectReport } from './report.mjs';

test('project report answers status and audit questions from canonical records', () => {
  const state = emptyFactoryState();
  state.goal = { issue: 7, title: 'Build exporter', hash: 'goal-v1' };
  state.provider.active = 'codex';
  state.plan = { architecture: { components: ['web', 'cost engine'] }, assumptions: ['one'], constraints: ['offline'], decisions: [{ id: 'ADR-1', requires_human_approval: true }] };
  state.tasks = { 'G1-T1': { id: 'G1-T1', status: 'done', attempt: 1 }, 'G1-T2': { id: 'G1-T2', status: 'needs-human', attempt: 2, last_reason: 'ambiguous requirement' } };
  state.findings = { 'FINAL-1': { id: 'FINAL-1', severity: 'blocking', status: 'open', affected_commit: 'm1' } };
  state.completion = { status: 'blocked', missing: ['final review'] };
  const report = renderProjectReport(state, { now: 0, notes: ['owner decision required'] });
  for (const value of ['Build exporter', 'goal-v1', 'codex', 'cost engine', 'ADR-1', 'G1-T2', 'ambiguous requirement', 'FINAL-1', 'm1', 'final review', 'owner decision required']) assert.match(report, new RegExp(value));
});
