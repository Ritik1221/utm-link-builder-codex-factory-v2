import assert from 'node:assert/strict';
import test from 'node:test';
import { requiredChecksState } from './lib.mjs';
import { mergeExactSha, transientMergeReadinessFailure } from './merge.mjs';

const SHA = 'a'.repeat(40);
const run = (name, over = {}) => ({
  name, app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success', ...over,
});
const pull = (over = {}) => ({ state: 'open', merged_at: null, head: { sha: SHA }, base: { ref: 'main' }, ...over });

test('duplicate required checks stay pending until every run completes successfully', () => {
  assert.equal(requiredChecksState([run('ci'), run('e2e'), run('e2e', { status: 'in_progress', conclusion: null })]), 'pending');
  assert.equal(requiredChecksState([run('ci'), run('ci'), run('e2e'), run('e2e')]), 'green');
  assert.equal(requiredChecksState([run('ci'), run('e2e'), run('e2e', { conclusion: 'failure' })]), 'red');
  assert.equal(requiredChecksState([run('ci')]), 'pending');
});

test('merge is never attempted while any duplicate required check is pending', async () => {
  let mergeCalls = 0;
  let sleeps = 0;
  const gh = async (method, path) => {
    if (path.includes('/pulls/')) return pull();
    if (path.includes('/check-runs')) return { check_runs: [run('ci'), run('e2e'), run('e2e', { status: 'in_progress', conclusion: null })] };
    if (method === 'PUT') mergeCalls += 1;
    throw new Error(`unexpected ${method} ${path}`);
  };
  await assert.rejects(
    mergeExactSha({ gh, repositoryPath: '/repos/o/r', pullNumber: 2, sha: SHA, attempts: 3, sleep: async () => { sleeps += 1; } }),
    /required checks remain pending.*attempt 3\/3/,
  );
  assert.equal(mergeCalls, 0);
  assert.equal(sleeps, 2);
});

test('transient protected-merge readiness failures retry within the bound', async () => {
  let mergeCalls = 0;
  const gh = async (method, path) => {
    if (method === 'GET' && path.includes('/pulls/')) return pull();
    if (path.includes('/check-runs')) return { check_runs: [run('ci'), run('e2e')] };
    if (method === 'PUT') {
      mergeCalls += 1;
      if (mergeCalls < 3) throw new Error('PUT /merge: 405 Required status check "e2e" is in progress.');
      return { merged: true, sha: 'b'.repeat(40) };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const result = await mergeExactSha({ gh, repositoryPath: '/repos/o/r', pullNumber: 2, sha: SHA, attempts: 3, sleep: async () => {} });
  assert.equal(result.merged, true);
  assert.equal(mergeCalls, 3);
});

test('persistent transient failures stop after exactly three merge attempts', async () => {
  let mergeCalls = 0;
  const gh = async (method, path) => {
    if (method === 'GET' && path.includes('/pulls/')) return pull();
    if (path.includes('/check-runs')) return { check_runs: [run('ci'), run('e2e')] };
    if (method === 'PUT') {
      mergeCalls += 1;
      throw new Error('PUT /merge: 405 Required status check "e2e" is in progress.');
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  await assert.rejects(
    mergeExactSha({ gh, repositoryPath: '/repos/o/r', pullNumber: 2, sha: SHA, attempts: 3, sleep: async () => {} }),
    /405 Required status check/,
  );
  assert.equal(mergeCalls, 3);
});

test('changed heads and non-readiness errors fail closed without retrying merge', async () => {
  let mergeCalls = 0;
  await assert.rejects(
    mergeExactSha({
      gh: async (method) => {
        if (method === 'GET') return pull({ head: { sha: 'c'.repeat(40) } });
        mergeCalls += 1;
      },
      repositoryPath: '/repos/o/r', pullNumber: 2, sha: SHA, sleep: async () => {},
    }),
    /head changed/,
  );
  assert.equal(mergeCalls, 0);
  assert.equal(transientMergeReadinessFailure(new Error('PUT /merge: 403 review required')), false);
});
