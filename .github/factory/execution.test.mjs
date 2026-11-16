import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  applyChangeSet, createChangeSet, makeExecutionResult, parseAgentResultReceipts,
  renderAgentResultReceipt, sourceManifest, validateExecutionResult,
} from './execution.mjs';
import { makeInvocation } from './providers/contract.mjs';
import { recoverInvocation } from './runner/prepare-codex-job.mjs';
import { publicationExitCode, publishCodexResult, reconcileReceipt, validatePublishableResult } from './runner/publish-codex-result.mjs';
import { emptyFactoryState, prepareEvent, renderEvent, withFactoryState } from './state.mjs';
import { restrictedEnvironment, runCodexCli } from './runner/codex-cli.mjs';
import { packageCodexInput, validateDispatchDeadline } from './runner/prepare-codex-job.mjs';
import { classifyCodexFailure, executeCodexJob, isChatGptSubscriptionAuth } from './runner/execute-codex-job.mjs';

const invocation = (role = 'worker', extra = {}) => makeInvocation({
  goal_id: 'G1', goal_version: 'goal-version', role, provider: 'codex', repository: 'owner/repo',
  base_sha: 'a'.repeat(40), task_id: ['worker', 'corrective-worker', 'reviewer'].includes(role) ? 'G1-T1' : null,
  issue: 3, pull_request: role === 'reviewer' ? 9 : null, attempt: 1, timeout_ms: 60_000, retry_budget: 2,
  immutable_context: {}, output_schema: { type: 'object' }, ...extra,
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-execution-'));
  const original = path.join(root, 'original');
  const working = path.join(root, 'working');
  await mkdir(path.join(original, 'src'), { recursive: true });
  await mkdir(path.join(working, 'src'), { recursive: true });
  await writeFile(path.join(original, 'src/app.js'), 'export const value = 1;\n');
  await writeFile(path.join(working, 'src/app.js'), 'export const value = 2;\n');
  return { root, original, working };
}

test('credential isolation strips repository and paid API credentials from the Codex child', () => {
  const env = restrictedEnvironment({ PATH: '/bin', HOME: '/Users/factory-codex', CODEX_HOME: '/Users/factory-codex/.codex', GITHUB_TOKEN: 'repo-write', ACTIONS_RUNTIME_TOKEN: 'artifact', OPENAI_API_KEY: 'paid', ANTHROPIC_API_KEY: 'paid' });
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.ACTIONS_RUNTIME_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CODEX_HOME, '/Users/factory-codex/.codex');
});

test('Codex authentication, quota and timeout failures are classified without fallback', () => {
  assert.equal(classifyCodexFailure({ status: 'failed', stderr: 'login required' }), 'unauthorized');
  assert.equal(classifyCodexFailure({ status: 'failed', stderr: 'usage limit reached' }), 'quota-exhausted');
  assert.equal(classifyCodexFailure({ status: 'timeout' }), 'timeout');
  assert.equal(classifyCodexFailure({ status: 'unavailable' }), 'unavailable');
  assert.equal(isChatGptSubscriptionAuth({ code: 0, stdout: 'Logged in using ChatGPT' }), true);
  assert.equal(isChatGptSubscriptionAuth({ code: 0, stdout: 'Logged in using an API key' }), false);
});

test('snapshot manifests exclude .git and reject symbolic links', async () => {
  const { root, original } = await fixture();
  try {
    await mkdir(path.join(original, '.git'));
    await writeFile(path.join(original, '.git/config'), 'credential=secret');
    const manifest = await sourceManifest(original);
    assert.equal(manifest.files.some((file) => file.path.startsWith('.git')), false);
    const invocationPath = path.join(root, 'invocation.json');
    const packed = path.join(root, 'packed');
    await writeFile(invocationPath, JSON.stringify(invocation()));
    await packageCodexInput({ invocationPath, sourceRoot: original, outputRoot: packed, notAfter: Date.now() + 60_000 });
    const listing = spawnSync('tar', ['-tf', path.join(packed, 'source.tar')], { encoding: 'utf8' });
    assert.equal(listing.status, 0);
    assert.doesNotMatch(listing.stdout, /\.git/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bounded change sets apply only to the exact original content', async () => {
  const { root, original, working } = await fixture();
  const target = path.join(root, 'target');
  try {
    await mkdir(path.join(target, 'src'), { recursive: true });
    await writeFile(path.join(target, 'src/app.js'), 'export const value = 1;\n');
    const inv = invocation();
    const source = await sourceManifest(original);
    const changes = await createChangeSet(original, working, inv.role);
    const result = makeExecutionResult(inv, source, { status: 'completed', input_digest: 'input-1', output: { status: 'completed', summary: 'changed', tests: ['npm test'] }, changes });
    assert.deepEqual(validateExecutionResult(result, inv, source.sha256, 'input-1'), []);
    await applyChangeSet(target, result, inv);
    assert.match(await readFile(path.join(target, 'src/app.js'), 'utf8'), /value = 2/);
    await assert.rejects(() => applyChangeSet(target, result, inv), /base content changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('artifact tampering and protected-path changes fail closed', async () => {
  const { root, original, working } = await fixture();
  try {
    const inv = invocation();
    const source = await sourceManifest(original);
    const changes = await createChangeSet(original, working, inv.role);
    const result = makeExecutionResult(inv, source, { status: 'completed', input_digest: 'input-1', output: { status: 'completed', summary: 'ok', tests: [] }, changes });
    result.changes.changes[0].content_base64 = Buffer.from('malicious').toString('base64');
    assert.match(validateExecutionResult(result, inv, source.sha256, 'input-1').join(';'), /digest|content hash/);
    await mkdir(path.join(working, '.github'), { recursive: true });
    await writeFile(path.join(working, '.github/workflows.yml'), 'bad');
    await assert.rejects(() => createChangeSet(original, working, inv.role), /may not change/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('journaled invocation survives restart and a newer invocation supersedes delayed work', () => {
  const inv = invocation();
  const state = emptyFactoryState();
  const record = { id: inv.id, provider: inv.provider, role: inv.role, task_id: inv.task_id, status: 'accepted', started_at: 10 };
  const event = prepareEvent(state, 'agent-dispatching', { invocation: inv }, { invocations: [record] }, 10);
  const comment = { id: 1, body: renderEvent(event), created_at: new Date(10).toISOString(), user: { login: 'github-actions[bot]' } };
  const body = withFactoryState('status', state);
  assert.equal(recoverInvocation(body, [comment], inv.id, 'github-actions[bot]').invocation.id, inv.id);

  const newer = invocation('worker', { attempt: 2 });
  const firstState = { ...state, invocations: [record], revision: 1, journal: { count: 1, head: event.id, last_comment_id: 1 } };
  const newerRecord = { id: newer.id, provider: newer.provider, role: newer.role, task_id: newer.task_id, status: 'accepted', started_at: 20 };
  const event2 = prepareEvent(firstState, 'agent-dispatching', { invocation: newer }, { invocations: [record, newerRecord] }, 20);
  const comment2 = { id: 2, body: renderEvent(event2), created_at: new Date(20).toISOString(), user: { login: 'github-actions[bot]' } };
  assert.throws(() => recoverInvocation(body, [comment, comment2], inv.id, 'github-actions[bot]'), /superseded/);
});

test('duplicate result delivery is idempotent and conflicting delivery needs a human', () => {
  const result = { invocation_id: 'inv_1', digest: 'digest-1', status: 'completed' };
  const receipt = { ...result, role: 'worker' };
  const comments = [{ id: 1, created_at: new Date().toISOString(), user: { login: 'github-actions[bot]' }, body: renderAgentResultReceipt(receipt) }];
  const parsed = parseAgentResultReceipts(comments, 'github-actions[bot]');
  assert.equal(reconcileReceipt(parsed, result).action, 'complete');
  assert.equal(reconcileReceipt([...parsed, { ...parsed[0], digest: 'other' }], result).action, 'needs-human');
  assert.equal(parseAgentResultReceipts(comments, 'reviewer')[0], undefined);
});

test('trusted publisher rejects a planner whose file differs from its structured hash', () => {
  const goal = { issue: 1, title: 'Goal', body: '## G1: App', hash: 'goal-version' };
  const inv = invocation('planner', { immutable_context: { goal } });
  const input = { digest: 'input-1', source_manifest: { sha256: 'source-1' } };
  const plan = { goals_sha: 'goal-version', goal_snapshot_sha: 'goal-version', tasks: [] };
  const base = { version: 1, source_manifest_sha256: 'source-1', bytes: 2, changes: [{ path: 'factory/plan.json', operation: 'write', before_sha256: null, after_sha256: 'x', mode: 0o644, content_base64: Buffer.from('{}').toString('base64') }] };
  const result = makeExecutionResult(inv, { sha256: 'source-1' }, { status: 'completed', input_digest: input.digest, output: { status: 'completed', summary: 'plan', plan_sha256: '0'.repeat(64) }, changes: base });
  assert.ok(validatePublishableResult(result, inv, input).length > 0);
});

test('completed runner results survive restart and are redelivered without a second Codex call', async () => {
  const { root, original } = await fixture();
  const bin = path.join(root, 'bin');
  const inputRoot = path.join(root, 'input');
  const resultOne = path.join(root, 'result-one');
  const resultTwo = path.join(root, 'result-two');
  const jobs = path.join(root, 'jobs');
  const ledger = path.join(root, 'ledger');
  const counter = path.join(root, 'calls');
  const invocationPath = path.join(root, 'invocation.json');
  try {
    await mkdir(bin);
    const inv = invocation();
    await writeFile(invocationPath, JSON.stringify(inv));
    await packageCodexInput({ invocationPath, sourceRoot: original, outputRoot: inputRoot, notAfter: Date.now() + 60_000 });
    const fake = `#!/bin/sh
if [ "$1" = login ]; then echo 'Logged in using ChatGPT'; exit 0; fi
output=""
workspace=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output-last-message ]; then shift; output="$1"; fi
  if [ "$1" = --cd ]; then shift; workspace="$1"; fi
  shift
done
echo call >> ${JSON.stringify(counter)}
printf 'export const value = 9;\\n' > "$workspace/src/app.js"
printf '%s' '{"status":"completed","summary":"implemented","tests":["npm test"]}' > "$output"
printf '%s\\n' '{"usage":{"input_tokens":10,"output_tokens":5}}'
`;
    await writeFile(path.join(bin, 'codex'), fake);
    await chmod(path.join(bin, 'codex'), 0o755);
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: root, CODEX_HOME: path.join(root, '.codex') };
    const first = await executeCodexJob({ inputRoot, resultRoot: resultOne, agentRoot: jobs, ledgerRoot: ledger, env });
    const second = await executeCodexJob({ inputRoot, resultRoot: resultTwo, agentRoot: jobs, ledgerRoot: ledger, env });
    assert.equal(first.digest, second.digest);
    assert.equal((await readFile(counter, 'utf8')).trim().split(/\n/).length, 1);
    assert.equal(JSON.parse(await readFile(path.join(resultTwo, 'result.json'), 'utf8')).invocation_id, inv.id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a durable atomic claim permits at most one Codex start for an invocation, including after a crash', async () => {
  const { root, original } = await fixture();
  const bin = path.join(root, 'bin');
  const inputRoot = path.join(root, 'input');
  const jobs = path.join(root, 'jobs');
  const ledger = path.join(root, 'ledger');
  const invocationPath = path.join(root, 'invocation.json');
  try {
    await mkdir(bin);
    await writeFile(path.join(bin, 'codex'), '#!/bin/sh\necho "Logged in using ChatGPT"\nexit 0\n');
    await chmod(path.join(bin, 'codex'), 0o755);
    await writeFile(invocationPath, JSON.stringify(invocation()));
    await packageCodexInput({ invocationPath, sourceRoot: original, outputRoot: inputRoot, notAfter: Date.now() + 60_000 });
    let calls = 0;
    const crashing = async () => { calls++; throw new Error('simulated process crash'); };
    const common = { inputRoot, agentRoot: jobs, ledgerRoot: ledger, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, CODEX_HOME: path.join(root, '.codex') }, runCli: crashing };
    await assert.rejects(() => executeCodexJob({ ...common, resultRoot: path.join(root, 'r1') }), /simulated process crash/);
    const bounded = await executeCodexJob({ ...common, resultRoot: path.join(root, 'r2') });
    assert.equal(bounded.error.code, 'local-attempt-limit');
    const redelivered = await executeCodexJob({ ...common, resultRoot: path.join(root, 'r3') });
    assert.equal(redelivered.digest, bounded.digest);
    assert.equal(calls, 1);
    const claim = JSON.parse(await readFile(path.join(ledger, `${invocation().id}.attempts`), 'utf8'));
    assert.equal(claim.invocation_id, invocation().id);
    assert.equal(claim.version, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function packagedJob() {
  const { root, original } = await fixture();
  const inputRoot = path.join(root, 'runner-temp', 'factory-input');
  const invocationPath = path.join(root, 'invocation.json');
  const inv = invocation();
  await writeFile(invocationPath, JSON.stringify(inv));
  const notAfter = Date.now() + 60_000;
  await packageCodexInput({ invocationPath, sourceRoot: original, outputRoot: inputRoot, notAfter });
  return { root, inputRoot, inv, notAfter, jobs: path.join(root, 'jobs'), ledger: path.join(root, 'ledger'),
    env: { PATH: '/usr/bin:/bin', HOME: root, CODEX_HOME: path.join(root, '.codex') } };
}
const loggedIn = async () => ({ code: 0, stdout: 'Logged in using ChatGPT', stderr: '' });
const modeOf = async (value) => (await stat(value)).mode & 0o777;

test('the agent account is given a schema, workspace and output it can reach, never the runner private temp directory', async () => {
  const job = await packagedJob();
  try {
    let seen = null;
    const runCli = async (inv, options) => {
      const jobRoot = path.dirname(options.workspace);
      seen = {
        schemaOutsideRunnerTemp: !options.schemaPath.startsWith(path.dirname(job.inputRoot)),
        schemaInJob: path.dirname(path.dirname(options.schemaPath)) === jobRoot,
        outputInJob: path.dirname(path.dirname(options.outputPath)) === jobRoot,
        agentRoot: await modeOf(job.jobs), jobRoot: await modeOf(jobRoot),
        control: await modeOf(path.dirname(options.schemaPath)), schema: await modeOf(options.schemaPath),
        original: await modeOf(path.join(jobRoot, 'original')), staged: await modeOf(path.join(jobRoot, 'input')),
        schemaBytes: await readFile(options.schemaPath, 'utf8'),
      };
      await writeFile(path.join(options.workspace, 'src/app.js'), 'export const value = 3;\n');
      await writeFile(options.outputPath, JSON.stringify({ status: 'completed', summary: 'done', tests: ['npm test'] }));
      return { status: 'completed', stdout: '', stderr: '' };
    };
    const result = await executeCodexJob({ inputRoot: job.inputRoot, resultRoot: path.join(job.root, 'result'), agentRoot: job.jobs, ledgerRoot: job.ledger, env: job.env, runCli, checkLogin: loggedIn });
    assert.equal(result.status, 'completed');
    assert.deepEqual(seen, {
      schemaOutsideRunnerTemp: true, schemaInJob: true, outputInJob: true,
      // Traverse-only parents; the trusted baseline and staged input stay root-private.
      agentRoot: 0o711, jobRoot: 0o711, control: 0o755, schema: 0o644, original: 0o700, staged: 0o700,
      schemaBytes: JSON.stringify(job.inv.output_schema),
    });
  } finally { await rm(job.root, { recursive: true, force: true }); }
});

test('a dispatch picked up after its deadline never starts Codex and publishes nothing', async () => {
  const job = await packagedJob();
  try {
    let calls = 0;
    const runCli = async () => { calls++; return { status: 'completed' }; };
    const resultRoot = path.join(job.root, 'late-result');
    await assert.rejects(() => executeCodexJob({ inputRoot: job.inputRoot, resultRoot, agentRoot: job.jobs, ledgerRoot: job.ledger, env: job.env, runCli, checkLogin: loggedIn, now: () => job.notAfter + 1 }), /deadline/);
    assert.equal(calls, 0);
    await assert.rejects(() => stat(path.join(resultRoot, 'result.json')), /ENOENT/);
    await assert.rejects(() => stat(path.join(job.ledger, `${job.inv.id}.attempts`)), /ENOENT/);
  } finally { await rm(job.root, { recursive: true, force: true }); }
});

test('input without a dispatch deadline, or with a symlinked file, fails closed', async () => {
  const job = await packagedJob();
  try {
    const runCli = async () => { throw new Error('must not run'); };
    const common = { resultRoot: path.join(job.root, 'result'), agentRoot: job.jobs, ledgerRoot: job.ledger, env: job.env, runCli, checkLogin: loggedIn };
    const manifestPath = path.join(job.inputRoot, 'input.json');
    const { not_after, ...withoutDeadline } = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(manifestPath, JSON.stringify(withoutDeadline));
    await assert.rejects(() => executeCodexJob({ inputRoot: job.inputRoot, ...common }), /deadline/);
    await rm(manifestPath);
    await symlink('/etc/hosts', manifestPath);
    await assert.rejects(() => executeCodexJob({ inputRoot: job.inputRoot, ...common }), /ELOOP|regular file/);
  } finally { await rm(job.root, { recursive: true, force: true }); }
});

test('prepare accepts only a near-future dispatch deadline', () => {
  const now = 1_000_000;
  assert.equal(validateDispatchDeadline(String(now + 60_000), now), now + 60_000);
  for (const bad of [undefined, '', 'soon', String(now - 1), String(now + 24 * 60 * 60_000), '1.5']) {
    assert.throws(() => validateDispatchDeadline(bad, now), /deadline/);
  }
});

// A minimal GitHub API double for the trusted publisher.
async function withGitHub(inv, existingComments, body) {
  const state = emptyFactoryState();
  const record = { id: inv.id, provider: inv.provider, role: inv.role, task_id: inv.task_id, status: 'accepted', started_at: 10 };
  const event = prepareEvent(state, 'agent-dispatching', { invocation: inv }, { invocations: [record] }, 10);
  const comments = [{ id: 1, body: renderEvent(event), created_at: new Date(10).toISOString(), user: { login: 'github-actions[bot]' } }, ...existingComments];
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const route = url.replace('https://api.github.com/repos/owner/repo', '');
    const method = options.method ?? 'GET';
    calls.push({ method, route: route.replace(/[?&]per_page=100&page=1$/, ''), body: options.body ? JSON.parse(options.body) : undefined });
    const json = (value, status = 200) => ({ ok: true, status, json: async () => value, text: async () => JSON.stringify(value) });
    if (method === 'GET' && route.startsWith('/issues?state=all&labels=factory-status')) return json([{ number: 5, body: withFactoryState('status', state) }]);
    if (method === 'GET' && route.startsWith('/issues/5/comments')) return json(comments);
    if (method === 'POST' && route === '/issues/5/comments') return json({ id: 99 }, 201);
    if (method === 'POST' && route === '/actions/workflows/factory.yml/dispatches') return { ok: true, status: 204, text: async () => '' };
    throw new Error(`unexpected GitHub call ${method} ${route}`);
  };
  try { return { outcome: await body(), calls }; } finally { globalThis.fetch = original; }
}

async function publicationFixture(inv, details) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-publish-'));
  const input = { digest: 'input-1', source_manifest: { sha256: 'source-1' } };
  const result = makeExecutionResult(inv, { sha256: 'source-1' }, { input_digest: input.digest, ...details });
  await mkdir(path.join(root, 'input'));
  await mkdir(path.join(root, 'result'));
  await writeFile(path.join(root, 'input/input.json'), JSON.stringify(input));
  await writeFile(path.join(root, 'result/result.json'), JSON.stringify(result));
  const options = { token: 't', repository: 'owner/repo', dispatcherLogin: 'github-actions[bot]', invocationId: inv.id,
    inputRoot: path.join(root, 'input'), resultRoot: path.join(root, 'result'), checkoutRoot: root, workflowRunId: '77' };
  return { root, result, options };
}

test('a failed agent result is published as a receipt and turns the workflow red without recursively dispatching', async () => {
  const inv = invocation('worker');
  const { root, options } = await publicationFixture(inv, { status: 'failed', error: { code: 'codex-exec', message: 'Permission denied (os error 13)' } });
  try {
    const { outcome, calls } = await withGitHub(inv, [], () => publishCodexResult(options));
    const posted = calls.filter((call) => call.method === 'POST');
    assert.deepEqual(posted.map((call) => call.route), ['/issues/5/comments']);
    assert.equal(parseAgentResultReceipts([{ body: posted[0].body.body }])[0].status, 'failed');
    assert.equal(publicationExitCode(outcome), 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('redelivering an already published failure is idempotent and does not recursively wake the dispatcher', async () => {
  const inv = invocation('worker');
  const { root, result, options } = await publicationFixture(inv, { status: 'unauthorized', error: { code: 'codex-login', message: 'not logged in' } });
  try {
    const receipt = { version: 1, invocation_id: inv.id, digest: result.digest, status: 'unauthorized', role: 'worker' };
    const existing = [{ id: 2, body: renderAgentResultReceipt(receipt), created_at: new Date(20).toISOString(), user: { login: 'github-actions[bot]' } }];
    const { outcome, calls } = await withGitHub(inv, existing, () => publishCodexResult(options));
    assert.equal(outcome.adopted, true);
    assert.deepEqual(calls.filter((call) => call.method === 'POST').map((call) => call.route), []);
    assert.equal(publicationExitCode(outcome), 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a completed review (even a rejection) publishes green without recursively dispatching', async () => {
  const inv = invocation('reviewer');
  const review = { verdict: 'reject', findings: [{ id: 'F1', severity: 'blocking', file: 'src/app.js', problem: 'wrong', evidence: 'test', affected_commit: 'a'.repeat(40), required_test: 'add test' }] };
  const { root, options } = await publicationFixture(inv, { status: 'completed', output: { status: 'completed', summary: 'reviewed', review } });
  try {
    const { outcome, calls } = await withGitHub(inv, [], async () => {
      const original = globalThis.fetch;
      globalThis.fetch = async (url, init = {}) => {
        if (url.includes('/issues/9/comments')) return { ok: true, status: (init.method ?? 'GET') === 'GET' ? 200 : 201, json: async () => ((init.method ?? 'GET') === 'GET' ? [] : { id: 3 }), text: async () => '' };
        return original(url, init);
      };
      try { return await publishCodexResult(options); } finally { globalThis.fetch = original; }
    });
    assert.equal(calls.some((call) => call.route === '/actions/workflows/factory.yml/dispatches'), false);
    assert.equal(outcome.receipt.status, 'completed');
    assert.equal(publicationExitCode(outcome), 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('codex-agent workflow passes the deadline, keeps execute credential-free and has one bounded dispatcher wake-up', async () => {
  const workflow = await readFile(new URL('../workflows/codex-agent.yml', import.meta.url), 'utf8');
  const job = (name) => workflow.split(/\n  (?=[a-z]+:\n)/).find((block) => block.startsWith(`${name}:`)) ?? '';
  assert.match(workflow, /not_after:\n\s+description:[^\n]*\n\s+required: true/);
  assert.match(job('prepare'), /FACTORY_NOT_AFTER: \$\{\{ inputs\.not_after \}\}/);
  assert.match(job('execute'), /permissions: \{\}/);
  assert.doesNotMatch(job('execute'), /GITHUB_TOKEN|secrets\./);
  assert.doesNotMatch(job('publish'), /actions: write|reconciliation_requested/);
  assert.match(job('reconcile'), /if: always\(\)/);
  assert.match(job('reconcile'), /gh workflow run factory\.yml --repo "\$GITHUB_REPOSITORY" --ref main/);
  assert.match(job('reconcile'), /permissions:\n\s+actions: write\n\s+steps:/);
});

test('a transport redispatch with a new deadline redelivers the cached result without a second Codex call', async () => {
  const job = await packagedJob();
  try {
    let calls = 0;
    const runCli = async (inv, options) => {
      calls++;
      await writeFile(path.join(options.workspace, 'src/app.js'), 'export const value = 4;\n');
      await writeFile(options.outputPath, JSON.stringify({ status: 'completed', summary: 'done', tests: ['npm test'] }));
      return { status: 'completed', stdout: '' };
    };
    const common = { agentRoot: job.jobs, ledgerRoot: job.ledger, env: job.env, runCli, checkLogin: loggedIn };
    const first = await executeCodexJob({ inputRoot: job.inputRoot, resultRoot: path.join(job.root, 'r1'), ...common });
    const redispatched = path.join(job.root, 'runner-temp-2', 'factory-input');
    await packageCodexInput({ invocationPath: path.join(job.root, 'invocation.json'), sourceRoot: path.join(job.root, 'original'), outputRoot: redispatched, notAfter: job.notAfter + 30_000 });
    const second = await executeCodexJob({ inputRoot: redispatched, resultRoot: path.join(job.root, 'r2'), ...common });
    assert.equal(calls, 1);
    assert.equal(second.digest, first.digest);
    const input = JSON.parse(await readFile(path.join(redispatched, 'input.json'), 'utf8'));
    assert.deepEqual(validatePublishableResult(second, job.inv, input), []);
  } finally { await rm(job.root, { recursive: true, force: true }); }
});

test('a Codex process that exits before reading its prompt is reported as failed, never crashes the wrapper', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough, Writable } = await import('node:stream');
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, encoding, callback) { callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })); } });
    child.kill = () => {};
    setImmediate(() => child.emit('close', 1));
    return child;
  };
  const outcome = await runCodexCli(invocation(), { workspace: '/w', schemaPath: '/s.json', outputPath: '/o.json', env: {} }, spawnImpl);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.exit_code, 1);
});
