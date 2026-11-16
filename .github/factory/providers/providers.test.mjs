import test from 'node:test';
import { CODEX_TRANSPORT_LIMITS } from '../recovery.mjs';
import assert from 'node:assert/strict';
import { makeInvocation, validateInvocation } from './contract.mjs';
import { createClaudeAdapter } from './claude.mjs';
import { createCodexAdapter } from './codex.mjs';
import { CODEX_ROLE_ROUTES, resolveCodexRoute } from './codex-routing.mjs';
import { createProviderRegistry } from './index.mjs';
import { codexCommand, restrictedEnvironment } from '../runner/codex-cli.mjs';

const invocation = (provider = 'claude', role = 'worker') => makeInvocation({
  goal_id: 'G1', goal_version: 'goal-sha', role, provider,
  repository: 'owner/repo', base_sha: 'commit-sha', task_id: role === 'worker' ? 'G1-T1' : null,
  issue: 3, pull_request: role === 'reviewer' ? 7 : null, attempt: 1,
  timeout_ms: 5000, retry_budget: 2, immutable_context: { requirement: 'build it' },
  ...(provider === 'codex' ? { execution_config: resolveCodexRoute(role, {}) } : {}),
  output_schema: { type: 'object' },
});

test('provider contract is content-addressed and detects mutation', () => {
  const value = invocation();
  assert.deepEqual(validateInvocation(value), []);
  assert.match(value.id, /^inv_/);
  assert.match(validateInvocation({ ...value, goal_version: 'changed' }).join(';'), /id does not match/);
});

test('Claude adapter preserves the existing routine endpoint and maps quota safely', async () => {
  let request;
  const adapter = createClaudeAdapter({
    env: { FACTORY_ROUTINE_ID_SONNET: 'routine-1', FACTORY_FIRE_TOKEN_SONNET: 'secret' },
    fetchImpl: async (url, options) => { request = { url, options }; return { status: 429, json: async () => ({}) }; },
  });
  const result = await adapter.invoke(invocation('claude'), 'worker');
  assert.equal(result.status, 'quota-exhausted');
  assert.match(request.url, /routines\/routine-1\/fire$/);
  assert.doesNotMatch(request.options.body, /secret/);
});

test('Codex adapter dispatches only the explicit GitHub Actions transport and never falls back', async () => {
  const missing = createCodexAdapter({ env: {} });
  assert.equal((await missing.invoke(invocation('codex'))).status, 'unavailable');
  let called = 0;
  const configured = createCodexAdapter({
    env: { FACTORY_CODEX_EXECUTION_MODE: 'github-actions', GITHUB_TOKEN: 'ephemeral', GITHUB_REPOSITORY: 'owner/repo' },
    fetchImpl: async (url, options) => {
      called++;
      assert.match(url, /actions\/workflows\/codex-agent\.yml\/dispatches$/);
      const { inputs } = JSON.parse(options.body);
      assert.deepEqual(Object.keys(inputs).sort(), ['invocation_id', 'not_after']);
      assert.equal(inputs.invocation_id, invocation('codex').id);
      // Every dispatch carries its own bounded start deadline for the isolated runner.
      const deadline = Number(inputs.not_after);
      assert.ok(deadline > Date.now() && deadline <= Date.now() + CODEX_TRANSPORT_LIMITS.queueWindowMs);
      return { status: 204, ok: true };
    },
  });
  assert.equal((await configured.invoke(invocation('codex'))).status, 'accepted');
  assert.equal(called, 1);
  const registry = createProviderRegistry({ claude: { env: {} }, codex: { env: {} } });
  assert.equal(registry.availability('codex').available, false);
  assert.throws(() => registry.invoke('unknown', invocation('codex')), /Unknown provider/);
});

test('Codex runner gives reviewers a read-only sandbox and workers workspace-write', () => {
  const review = codexCommand(invocation('codex', 'reviewer'), { workspace: '/tmp/repo', schemaPath: '/tmp/schema.json', outputPath: '/tmp/output.json' });
  const worker = codexCommand(invocation('codex', 'worker'), { workspace: '/tmp/repo', schemaPath: '/tmp/schema.json', outputPath: '/tmp/output.json' });
  assert.equal(review.args[review.args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(worker.args[worker.args.indexOf('--sandbox') + 1], 'workspace-write');
  assert.ok(review.args.includes('--ephemeral'));
  assert.ok(review.args.includes('--ignore-user-config'));
  assert.ok(review.args.includes('--skip-git-repo-check'));
  assert.equal(review.args[review.args.indexOf('--ask-for-approval') + 1], 'never');
  assert.equal(review.args[review.args.indexOf('--model') + 1], 'gpt-5.6-sol');
  assert.equal(worker.args[worker.args.indexOf('--model') + 1], 'gpt-5.6-luna');
  assert.ok(review.args.includes('model_reasoning_effort="high"'));
  assert.ok(worker.args.includes('model_reasoning_effort="medium"'));
  assert.ok(review.args.includes('--strict-config'));
  assert.equal(review.args[review.args.indexOf('--output-last-message') + 1], '/tmp/output.json');
  const env = restrictedEnvironment({ PATH: '/bin', OPENAI_API_KEY: 'paid-key', CODEX_API_KEY: 'paid-key', GITHUB_TOKEN: 'shared', FACTORY_REVIEWER_GITHUB_TOKEN: 'review-only', FACTORY_WORKER_GITHUB_TOKEN: 'worker-only', GIT_CONFIG_GLOBAL: '/home/user/.gitconfig' });
  assert.deepEqual(env, {
    PATH: '/bin',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  });
});

test('Codex model routing is role-specific, configurable only as validated pairs, and never falls back', () => {
  assert.deepEqual(resolveCodexRoute('planner', {}), CODEX_ROLE_ROUTES.planner);
  assert.deepEqual(resolveCodexRoute('worker', {}), CODEX_ROLE_ROUTES.worker);
  assert.deepEqual(resolveCodexRoute('corrective-worker', {}), CODEX_ROLE_ROUTES['corrective-worker']);
  assert.deepEqual(resolveCodexRoute('reviewer', {}), CODEX_ROLE_ROUTES.reviewer);
  assert.deepEqual(resolveCodexRoute('final-reviewer', {}), CODEX_ROLE_ROUTES['final-reviewer']);
  assert.deepEqual(resolveCodexRoute('worker', {
    FACTORY_CODEX_MODEL_WORKER: 'gpt-5.6-terra', FACTORY_CODEX_REASONING_WORKER: 'high',
  }), { model: 'gpt-5.6-terra', reasoning_effort: 'high' });
  assert.throws(() => resolveCodexRoute('worker', { FACTORY_CODEX_MODEL_WORKER: 'gpt-5.6-sol' }), /must be configured together/);
  assert.throws(() => resolveCodexRoute('worker', {
    FACTORY_CODEX_MODEL_WORKER: 'gpt-6.1-sol', FACTORY_CODEX_REASONING_WORKER: 'high',
  }), /unsupported Codex model/);
  assert.throws(() => resolveCodexRoute('worker', {
    FACTORY_CODEX_MODEL_WORKER: 'gpt-5.6-sol', FACTORY_CODEX_REASONING_WORKER: 'extreme',
  }), /unsupported Codex reasoning/);
});

const TIERS = {
  FACTORY_ROUTINE_ID_OPUS: 'trig_opus', FACTORY_FIRE_TOKEN_OPUS: 'opus-token',
  FACTORY_ROUTINE_ID_SONNET: 'trig_sonnet', FACTORY_FIRE_TOKEN_SONNET: 'sonnet-token',
};

test('Claude routes planning, escalation and final review to the Opus routine and the rest to Sonnet', async () => {
  const fired = [];
  const adapter = createClaudeAdapter({ env: TIERS, fetchImpl: async (url, options) => {
    fired.push({ routine: url.match(/routines\/([^/]+)\/fire/)[1], token: options.headers.authorization, text: JSON.parse(options.body).text });
    return { status: 200, json: async () => ({ id: 'session' }) };
  } });
  const cases = [['planner', 'planner'], ['worker', 'worker'], ['worker', 'escalation'], ['reviewer', 'reviewer'], ['final-reviewer', 'final-reviewer']];
  for (const [role, route] of cases) assert.equal((await adapter.invoke(invocation('claude', role), route)).status, 'accepted');
  assert.deepEqual(fired.map((value) => value.routine), ['trig_opus', 'trig_sonnet', 'trig_opus', 'trig_sonnet', 'trig_opus']);
  assert.deepEqual(fired.map((value) => value.token), ['Bearer opus-token', 'Bearer sonnet-token', 'Bearer opus-token', 'Bearer sonnet-token', 'Bearer opus-token']);
  assert.deepEqual(fired.map((value) => /EXPECTED_MODEL=(\w+)/.exec(value.text)[1]), ['opus', 'sonnet', 'opus', 'sonnet', 'opus']);
});

test('Claude preserves model-tier, role-specific and legacy routine configurations without unsafe partial fallback', async () => {
  const fired = [];
  const fetchImpl = async (url) => { fired.push(url); return { status: 200, json: async () => ({ id: 'session' }) }; };
  const legacyOnly = createClaudeAdapter({ env: { FACTORY_ROUTINE_ID: 'trig_legacy', FACTORY_FIRE_TOKEN: 'legacy' }, fetchImpl });
  assert.equal((await legacyOnly.invoke(invocation('claude', 'planner'), 'planner')).status, 'accepted');
  assert.match(fired.pop(), /trig_legacy/);
  const roleOnly = createClaudeAdapter({ env: { FACTORY_ROUTINE_ID_PLANNER: 'trig_planner', FACTORY_FIRE_TOKEN_PLANNER: 'p' }, fetchImpl });
  assert.equal((await roleOnly.invoke(invocation('claude', 'planner'), 'planner')).status, 'accepted');
  assert.match(fired.pop(), /trig_planner/);
  const oldReviewer = createClaudeAdapter({ env: { FACTORY_ROUTINE_ID_REVIEWER: 'trig_reviewer', FACTORY_FIRE_TOKEN_REVIEWER: 'r' }, fetchImpl });
  assert.equal((await oldReviewer.invoke(invocation('claude', 'final-reviewer'), 'final-reviewer')).status, 'accepted');
  assert.match(fired.pop(), /trig_reviewer/);
  const sonnetOnly = createClaudeAdapter({ env: { FACTORY_ROUTINE_ID_SONNET: 'trig_sonnet', FACTORY_FIRE_TOKEN_SONNET: 's' }, fetchImpl });
  const result = await sonnetOnly.invoke(invocation('claude', 'planner'), 'planner');
  assert.equal(result.status, 'unavailable');
  assert.match(result.error.message, /opus/i);
  assert.equal(sonnetOnly.availability('planner').available, false);
  assert.equal(sonnetOnly.availability('worker').available, true);
  await assert.rejects(async () => { const r = await sonnetOnly.invoke(invocation('claude', 'worker'), 'unknown-route'); if (r.status === 'unavailable') throw new Error('unrouted'); }, /unrouted/);
  const partialTier = createClaudeAdapter({ env: {
    FACTORY_ROUTINE_ID_OPUS: 'trig_opus_without_token',
    FACTORY_ROUTINE_ID_PLANNER: 'trig_planner', FACTORY_FIRE_TOKEN_PLANNER: 'p',
  }, fetchImpl });
  const partial = await partialTier.invoke(invocation('claude', 'planner'), 'planner');
  assert.equal(partial.status, 'unavailable');
  assert.match(partial.error.message, /must be configured together/);
});

test('every route the dispatcher can emit has exactly one Claude model tier', async () => {
  const { readFile } = await import('node:fs/promises');
  const { CLAUDE_ROUTE_MODELS } = await import('./claude.mjs');
  const source = await readFile(new URL('../lib.mjs', import.meta.url), 'utf8');
  const routes = new Set([...source.matchAll(/route: (?:[^,}]*\? )?'([a-z-]+)'(?: : '([a-z-]+)')?/g)].flatMap((m) => [m[1], m[2]]).filter(Boolean));
  assert.deepEqual([...routes].sort(), ['escalation', 'final-reviewer', 'planner', 'reviewer', 'worker']);
  for (const route of routes) assert.ok(['opus', 'sonnet'].includes(CLAUDE_ROUTE_MODELS[route]), route);
});
