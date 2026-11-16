import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activeFailpoint, hitFailpoint, STAGE_A_FAILPOINTS } from './failpoints.mjs';

const valid = (fault = 'after-journal-append') => ({
  FACTORY_FAULT_POINT: fault,
  FACTORY_INTEGRATION_TEST: 'true',
  FACTORY_INTEGRATION_REPOSITORY: 'owner/factory-phase2-stage-a-20261115',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REPOSITORY: 'owner/factory-phase2-stage-a-20261115',
});

test('Stage A failpoints are inert when no point is requested', () => {
  assert.equal(activeFailpoint({}), null);
  assert.equal(activeFailpoint({ FACTORY_FAULT_POINT: 'none' }), null);
  assert.doesNotThrow(() => hitFailpoint('after-journal-append', {}));
});

test('every declared Stage A failpoint can be selected only in the disposable repository', () => {
  for (const point of STAGE_A_FAILPOINTS) {
    assert.equal(activeFailpoint(valid(point)), point);
    assert.throws(() => hitFailpoint(point, valid(point)), new RegExp(point));
  }
});

test('failpoints reject non-dispatch events, missing opt-in and repository mismatches', () => {
  assert.throws(() => activeFailpoint({ ...valid(), GITHUB_EVENT_NAME: 'issues' }), /workflow_dispatch/);
  assert.throws(() => activeFailpoint({ ...valid(), FACTORY_INTEGRATION_TEST: 'false' }), /INTEGRATION_TEST/);
  assert.throws(() => activeFailpoint({ ...valid(), GITHUB_REPOSITORY: 'owner/production' }), /disposable/);
  assert.throws(() => activeFailpoint({ ...valid(), FACTORY_INTEGRATION_REPOSITORY: 'owner/another-repo' }), /exact/);
  assert.throws(() => activeFailpoint({ ...valid(), FACTORY_FAULT_POINT: 'after-merge' }), /unknown/);
});

test('factory workflow uses the repository-scoped token and guarded dispatch input', () => {
  const workflow = readFileSync(new URL('../workflows/factory.yml', import.meta.url), 'utf8');
  assert.match(workflow, /GITHUB_TOKEN:.*github\.token/);
  assert.doesNotMatch(workflow, /FACTORY_DISPATCHER_GITHUB_TOKEN/);
  assert.match(workflow, /FACTORY_DISPATCHER_LOGIN:.*vars\.FACTORY_DISPATCHER_LOGIN/);
  assert.match(workflow, /FACTORY_FAULT_POINT:.*inputs\.fault_point/);
  assert.match(workflow, /GITHUB_EVENT_NAME:.*github\.event_name/);
  assert.doesNotMatch(workflow, /^\s+queue:/m);
});

test('CI supports explicit exact-main verification after token-authenticated merges', () => {
  const workflow = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^\s+workflow_dispatch:/m);
});

test('Codex workflow keeps model execution credential-free and publication GitHub-hosted', () => {
  const workflow = readFileSync(new URL('../workflows/codex-agent.yml', import.meta.url), 'utf8');
  const execute = workflow.slice(workflow.indexOf('  execute:'), workflow.indexOf('  publish:'));
  const publish = workflow.slice(workflow.indexOf('  publish:'));
  assert.match(execute, /runs-on: \[self-hosted, factory-codex-isolated\]/);
  assert.match(execute, /permissions: \{\}/);
  assert.doesNotMatch(execute, /actions\/checkout/);
  assert.doesNotMatch(execute, /GITHUB_TOKEN|OPENAI_API_KEY|FACTORY_FIRE_TOKEN/);
  assert.match(execute, /\/usr\/local\/libexec\/factory-codex\/execute/);
  assert.match(publish, /runs-on: ubuntu-latest/);
  assert.match(publish, /actions: write/);
  assert.match(publish, /contents: read/);
  assert.doesNotMatch(publish, /contents: write|pull-requests: write/);
  assert.match(publish, /secrets\.FACTORY_PUBLISH_TOKEN/);
  assert.match(publish, /publish-codex-result\.mjs/);
  assert.doesNotMatch(workflow, /actions\/(checkout|upload-artifact|download-artifact)@v\d/);
  const publisher = readFileSync(new URL('runner/publish-codex-result.mjs', import.meta.url), 'utf8');
  assert.match(publisher, /actions\/workflows\/ci\.yml\/dispatches/);
});

test('root launcher fixes execution paths and clears the inherited environment', () => {
  const launcher = readFileSync(new URL('runner/execute-launcher.sh', import.meta.url), 'utf8');
  assert.match(launcher, /\/usr\/bin\/env -i/);
  assert.match(launcher, /FACTORY_RUNNER_TEMP_ROOT\/factory-input/);
  assert.match(launcher, /factory-result/);
  assert.doesNotMatch(launcher, /GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY/);
});

test('an invalid failpoint request is refused before the dispatcher writes anything', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./run.mjs', import.meta.url), 'utf8');
  const guard = source.indexOf('activeFailpoint()');
  const firstWrite = source.search(/await gh\('(POST|PATCH|PUT|DELETE)'/);
  const firstLoopWrite = source.indexOf("for (const name of LABELS) await gh('POST'");
  assert.ok(guard > 0, 'run.mjs must validate the failpoint request at startup');
  assert.ok(guard < firstLoopWrite, 'validation must precede the first GitHub write of a run');
  assert.ok(firstWrite > 0);
});
