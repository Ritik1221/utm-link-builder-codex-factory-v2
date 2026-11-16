export function reconcileTaskCreation(operation, matchingIssues, now, settleMs = 10 * 60_000) {
  if (matchingIssues.length > 1) return { action: 'needs-human', reason: 'multiple issues own the same task id' };
  if (matchingIssues.length === 1) return { action: 'complete', issue: matchingIssues[0].number };
  if (operation?.status === 'pending' && now - operation.started_at < settleMs) return { action: 'wait', reason: 'GitHub issue creation may still be becoming consistent' };
  return { action: 'retry' };
}

export function reconcileMerge(pullRequest, expectedSha) {
  if (!pullRequest) return { action: 'needs-human', reason: 'pull request disappeared' };
  if (pullRequest.merged_at) {
    return pullRequest.head.sha === expectedSha
      ? { action: 'complete' }
      : { action: 'needs-human', reason: 'pull request merged at an unexpected head' };
  }
  if (pullRequest.state === 'open' && pullRequest.head.sha === expectedSha) return { action: 'retry' };
  return { action: 'needs-human', reason: 'pull request closed or changed before merge was confirmed' };
}

export function reconcileAttempt(attempt, pullRequests) {
  const current = pullRequests.filter((pullRequest) => pullRequest.attempt === attempt &&
    (pullRequest.state === 'open' || pullRequest.merged_at));
  if (current.length > 1) return { action: 'needs-human', reason: 'multiple open pull requests exist for one attempt' };
  if (current.length === 1) return { action: 'adopt', pullRequest: current[0] };
  return { action: 'wait' };
}

export function reconcileReview({ reviewSha, reviewAt }, pullRequest, review) {
  if (!pullRequest || pullRequest.state !== 'open') return { action: 'retry-worker', reason: 'pull request is not open' };
  if (pullRequest.headSha !== reviewSha) return { action: 'retry-worker', reason: 'head changed after review lease' };
  if (review?.invalid) return { action: 'needs-human', reason: review.invalid };
  if (review && review.sha === reviewSha && review.at > reviewAt) return { action: 'complete', verdict: review.verdict };
  return { action: 'wait' };
}

// One Codex dispatch is a codex-agent workflow run. Its execute job needs the
// self-hosted runner; every other job runs on GitHub-hosted runners.
export const CODEX_TRANSPORT_LIMITS = {
  queueWindowMs: 20 * 60_000, // the isolated wrapper refuses to start Codex after this
  executeTimeoutMs: 30 * 60_000, // codex-agent.yml execute timeout-minutes
  graceMs: 5 * 60_000, // clock skew and GitHub cancellation latency
  dispatchSettleMs: 5 * 60_000, // a dispatched run may not be listed yet
  resultSettleMs: 60_000, // a published receipt may not be listed yet
  publishTimeoutMs: 15 * 60_000, // publish timeout-minutes plus hosted-runner queueing
  maxDispatches: 3,
};

const ACTIVE_RUN = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];
const time = (value) => (value ? Date.parse(value) : NaN);

// Classifies one listed workflow run of the invocation.
function runProgress(run, jobs, now, limits, cancelledAt) {
  if (!ACTIVE_RUN.includes(run.status)) return { state: 'concluded', at: time(run.updated_at ?? run.created_at) };
  const byName = (name) => jobs?.find((job) => job.name === name);
  const prepare = byName('prepare');
  const execute = byName('execute');
  const publish = byName('publish');
  // The trailing reconcile job keeps the run active after the substantive jobs finish.
  const finished = [prepare?.conclusion !== 'success' && prepare?.status === 'completed' ? prepare : null,
    execute?.status === 'completed' && execute.conclusion !== 'success' ? execute : null,
    publish?.status === 'completed' ? publish : null].filter(Boolean);
  if (finished.length) return { state: 'concluded', at: Math.max(...finished.map((job) => time(job.completed_at)).filter(Number.isFinite), time(run.created_at)) };
  if (cancelledAt !== undefined) {
    return now - cancelledAt > 2 * limits.graceMs
      ? { state: 'stuck', reason: `cancellation of run ${run.id} was not honoured` }
      : { state: 'active', reason: 'cancellation is in progress' };
  }
  if (execute?.status === 'completed') {
    return now - time(execute.completed_at) > limits.publishTimeoutMs + limits.graceMs
      ? { state: 'stale', reason: 'trusted publication did not finish' }
      : { state: 'active', reason: 'trusted publication is running' };
  }
  if (execute?.status === 'in_progress') {
    const started = time(execute.started_at);
    return now - started > limits.executeTimeoutMs + limits.graceMs
      ? { state: 'stale', reason: 'isolated execution exceeded its timeout' }
      : { state: 'active', reason: 'isolated execution is running' };
  }
  if (!jobs && now - time(run.created_at) <= limits.queueWindowMs + limits.executeTimeoutMs + 2 * limits.graceMs) {
    return { state: 'active', reason: 'workflow is active' };
  }
  return now - time(run.created_at) > limits.queueWindowMs + limits.graceMs
    ? { state: 'stale', reason: 'no isolated runner started the execution inside the queue window' }
    : { state: 'active', reason: 'waiting for the isolated runner' };
}

export function reconcileAgentExecution(invocation, workflowRuns, now, { jobsByRun = {}, ...overrides } = {}) {
  const limits = { ...CODEX_TRANSPORT_LIMITS, ...overrides };
  if (invocation.result_digest || invocation.status === 'completed') return { action: 'complete' };
  const attempts = invocation.transport_attempts ?? 1;
  const cancelled = new Map((invocation.cancelled_runs ?? []).map((value) => [value.id, value.at]));
  const matching = (workflowRuns ?? []).filter((run) => run.display_title === `codex-${invocation.id}`)
    .sort((a, b) => time(b.created_at) - time(a.created_at));
  const progress = matching.map((run) => ({ run, ...runProgress(run, jobsByRun[run.id], now, limits, cancelled.get(run.id)) }));
  const stuck = progress.find((value) => value.state === 'stuck');
  if (stuck) return { action: 'needs-human', reason: stuck.reason };
  const stale = progress.filter((value) => value.state === 'stale');
  if (stale.length) return { action: 'cancel', runs: stale.map((value) => value.run.id), reason: stale[0].reason };
  if (progress.some((value) => value.state === 'active')) return { action: 'wait', reason: progress.find((value) => value.state === 'active').reason };

  // Only a run created by the latest dispatch can prove that dispatch concluded.
  const dispatchedAt = invocation.last_dispatch_at ?? invocation.started_at;
  const current = progress.filter((value) => time(value.run.created_at) >= dispatchedAt - 60_000);
  if (!current.length) {
    if (now - dispatchedAt < limits.dispatchSettleMs) return { action: 'wait', reason: 'workflow dispatch is settling' };
  } else if (now - current[0].at < limits.resultSettleMs) return { action: 'wait', reason: 'result publication is settling' };
  if (attempts >= limits.maxDispatches) return { action: 'needs-human', reason: 'Codex workflow transport retry limit reached' };
  const latest = current[0]?.run;
  return { action: 'retry', reason: latest ? `workflow concluded ${latest.conclusion ?? latest.status} without a trusted result` : 'workflow dispatch is missing' };
}

// With "require one approval" on main, GitHub refuses to merge a pull request
// whose author approved it, which blocks agent sessions acting as the owner.
// The dispatcher approves exactly the commit it reviewed and is about to merge.
export async function approveExactCommit(gh, repoPath, pullNumber, sha, dispatcher, pullAuthor = null) {
  if (!dispatcher) return 'identity-missing';
  if (pullAuthor && pullAuthor === dispatcher) return 'self-approval';
  const reviews = (await gh('GET', `${repoPath}/pulls/${pullNumber}/reviews?per_page=100`)) ?? [];
  if (reviews.some((review) => review.user?.login === dispatcher && review.state === 'APPROVED' && review.commit_id === sha)) return 'already-approved';
  try {
    const created = await gh('POST', `${repoPath}/pulls/${pullNumber}/reviews`, { commit_id: sha, event: 'APPROVE', body: `Factory dispatcher approval of the independently reviewed commit ${sha}.` });
    return created?.user?.login === dispatcher && created?.state === 'APPROVED' && created?.commit_id === sha
      ? 'approved'
      : 'not-confirmed';
  } catch (error) {
    if (/: 422 /.test(error.message)) return 'not-permitted';
    throw error;
  }
}
