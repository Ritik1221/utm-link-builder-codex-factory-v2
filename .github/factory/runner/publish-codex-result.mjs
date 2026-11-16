import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { applyChangeSet, parseAgentResultReceipts, renderAgentResultReceipt, sourceManifest, validateExecutionResult } from '../execution.mjs';
import { branchOf, goalIdsForSnapshot, renderFinalReview, validatePlan, validateReview } from '../lib.mjs';
import { fetchInvocation } from './prepare-codex-job.mjs';

async function githubApi(token, method, route, body) {
  const response = await fetch(`https://api.github.com${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${route}: ${response.status} ${(await response.text()).slice(0, 500)}`);
  return response.status === 204 ? null : response.json();
}

async function api(token, repository, method, route, body) {
  return githubApi(token, method, `/repos/${repository}${route}`, body);
}

async function all(token, repository, route) {
  const values = [];
  for (let page = 1; ; page++) {
    const items = await api(token, repository, 'GET', `${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    values.push(...items);
    if (items.length < 100) return values;
  }
}

function commandEnvironment(extra = {}) {
  const allowed = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  return { ...allowed, GIT_TERMINAL_PROMPT: '0', ...extra };
}

export function publisherGitEnvironment(token) {
  if (!token) throw new Error('trusted publisher token is required for a repository write');
  return commandEnvironment({
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  });
}

function command(name, args, cwd, env = commandEnvironment()) {
  return new Promise((resolve, reject) => {
    const child = spawn(name, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${name} ${args[0]} failed (${code}): ${stderr.slice(-500)}`)));
  });
}

export function validatePublishableResult(result, invocation, input) {
  const errors = validateExecutionResult(result, invocation, input.source_manifest.sha256, input.digest);
  if (result.status === 'completed') {
    if (invocation.role === 'planner') {
      if (result.changes.changes.length !== 1 || result.changes.changes[0]?.path !== 'factory/plan.json') errors.push('planner must change only factory/plan.json');
      else {
        try {
          const planBytes = Buffer.from(result.changes.changes[0].content_base64, 'base64');
          const changedPlan = JSON.parse(planBytes.toString());
          const planErrors = validatePlan(changedPlan, goalIdsForSnapshot(invocation.immutable_context.goal?.body), { goalSnapshot: invocation.immutable_context.goal });
          errors.push(...planErrors.map((error) => `plan: ${error}`));
          if (createHash('sha256').update(planBytes).digest('hex') !== result.output?.plan_sha256) errors.push('planner file hash does not match structured output');
        } catch { errors.push('planner change is not valid JSON'); }
      }
    } else if (['worker', 'corrective-worker'].includes(invocation.role)) {
      if (result.changes.changes.length === 0) errors.push('completed worker result contains no product changes');
    } else if (invocation.role === 'reviewer') {
      const review = { ...result.output?.review, sha: invocation.base_sha, goal_snapshot_sha: invocation.goal_version, at: Date.now(), author: 'trusted-publisher' };
      errors.push(...validateReview(review, { sha: invocation.base_sha, goalVersion: invocation.goal_version, expectedAuthor: 'trusted-publisher' }));
    } else if (invocation.role === 'final-reviewer') {
      const review = { ...result.output?.review, sha: invocation.base_sha, goal_snapshot_sha: invocation.goal_version, at: Date.now(), author: 'trusted-publisher' };
      errors.push(...validateReview(review, { sha: invocation.base_sha, goalVersion: invocation.goal_version, expectedAuthor: 'trusted-publisher', requireReconciliation: true }));
    }
  }
  return errors;
}

export function reconcileReceipt(receipts, result) {
  const matching = receipts.filter((receipt) => receipt.invocation_id === result.invocation_id);
  if (!matching.length) return { action: 'publish' };
  if (matching.length === 1 && matching[0].digest === result.digest) return { action: 'complete', receipt: matching[0] };
  return { action: 'needs-human', reason: 'conflicting or duplicate result receipts exist for the invocation' };
}

export async function verifyPublisherIdentity(token, expectedLogin) {
  if (!token || !expectedLogin) throw new Error('trusted publisher token and login are required');
  const user = await githubApi(token, 'GET', '/user');
  if (user?.login !== expectedLogin) throw new Error(`trusted publisher identity mismatch: expected ${expectedLogin}, received ${user?.login ?? 'unknown'}`);
  return user.login;
}

async function publishCode({ invocation, result, publisherToken, publisherLogin, checkoutRoot }) {
  const gitEnv = publisherGitEnvironment(publisherToken);
  const branch = invocation.role === 'planner' ? 'factory/plan' : branchOf(invocation.task_id, invocation.attempt);
  const remote = await command('git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], checkoutRoot, gitEnv);
  const remoteSha = remote.split(/\s/)[0] || null;
  await applyChangeSet(checkoutRoot, result, invocation);
  await command('git', ['add', '--all'], checkoutRoot);
  if (remoteSha) {
    await command('git', ['fetch', '--no-tags', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`], checkoutRoot, gitEnv);
    try {
      await command('git', ['diff', '--quiet', `refs/remotes/origin/${branch}`, '--'], checkoutRoot);
      return { branch, sha: remoteSha, adopted: true };
    } catch {
      if (invocation.role !== 'planner') throw new Error(`attempt branch ${branch} exists with different content`);
    }
  }
  await command('git', ['checkout', '-B', branch], checkoutRoot);
  await command('git', ['config', 'user.name', publisherLogin], checkoutRoot);
  await command('git', ['config', 'user.email', `${publisherLogin}@users.noreply.github.com`], checkoutRoot);
  await command('git', ['commit', '-m', invocation.role === 'planner' ? `factory: plan ${invocation.goal_id}` : `factory: ${invocation.task_id} attempt ${invocation.attempt}`], checkoutRoot);
  const push = ['push', 'origin', `HEAD:refs/heads/${branch}`];
  if (remoteSha && invocation.role === 'planner') push.splice(1, 0, `--force-with-lease=refs/heads/${branch}:${remoteSha}`);
  await command('git', push, checkoutRoot, gitEnv);
  return { branch, sha: await command('git', ['rev-parse', 'HEAD'], checkoutRoot), adopted: false };
}

export async function ensurePullRequest({ invocation, branch, repository, token, publisherLogin }) {
  const pulls = await all(token, repository, `/pulls?state=all&head=${encodeURIComponent(`${repository.split('/')[0]}:${branch}`)}&base=main`);
  if (pulls.length > 1) throw new Error(`multiple pull requests exist for ${branch}`);
  const pull = pulls[0] ?? await api(token, repository, 'POST', '/pulls', {
    title: `[${invocation.task_id}] autonomous attempt ${invocation.attempt}`,
    head: branch, base: 'main',
    body: `Trusted dispatcher publication for ${invocation.id}. Agent execution had no GitHub credentials.`,
  });
  if (pull.user?.login !== publisherLogin) throw new Error(`pull request author is ${pull.user?.login ?? 'unknown'}, expected trusted publisher ${publisherLogin}`);
  if (pull.head?.ref !== branch || pull.base?.ref !== 'main') throw new Error('pull request branch or base does not match the invocation');
  return pull;
}

async function ensureCi({ repository, token, ref, sha }) {
  const checks = await api(token, repository, 'GET', `/commits/${sha}/check-runs?per_page=100`);
  const names = new Set((checks.check_runs ?? []).filter((check) => check.app?.slug === 'github-actions').map((check) => check.name));
  if (names.has('ci') && names.has('e2e')) return false;
  await api(token, repository, 'POST', '/actions/workflows/ci.yml/dispatches', { ref });
  return true;
}

// The receipt records every outcome; the workflow is green only for a
// completed invocation, so a failed agent is visible in GitHub Actions.
export const publicationExitCode = (outcome) => (outcome?.receipt?.status === 'completed' ? 0 : 1);

export async function publishCodexResult({ token, publisherToken, publisherLogin, repository, dispatcherLogin, invocationId, inputRoot, resultRoot, checkoutRoot, workflowRunId = null }) {
  const recovered = await fetchInvocation({ token, repository, invocationId, dispatcherLogin });
  const invocation = recovered.invocation;
  const input = JSON.parse(await readFile(path.join(inputRoot, 'input.json'), 'utf8'));
  const result = JSON.parse(await readFile(path.join(resultRoot, 'result.json'), 'utf8'));
  const errors = validatePublishableResult(result, invocation, input);
  if (errors.length) throw new Error(`result rejected: ${errors.join('; ')}`);

  const statusComments = await all(token, repository, `/issues/${recovered.statusIssue}/comments`);
  const reconciliation = reconcileReceipt(parseAgentResultReceipts(statusComments, dispatcherLogin), result);
  if (reconciliation.action === 'complete') {
    return { adopted: true, receipt: reconciliation.receipt };
  }
  if (reconciliation.action === 'needs-human') throw new Error(reconciliation.reason);

  let evidence = null;
  if (result.status === 'completed' && ['planner', 'worker', 'corrective-worker'].includes(invocation.role)) {
    await verifyPublisherIdentity(publisherToken, publisherLogin);
    const current = await sourceManifest(checkoutRoot);
    if (current.sha256 !== input.source_manifest.sha256) throw new Error('publisher checkout is not the exact source snapshot');
    evidence = await publishCode({ invocation, result, publisherToken, publisherLogin, checkoutRoot });
    if (invocation.role !== 'planner') {
      const pullRequest = await ensurePullRequest({ invocation, branch: evidence.branch, repository, token: publisherToken, publisherLogin });
      evidence.pull_request = pullRequest.number;
      evidence.sha = pullRequest.head.sha;
      evidence.ci_dispatched = await ensureCi({ repository, token, ref: evidence.branch, sha: pullRequest.head.sha });
    }
  } else if (result.status === 'completed' && invocation.role === 'reviewer') {
    const review = { ...result.output.review, sha: invocation.base_sha, goal_snapshot_sha: invocation.goal_version };
    const body = `Codex independent task review for ${invocation.id}.\n<!-- factory-review ${JSON.stringify(review)} -->`;
    const comments = await all(token, repository, `/issues/${invocation.pull_request}/comments`);
    if (!comments.some((comment) => comment.body?.includes(invocation.id) && comment.body?.includes('factory-review'))) {
      await api(token, repository, 'POST', `/issues/${invocation.pull_request}/comments`, { body });
    }
    evidence = { pull_request: invocation.pull_request, sha: invocation.base_sha, verdict: review.verdict };
  } else if (result.status === 'completed' && invocation.role === 'final-reviewer') {
    const review = { ...result.output.review, sha: invocation.base_sha, goal_snapshot_sha: invocation.goal_version };
    const body = `Codex final product review for ${invocation.id}.\n${renderFinalReview(review)}`;
    const comments = await all(token, repository, `/issues/${recovered.statusIssue}/comments`);
    if (!comments.some((comment) => comment.body?.includes(invocation.id) && comment.body?.includes('factory-final-review'))) {
      await api(token, repository, 'POST', `/issues/${recovered.statusIssue}/comments`, { body });
    }
    evidence = { status_issue: recovered.statusIssue, sha: invocation.base_sha, verdict: review.verdict };
  }

  const receipt = {
    version: 1, invocation_id: invocation.id, digest: result.digest, status: result.status,
    role: invocation.role, base_sha: invocation.base_sha, workflow_run_id: workflowRunId,
    usage: result.usage, error: result.error, evidence,
  };
  await api(token, repository, 'POST', `/issues/${recovered.statusIssue}/comments`, { body: renderAgentResultReceipt(receipt) });
  return { adopted: false, receipt };
}

async function main() {
  const outcome = await publishCodexResult({
    token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY,
    publisherToken: process.env.FACTORY_PUBLISH_TOKEN, publisherLogin: process.env.FACTORY_PUBLISHER_LOGIN,
    dispatcherLogin: process.env.FACTORY_DISPATCHER_LOGIN,
    invocationId: process.env.FACTORY_INVOCATION_ID,
    inputRoot: process.env.FACTORY_INPUT_ROOT, resultRoot: process.env.FACTORY_RESULT_ROOT,
    checkoutRoot: process.env.FACTORY_PUBLISH_ROOT, workflowRunId: process.env.GITHUB_RUN_ID,
  });
  if (publicationExitCode(outcome)) {
    console.error(`Codex invocation ${outcome.receipt.invocation_id} published with status ${outcome.receipt.status}: ${outcome.receipt.error?.message ?? 'no error message'}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
