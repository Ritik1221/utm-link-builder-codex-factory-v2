// Runs inside the Linux UID integration image as factory-runner, exactly as the
// Actions runner would: it prepares factory-input in the runner temp directory
// and calls the root-owned launcher through the single sudoers rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { packageCodexInput } from '/usr/local/libexec/factory-codex/app/runner/prepare-codex-job.mjs';
import { makeInvocation } from '/usr/local/libexec/factory-codex/app/providers/contract.mjs';
import { outputSchemaForRole } from '/usr/local/libexec/factory-codex/app/execution.mjs';

const TEMP = '/home/factory-runner/actions-runner/_work/_temp';
const INPUT = path.join(TEMP, 'factory-input');
const RESULT = path.join(TEMP, 'factory-result');
const SOURCE = '/home/factory-runner/source';
const CALLS = '/tmp/fake-codex-calls.log';
const RUNNER_UID = 10001;
const AGENT_UID = 10002;

const invocation = (attempt) => makeInvocation({
  goal_id: 'G1', goal_version: 'goal-version', role: 'worker', provider: 'codex', repository: 'owner/repo',
  base_sha: 'a'.repeat(40), task_id: 'G1-T1', issue: 3, attempt, timeout_ms: 60_000, retry_budget: 2,
  execution_config: { model: 'gpt-5.6-luna', reasoning_effort: 'medium' },
  immutable_context: {}, output_schema: outputSchemaForRole('worker'),
});

async function prepare(inv, notAfter) {
  await rm(INPUT, { recursive: true, force: true });
  await rm(RESULT, { recursive: true, force: true });
  await mkdir(path.join(SOURCE, 'src'), { recursive: true });
  await writeFile(path.join(SOURCE, 'src/app.js'), 'export const value = 1;\n');
  const invocationPath = path.join(TEMP, 'invocation.json');
  await writeFile(invocationPath, JSON.stringify(inv));
  await packageCodexInput({ invocationPath, sourceRoot: SOURCE, outputRoot: INPUT, notAfter });
}

const launch = (input = INPUT, result = RESULT) =>
  spawnSync('sudo', ['-n', '/usr/local/libexec/factory-codex/execute', input, result], { encoding: 'utf8' });
const codexStarts = async () => (existsSync(CALLS) ? (await readFile(CALLS, 'utf8')).trim().split('\n').filter(Boolean).length : 0);

async function alive(pid) {
  try { return !/^State:\s+Z/m.test(await readFile(`/proc/${pid}/status`, 'utf8')); } catch { return false; }
}

const first = invocation(1);

test('runs as the launcher-configured accounts', () => {
  assert.equal(process.getuid(), RUNNER_UID);
  assert.notEqual(spawnSync('sudo', ['-n', '/bin/true']).status, 0, 'sudoers must permit only the launcher');
  assert.equal(launch('/tmp/elsewhere', RESULT).status, 65, 'launcher must reject inputs outside the runner temp directory');
});

test('the agent UID can read its schema and workspace but nothing private to the runner or wrapper', async () => {
  await prepare(first, Date.now() + 5 * 60_000);
  const run = launch();
  assert.equal(run.status, 0, `launcher failed:\n${run.stdout}\n${run.stderr}`);
  const result = JSON.parse(await readFile(path.join(RESULT, 'result.json'), 'utf8'));
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  assert.deepEqual(result.changes.changes.map((change) => change.path), ['probe.json', 'src/app.js']);
  const probe = JSON.parse(Buffer.from(result.changes.changes[0].content_base64, 'base64').toString());
  assert.equal(probe.uid, AGENT_UID);
  assert.equal(probe.gid, AGENT_UID);
  assert.ok(probe.groups.every((group) => group === AGENT_UID), `unexpected supplementary groups ${probe.groups}`);
  assert.equal(probe.schema_type, 'object');
  assert.deepEqual(probe.env, ['CODEX_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'HOME', 'PATH']);
  for (const [name, isDenied] of Object.entries(probe.denied)) assert.equal(isDenied, true, `agent could access ${name}`);
  assert.equal(await codexStarts(), 1);
});

test('no agent process survives the job', async () => {
  const pid = Number(await readFile('/tmp/fake-codex-straggler.pid', 'utf8'));
  assert.equal(await alive(pid), false, `agent process ${pid} is still running`);
});

test('the runner account owns its result and can clean its temp directory', async () => {
  assert.equal((await stat(RESULT)).uid, RUNNER_UID);
  assert.equal((await stat(path.join(RESULT, 'result.json'))).uid, RUNNER_UID);
  await rm(RESULT, { recursive: true });
  await rm(INPUT, { recursive: true });
});

test('a transport redispatch with a new deadline redelivers the result without starting Codex again', async () => {
  await prepare(first, Date.now() + 10 * 60_000);
  const run = launch();
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(await readFile(path.join(RESULT, 'result.json'), 'utf8')).status, 'completed');
  assert.equal(await codexStarts(), 1);
});

test('a dispatch picked up after its deadline starts nothing and leaves no result', async () => {
  await prepare(invocation(2), Date.now() + 1_000);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const run = launch();
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /deadline passed/);
  assert.equal(existsSync(path.join(RESULT, 'result.json')), false);
  assert.equal(await codexStarts(), 1);
});
