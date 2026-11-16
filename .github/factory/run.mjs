import { createHash } from 'node:crypto';
import {
  decide, parseGoalIds, parseMeta, withMeta, renderIssue, taskHash, stateOf,
  touchesProtected, ciState, branchOf, pickReview, pickFinalReview, makeGoalSnapshot,
  goalSnapshotHash, parseGoalSnapshot, renderGoalSnapshot, goalCandidates, identityBoundaryError, weakened, STATES, BRANCH,
  effectiveTasks, completionGate, providerFromLabels, validatePlan, goalIdsForSnapshot, parseGoalCommand,
  verifiedGoalSnapshot,
} from './lib.mjs';
import {
  emptyFactoryState, parseFactoryState, withFactoryState, stateDiff, prepareEvent,
  renderEvent, parseEventComments, recoverFactoryState, applyEvent, recordInvocation,
  updateInvocation, recordFinding, recordOperation, recordDecision,
} from './state.mjs';
import { makeInvocation } from './providers/contract.mjs';
import { resolveCodexRoute } from './providers/codex-routing.mjs';
import { createProviderRegistry } from './providers/index.mjs';
import { approveExactCommit, reconcileAgentExecution, reconcileAttempt, reconcileMerge, reconcileTaskCreation } from './recovery.mjs';
import { renderProjectReport } from './report.mjs';
import { activeFailpoint, hitFailpoint } from './failpoints.mjs';
import { outputSchemaForRole, parseAgentResultReceipts } from './execution.mjs';
import { mergeExactSha } from './merge.mjs';

const { GITHUB_TOKEN, GITHUB_REPOSITORY: REPO } = process.env;
const DISPATCHER = process.env.FACTORY_DISPATCHER_LOGIN;
const CREDENTIAL_ISOLATED = process.env.FACTORY_CREDENTIAL_ISOLATED === 'true';
const EXPECTED_WORKER = CREDENTIAL_ISOLATED ? DISPATCHER : process.env.FACTORY_WORKER_LOGIN;
const EXPECTED_REVIEWER = CREDENTIAL_ISOLATED ? DISPATCHER : process.env.FACTORY_REVIEWER_LOGIN;
const r = `/repos/${REPO}`;
const LABELS = [...STATES, 'superseded', 'factory-task', 'factory-status', 'factory-goal', 'provider:claude', 'provider:codex'];
const providers = createProviderRegistry();
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const taskFindingId = (task, finding) => `task:${task}:${finding}`;
const finalFindingId = (finding) => `final:${finding}`;

async function gh(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 404 && method === 'GET') return null;
  if (res.status === 422 && path === `${r}/labels`) return null;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${(await res.text()).slice(0, 500)}`);
  return res.status === 204 ? null : res.json();
}

async function all(path) {
  const out = [];
  for (let page = 1; ; page++) {
    const items = (await gh('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)) ?? [];
    out.push(...items);
    if (items.length < 100) return out;
  }
}

async function file(path, ref) {
  const value = await gh('GET', `${r}/contents/${path}?ref=${encodeURIComponent(ref)}`);
  return value ? Buffer.from(value.content, 'base64').toString() : null;
}

const ciOf = async (sha) => ciState((await gh('GET', `${r}/commits/${sha}/check-runs?per_page=100`))?.check_runs ?? []);
async function ensureCiWorkflow(ref, sha) {
  const checks = (await gh('GET', `${r}/commits/${sha}/check-runs?per_page=100`))?.check_runs ?? [];
  const names = new Set(checks.filter((check) => check.app?.slug === 'github-actions').map((check) => check.name));
  if (names.has('ci') && names.has('e2e')) return false;
  await gh('POST', `${r}/actions/workflows/ci.yml/dispatches`, { ref });
  return true;
}
async function scripts(ref) {
  try { return JSON.parse((await file('package.json', ref)) ?? '{}').scripts ?? {}; } catch { return {}; }
}

async function decisionRecords(ref) {
  const entries = await gh('GET', `${r}/contents/docs/decisions?ref=${encodeURIComponent(ref)}`);
  if (!Array.isArray(entries)) return {};
  return Object.fromEntries(entries.filter((entry) => entry.type === 'file' && entry.name.endsWith('.md')).map((entry) => [entry.path, {
    id: entry.path, path: entry.path, blob_sha: entry.sha, repository_commit: ref,
  }]));
}

async function prDetails(number) {
  const p = await gh('GET', `${r}/pulls/${number}`);
  const sha = p.head.sha;
  const files = await all(`${r}/pulls/${number}/files`);
  const cmp = await gh('GET', `${r}/compare/main...${sha}`);
  return {
    number, state: p.merged_at ? 'merged' : p.state, headSha: sha, ci: await ciOf(sha),
    unauthorizedAuthor: EXPECTED_WORKER ? p.user?.login !== EXPECTED_WORKER : false,
    files: files.length,
    protectedFiles: touchesProtected(files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean))),
    weakened: weakened(files, await scripts('main'), await scripts(sha)),
    mergeable: p.mergeable, behind: !cmp || cmp.behind_by > 0,
  };
}

let statusNumber = null;
let duplicateStatusDetected = false;
async function statusRemote(number) {
  const issue = await gh('GET', `${r}/issues/${number}`);
  const comments = await all(`${r}/issues/${number}/comments`);
  const parsed = parseFactoryState(issue.body);
  const snapshot = parsed ?? emptyFactoryState();
  const events = parseEventComments(comments, DISPATCHER);
  const recovery = recoverFactoryState(snapshot, events);
  return { issue, comments, snapshot, events, recovery, malformedSnapshot: issue.body?.includes('factory-state') && !parsed };
}

async function loadStatus() {
  let duplicateStatus = false;
  let issue;
  if (statusNumber) issue = await gh('GET', `${r}/issues/${statusNumber}`);
  else {
    const statuses = await all(`${r}/issues?state=all&labels=factory-status&sort=created&direction=asc`);
    issue = statuses[0];
    duplicateStatus = statuses.length > 1;
    duplicateStatusDetected ||= duplicateStatus;
  }
  if (!issue) issue = await gh('POST', `${r}/issues`, { title: 'Factory status', body: withMeta('Starting.', {}), labels: ['factory-status'] });
  else if (issue.state !== 'open') await gh('PATCH', `${r}/issues/${issue.number}`, { state: 'open' });
  statusNumber = issue.number;
  const remote = await statusRemote(issue.number);
  const meta = parseMeta(issue.body) ?? {};
  const canonical = remote.recovery.state;
  return {
    number: issue.number, body: issue.body, plannerFiredSha: null, plannerFiredAt: 0,
    plannerFires: 0, finalReviewAt: 0, finalReviewFires: 0, finalReviewIgnoreBefore: 0,
    finalReviewRequestedSha: null, pending: [], ...meta,
    canonical, baseCanonical: structuredClone(canonical), comments: remote.comments,
    journalInvocations: new Map(remote.events.filter((event) => event.type === 'agent-dispatching' && event.payload?.invocation?.id)
      .map((event) => [event.payload.invocation.id, event.payload.invocation])),
    unsafeJournal: duplicateStatusDetected ? 'multiple factory-status issues exist'
      : !DISPATCHER ? 'FACTORY_DISPATCHER_LOGIN is required to authenticate journal events'
      : remote.recovery.ambiguous ? remote.recovery.error
        : remote.malformedSnapshot && remote.recovery.state.journal.count === 0 ? 'canonical snapshot is malformed and no journal can recover it' : null,
  };
}

async function persist(status, meta, event) {
  const remote = await statusRemote(status.number);
  if (remote.recovery.ambiguous) throw new Error(`journal is ambiguous: ${remote.recovery.error}`);
  const base = status.baseCanonical ?? remote.recovery.state;
  if (remote.recovery.state.journal.head !== base.journal.head || remote.recovery.state.revision !== base.revision) {
    throw new Error('optimistic state conflict: canonical state changed during this dispatcher run');
  }
  const draft = status.canonical;
  const patch = stateDiff(base, draft);
  let materialized = remote.recovery.state;
  if (Object.keys(patch).length) {
    const nextEvent = prepareEvent(materialized, event?.type ?? 'state-updated', event?.payload ?? {}, patch, event?.at ?? Date.now());
    const comment = await gh('POST', `${r}/issues/${status.number}/comments`, { body: renderEvent(nextEvent) });
    hitFailpoint('after-journal-append');
    const checked = await statusRemote(status.number);
    if (checked.recovery.ambiguous) throw new Error(`journal append conflict: ${checked.recovery.error}`);
    if (checked.recovery.state.journal.head !== nextEvent.id) throw new Error('journal append was not the unique current head');
    materialized = applyEvent(remote.recovery.state, { ...nextEvent, comment_id: comment.id, author: DISPATCHER });
    if (materialized.journal.head !== checked.recovery.state.journal.head) throw new Error('journal materialization mismatch');
    materialized = checked.recovery.state;
  }
  const legacy = { ...parseMeta(remote.issue.body), ...meta };
  const human = status.body ?? remote.issue.body;
  const body = withFactoryState(withMeta(human, legacy), materialized);
  if (Buffer.byteLength(body) > 60 * 1024) throw new Error('status issue body exceeds the 60 KiB safety ceiling');
  await gh('PATCH', `${r}/issues/${status.number}`, { body });
  status.body = body;
  status.canonical = materialized;
  status.baseCanonical = structuredClone(materialized);
}

function taskRecord(status, issue, patch = {}) {
  const id = issue?.meta?.id ?? patch.id;
  if (!id) return;
  status.canonical = {
    ...status.canonical,
    tasks: { ...status.canonical.tasks, [id]: { ...(status.canonical.tasks[id] ?? {}), id, ...patch } },
  };
}

function attemptRecord(status, id, attempt, patch) {
  const task = status.canonical.tasks[id];
  if (!task) return;
  status.canonical = {
    ...status.canonical,
    tasks: {
      ...status.canonical.tasks,
      [id]: { ...task, attempts: (task.attempts ?? []).map((value) => value.attempt === attempt ? { ...value, ...patch } : value) },
    },
  };
}

function completeInvocation(status, role, taskId, sha, evidence, at) {
  const invocation = [...status.canonical.invocations].reverse().find((value) =>
    value.role === role && value.task_id === taskId && value.base_sha === sha && value.status === 'accepted');
  if (invocation) status.canonical = updateInvocation(status.canonical, invocation.id, {
    status: 'completed', completion_evidence: evidence, completed_at: at,
  });
}

function legalDrift(from, to) {
  if (from === to) return true;
  if (to === 'needs-human') return true;
  return ({ planned: ['ready', 'superseded'], ready: ['in-progress', 'superseded'],
    'in-progress': ['ready', 'in-review'], 'in-review': ['in-progress', 'ready', 'done'],
  }[from] ?? []).includes(to);
}

async function loadState() {
  const status = await loadStatus();
  const goalsSha = (await gh('GET', `${r}/commits?path=GOALS.md&sha=main&per_page=1`))?.[0]?.sha ?? null;
  const openIssues = (await all(`${r}/issues?state=open`)).filter((item) => !item.pull_request);
  const candidates = goalCandidates(openIssues, process.env.FACTORY_OWNER_LOGIN);
  let goalCandidate = candidates[0] ?? null;
  if (goalCandidate) {
    const command = parseGoalCommand(goalCandidate);
    const labelled = goalCandidate.labels.some((label) => label.name === 'factory-goal');
    goalCandidate = { ...goalCandidate, needsIntake: !labelled, requestedProvider: command?.provider ?? null };
  }
  let goalInputError = candidates.length > 1 ? 'multiple open factory goals exist' : null;
  try { if (goalCandidate) providerFromLabels(goalCandidate.labels ?? []); }
  catch (error) { goalInputError = error.message; }
  const goalComments = goalCandidate ? await all(`${r}/issues/${goalCandidate.number}/comments`) : [];
  const candidateSnapshot = goalCandidate
    ? parseGoalSnapshot(goalComments, DISPATCHER)
    : null;
  const storedGoal = status.canonical.goal ?? status.goalSnapshot ?? null;
  const goalSnapshot = verifiedGoalSnapshot(storedGoal) ??
    (candidateSnapshot?.invalid ? null : verifiedGoalSnapshot(candidateSnapshot));
  let plan;
  try { plan = JSON.parse((await file('factory/plan.json', 'factory/plan')) ?? 'null'); }
  catch { plan = { goals_sha: goalSnapshot?.hash ?? goalsSha, tasks: null }; }

  const prsById = new Map();
  for (const p of (await all(`${r}/pulls?state=all&sort=created&direction=desc`)).filter((x) => x.head.repo?.full_name === REPO && x.base.ref === 'main')) {
    const match = BRANCH.exec(p.head.ref);
    if (match) prsById.set(match[1], [...(prsById.get(match[1]) ?? []), { ...p, attempt: Number(match[2]) }]);
  }

  const listed = (await all(`${r}/issues?state=all&labels=factory-task`)).filter((x) => !x.pull_request);
  const missing = (status.pending ?? []).filter((number) => !listed.some((x) => x.number === number));
  for (const number of missing) {
    const item = await gh('GET', `${r}/issues/${number}`);
    if (item) listed.push(item);
  }
  status.pending = missing;

  const issues = [];
  for (const item of listed) {
    const meta = parseMeta(item.body);
    if (!meta?.id) continue;
    const prs = prsById.get(meta.id) ?? [];
    const issue = {
      number: item.number, open: item.state === 'open', labels: item.labels.map((label) => label.name),
      meta, body: item.body, openPrs: prs.filter((p) => p.state === 'open').map((p) => ({ number: p.number, attempt: p.attempt })),
      pr: null, lastCommitAt: 0,
      mergedForAttempt: prs.some((pullRequest) => pullRequest.attempt === meta.attempt && pullRequest.merged_at),
    };
    const state = issue.open ? stateOf(issue) : null;
    if (state === 'in-progress' || state === 'in-review') {
      const attemptRecovery = reconcileAttempt(meta.attempt, prs);
      if (attemptRecovery.action === 'needs-human') issue.recoveryError = attemptRecovery.reason;
      const current = attemptRecovery.pullRequest;
      if (current) issue.pr = await prDetails(current.number);
      if (current && state === 'in-review') issue.review = pickReview(await all(`${r}/issues/${current.number}/comments`), {
        sha: current.head.sha,
        expectedAuthor: EXPECTED_REVIEWER || null,
        after: meta.reviewAt ?? 0, goalVersion: goalSnapshot?.hash ?? null,
      });
      const branch = await gh('GET', `${r}/branches/${encodeURIComponent(branchOf(meta.id, meta.attempt))}`);
      if (branch) issue.lastCommitAt = Date.parse(branch.commit.commit.committer.date);
    }
    issues.push(issue);
  }

  const main = await gh('GET', `${r}/commits/main`);
  const runs = (await gh('GET', `${r}/commits/${main.sha}/check-runs?per_page=100`))?.check_runs ?? [];
  const check = (name) => ciState(runs, name);
  const missingMainChecks = ['ci', 'e2e'].filter((name) => !runs.some((run) => run.name === name && run.app?.slug === 'github-actions'));
  let mainCiWorkflowActive = false;
  if (missingMainChecks.length) {
    const workflowRuns = (await gh('GET', `${r}/actions/workflows/ci.yml/runs?branch=main&per_page=20`))?.workflow_runs ?? [];
    mainCiWorkflowActive = workflowRuns.some((run) => run.head_sha === main.sha && ['queued', 'in_progress', 'waiting', 'pending'].includes(run.status));
  }
  const projection = (issue) => issue.open ? stateOf(issue)
    : issue.labels.includes('superseded') ? 'superseded'
      : issue.mergedForAttempt ? 'done' : 'needs-human';
  const identityError = goalSnapshot && identityBoundaryError({
    credentialIsolated: CREDENTIAL_ISOLATED, dispatcher: DISPATCHER,
    worker: process.env.FACTORY_WORKER_LOGIN, reviewer: process.env.FACTORY_REVIEWER_LOGIN,
  });
  let unsafeState = status.unsafeJournal || goalInputError || identityError;
  const operationRecoveries = [];
  for (const operation of Object.values(status.canonical.operations ?? {}).filter((value) => value.status === 'pending')) {
    if (operation.type === 'create-task') {
      const matches = issues.filter((issue) => issue.meta.id === operation.task);
      if (matches.length === 1) operationRecoveries.push({ id: operation.id, type: operation.type, issue: matches[0].number });
      else if (matches.length > 1) unsafeState = `${operation.id}: multiple task issues exist`;
    } else if (operation.type === 'merge') {
      const pullRequest = await gh('GET', `${r}/pulls/${operation.pr}`);
      const merge = reconcileMerge(pullRequest, operation.sha);
      if (merge.action === 'complete') operationRecoveries.push({ id: operation.id, type: operation.type, task: operation.task, sha: operation.sha });
      else if (merge.action === 'needs-human') unsafeState = `${operation.id}: ${merge.reason}`;
    }
  }
  const drift = [];
  const expected = new Map([...(plan?.tasks ?? []), ...(status.canonical.corrections?.tasks ?? [])].map((task) => [task.id, task]));
  for (const record of Object.values(status.canonical.tasks ?? {})) {
    const issue = issues.find((value) => value.meta?.id === record.id);
    if (!issue || !record.status) continue;
    const projected = projection(issue);
    if (issue.recoveryError) {
      unsafeState = `task ${record.id}: ${issue.recoveryError}`;
      break;
    }
    if (record.status === projected) continue;
    const task = expected.get(record.id);
    if (!task || issue.meta.hash !== taskHash(task) || issue.meta.goal_snapshot_sha !== goalSnapshot?.hash || !legalDrift(record.status, projected)) {
      unsafeState = `task ${record.id} differs between journal (${record.status}) and GitHub (${projected})`;
      break;
    }
    drift.push({ id: record.id, issue: issue.number, from: record.status, to: projected });
  }
  const statusComments = status.comments;
  const receipts = parseAgentResultReceipts(statusComments, DISPATCHER);
  const agentResults = [];
  const receiptsByInvocation = new Map();
  for (const receipt of receipts) receiptsByInvocation.set(receipt.invocation_id, [...(receiptsByInvocation.get(receipt.invocation_id) ?? []), receipt]);
  for (const [invocationId, values] of receiptsByInvocation) {
    const digests = new Set(values.map((receipt) => receipt.digest));
    if (digests.size > 1) {
      unsafeState = `invocation ${invocationId} has conflicting trusted result receipts`;
      break;
    }
    const invocation = status.canonical.invocations.find((value) => value.id === invocationId);
    if (invocation && !invocation.result_digest) agentResults.push(values[0]);
  }
  const agentRecoveries = [];
  const agentCancellations = [];
  const activeAgentInvocations = [];
  let agentRecoveryBlocked = null;
  // An invocation with a visible trusted receipt is settled by record-agent-results, never redispatched.
  const pendingCodex = status.canonical.invocations.filter((invocation) => invocation.provider === 'codex' &&
    ['dispatching', 'accepted', 'unknown', 'timeout'].includes(invocation.status) && !invocation.result_digest &&
    !receiptsByInvocation.has(invocation.id));
  if (pendingCodex.length && !status.canonical.provider.blocked && process.env.FACTORY_AGENT_EXECUTION !== 'disabled') {
    const workflowRuns = (await gh('GET', `${r}/actions/workflows/codex-agent.yml/runs?event=workflow_dispatch&per_page=100`))?.workflow_runs ?? [];
    const jobsByRun = {};
    for (const run of workflowRuns) {
      if (run.status === 'completed' || !pendingCodex.some((record) => run.display_title === `codex-${record.id}`)) continue;
      jobsByRun[run.id] = (await gh('GET', `${r}/actions/runs/${run.id}/jobs?per_page=100`))?.jobs ?? [];
    }
    for (const record of pendingCodex) {
      const recovery = reconcileAgentExecution(record, workflowRuns, Date.now(), { jobsByRun });
      if (recovery.action === 'cancel') {
        agentCancellations.push({ invocation: record.id, runs: recovery.runs, reason: recovery.reason });
        activeAgentInvocations.push({ id: record.id, role: record.role, task_id: record.task_id });
      } else if (recovery.action === 'retry') {
        const invocation = status.journalInvocations.get(record.id);
        if (!invocation) { agentRecoveryBlocked = `${record.id}: immutable invocation is missing from the journal`; break; }
        agentRecoveries.push({ invocation, reason: recovery.reason });
      } else if (recovery.action === 'wait') {
        activeAgentInvocations.push({ id: record.id, role: record.role, task_id: record.task_id });
      } else if (recovery.action === 'needs-human') {
        agentRecoveryBlocked = `${record.id}: ${recovery.reason}`;
        break;
      }
    }
  }
  return {
    now: Date.now(), goalsSha, plan, issues, goalCandidate, goalSnapshot,
    goalIds: parseGoalIds((await file('GOALS.md', 'main')) ?? ''), status,
    mainSha: main.sha, mainCi: check('ci'), mainChecks: { ci: check('ci'), e2e: check('e2e') },
    missingMainChecks, mainCiWorkflowActive,
    stateDrift: drift.length ? drift : null, unsafeState,
    operationRecoveries, agentResults, agentRecoveries, agentCancellations, activeAgentInvocations, agentRecoveryBlocked,
    invocationLimit: Math.max(1, Math.min(Number(process.env.FACTORY_MAX_INVOCATIONS) || 100, 100)),
    taskLimit: Math.max(1, Math.min(Number(process.env.FACTORY_MAX_TASKS) || 25, 25)),
    desiredProvider: process.env.FACTORY_ACTIVE_PROVIDER || goalSnapshot?.initial_provider || status.canonical.provider.active || 'claude',
    providerResumeNonce: process.env.FACTORY_PROVIDER_RESUME_NONCE || null,
    agentsDisabled: process.env.FACTORY_AGENT_EXECUTION === 'disabled',
    decisionApprovals: goalComments.filter((comment) => comment.user?.login === process.env.FACTORY_OWNER_LOGIN)
      .map((comment) => {
        const match = /^\/approve\s+(ADR-\d+)\s+([a-f0-9]{64})\s*$/i.exec(String(comment.body ?? '').trim());
        return match ? { id: match[1].toUpperCase(), plan_hash: match[2].toLowerCase(), at: Date.parse(comment.created_at) } : null;
      }).filter(Boolean),
    repositoryDecisions: await decisionRecords(main.sha),
    finalReview: pickFinalReview(statusComments, {
      sha: main.sha, expectedAuthor: EXPECTED_REVIEWER || null,
      after: Math.max(status.finalReviewIgnoreBefore ?? 0,
        status.finalReviewRequestedSha === main.sha ? (status.finalReviewAt ?? 0) : 0),
      goalVersion: goalSnapshot?.hash ?? null,
    }),
  };
}

async function setState(issue, to, metaPatch = {}) {
  const labels = issue.labels.filter((label) => !STATES.includes(label)).concat(to);
  await gh('PATCH', `${r}/issues/${issue.number}`, { labels, body: withMeta(issue.body, { ...issue.meta, ...metaPatch }) });
}

const plannerMeta = ({ plannerFiredSha, plannerFiredAt, plannerFires, pending, finalReviewAt, finalReviewFires,
  finalReviewIgnoreBefore, finalReviewRequestedSha }) =>
  ({ plannerFiredSha, plannerFiredAt, plannerFires, pending, finalReviewAt, finalReviewFires,
    finalReviewIgnoreBefore, finalReviewRequestedSha });

function invocationFor(action, state) {
  const task = effectiveTasks(state).find((value) => value.id === state.issues.find((issue) => issue.number === action.number)?.meta?.id);
  const provider = state.status.canonical.provider.active;
  const role = action.role === 'worker' && task?.corrective ? 'corrective-worker' : action.role;
  const context = {
    goal: state.goalSnapshot,
    plan: role === 'planner' || role === 'final-reviewer' ? state.plan : undefined,
    task,
    findings: state.issues.find((issue) => issue.number === action.number)?.meta?.reviewFindings ?? [],
    final_commit: role === 'final-reviewer' ? action.sha : undefined,
  };
  return makeInvocation({
    goal_id: task?.goal ?? 'G1', goal_version: state.goalSnapshot?.hash ?? state.goalsSha,
    role, provider, repository: REPO, base_sha: role === 'planner' ? state.mainSha : (action.sha ?? state.mainSha),
    task_id: task?.id ?? null, issue: action.number ?? action.goalIssue ?? null,
    pull_request: action.pr ?? null, attempt: action.attempt ?? action.reviews ?? action.fires ?? 1,
    timeout_ms: 20 * 60_000, retry_budget: Math.max(0, 3 - (action.attempt ?? action.reviews ?? action.fires ?? 1)),
    ...(provider === 'codex' ? { execution_config: resolveCodexRoute(role) } : {}),
    immutable_context: context,
    output_schema: outputSchemaForRole(role),
  });
}

function invocationRecord(invocation) {
  const { immutable_context, output_schema, ...summary } = invocation;
  return {
    ...summary, context_sha: digest(immutable_context), output_schema_sha: digest(output_schema),
    context_refs: {
      goal: invocation.goal_version,
      plan: immutable_context.plan ? digest(immutable_context.plan) : null,
      task: immutable_context.task ? taskHash(immutable_context.task) : null,
      findings: (immutable_context.findings ?? []).map((finding) => finding.fingerprint ?? digest(finding)),
    },
    status: 'dispatching', started_at: Date.now(),
  };
}

async function invoke(action, state) {
  const invocation = invocationFor(action, state);
  state.status.canonical = recordInvocation(state.status.canonical, invocationRecord(invocation));
  // The complete immutable invocation is journaled before workflow dispatch so
  // a delayed or restarted runner can recover the exact original input.
  await persist(state.status, plannerMeta(state.status), { type: 'agent-dispatching', payload: { invocation } });
  const result = await providers.invoke(invocation.provider, invocation, action.route);
  state.status.canonical = updateInvocation(state.status.canonical, invocation.id, {
    status: result.status, external_id: result.external_id, usage: result.usage,
    error: result.error, dispatch_result_at: result.at,
    ...(invocation.provider === 'codex' ? { transport_attempts: 1, last_dispatch_at: Date.now() } : {}),
  });
  if (['unavailable', 'unauthorized', 'quota-exhausted'].includes(result.status)) {
    state.status.canonical = {
      ...state.status.canonical,
      provider: { ...state.status.canonical.provider, blocked: `${invocation.provider}: ${result.error?.message ?? result.status}` },
    };
  }
  await persist(state.status, plannerMeta(state.status), { type: 'agent-dispatched', payload: { invocation: invocation.id, status: result.status } });
  return result;
}

function operationId(type, ...parts) { return `${type}:${parts.join(':')}`; }
async function operationStart(state, operation) {
  state.status.canonical = recordOperation(state.status.canonical, { ...operation, status: 'pending', started_at: state.now });
  await persist(state.status, plannerMeta(state.status), { type: 'operation-started', payload: { id: operation.id, type: operation.type } });
}
async function operationFinish(state, id, patch = {}) {
  state.status.canonical = recordOperation(state.status.canonical, { id, status: 'completed', completed_at: Date.now(), ...patch });
  await persist(state.status, plannerMeta(state.status), { type: 'operation-completed', payload: { id, ...patch } });
}

async function existingTask(id) {
  const issues = (await all(`${r}/issues?state=all&labels=factory-task`)).filter((item) => !item.pull_request);
  return issues.filter((item) => parseMeta(item.body)?.id === id);
}

async function apply(action, state, notes) {
  const issue = state.issues.find((value) => value.number === action.number);
  switch (action.type) {
    case 'intake-goal': {
      const source = state.goalCandidate;
      if (!source) return false;
      const labels = [...new Set([...source.labels.map((label) => label.name), 'factory-goal', `provider:${action.provider || process.env.FACTORY_ACTIVE_PROVIDER || 'claude'}`])];
      await gh('PATCH', `${r}/issues/${action.issue}`, { labels });
      return false;
    }
    case 'snapshot-goal': {
      if (!state.goalCandidate || state.status.canonical.goal) return false;
      const snapshot = makeGoalSnapshot(state.goalCandidate);
      await gh('POST', `${r}/issues/${state.goalCandidate.number}/comments`, { body: renderGoalSnapshot(snapshot) });
      state.status.goalSnapshot = snapshot;
      state.status.canonical = { ...state.status.canonical, goal: snapshot };
      await persist(state.status, plannerMeta(state.status), { type: 'goal-snapshotted', payload: { issue: snapshot.issue, hash: snapshot.hash } });
      return false;
    }
    case 'switch-provider': {
      const history = [...state.status.canonical.provider.history, { from: action.from, to: action.to, at: state.now, reason: 'explicit goal or factory configuration' }];
      state.status.canonical = { ...state.status.canonical, provider: { active: action.to, history, blocked: null } };
      await persist(state.status, plannerMeta(state.status), { type: 'provider-selected', payload: { from: action.from, to: action.to } });
      return false;
    }
    case 'resume-provider': {
      state.status.canonical = {
        ...state.status.canonical,
        provider: { ...state.status.canonical.provider, blocked: null, resume_nonce: action.nonce },
      };
      await persist(state.status, plannerMeta(state.status), { type: 'provider-resumed', payload: { provider: action.provider, nonce: action.nonce } });
      return false;
    }
    case 'reconcile': {
      for (const drift of action.drift) taskRecord(state.status, { meta: { id: drift.id } }, { status: drift.to, reconciled_from: drift.from, reconciled_at: state.now });
      await persist(state.status, plannerMeta(state.status), { type: 'projection-reconciled', payload: { drift: action.drift } });
      return false;
    }
    case 'record-decision-approvals': {
      for (const id of action.decisions) state.status.canonical = recordDecision(state.status.canonical, {
        id: `plan:${id}`, decision_id: id, plan_hash: action.planHash,
        status: 'approved', approved_by: process.env.FACTORY_OWNER_LOGIN, approved_at: state.now,
      });
      await persist(state.status, plannerMeta(state.status), { type: 'architecture-decisions-approved', payload: { decisions: action.decisions } });
      return false;
    }
    case 'recover-operations': {
      for (const operation of action.operations) {
        state.status.canonical = recordOperation(state.status.canonical, {
          ...operation, status: 'completed', recovered_at: state.now, completed_at: state.now,
        });
        if (operation.type === 'create-task') taskRecord(state.status, { meta: { id: state.status.canonical.operations[operation.id]?.task } }, { issue: operation.issue });
        if (operation.type === 'merge' && operation.task) taskRecord(state.status, { meta: { id: operation.task } }, { status: 'done', completed_sha: operation.sha });
      }
      await persist(state.status, plannerMeta(state.status), { type: 'operations-recovered', payload: { ids: action.operations.map((operation) => operation.id) } });
      return false;
    }
    case 'record-agent-results': {
      for (const receipt of action.results) {
        const invocation = state.status.canonical.invocations.find((value) => value.id === receipt.invocation_id);
        if (!invocation || invocation.result_digest) continue;
        const failure = receipt.status !== 'completed';
        state.status.canonical = updateInvocation(state.status.canonical, invocation.id, {
          status: failure ? receipt.status : 'accepted', result_digest: receipt.digest,
          result_received_at: receipt.at, workflow_run_id: receipt.workflow_run_id,
          usage: receipt.usage ?? invocation.usage, error: receipt.error ?? invocation.error,
          publication_evidence: receipt.evidence ?? null,
        });
        if (['unavailable', 'unauthorized', 'quota-exhausted'].includes(receipt.status)) {
          state.status.canonical = { ...state.status.canonical, provider: {
            ...state.status.canonical.provider,
            blocked: `codex: ${receipt.error?.message ?? receipt.status}`,
          } };
        }
        if (failure && ['worker', 'corrective-worker', 'reviewer'].includes(invocation.role)) {
          const taskIssue = state.issues.find((value) => value.meta?.id === invocation.task_id);
          if (taskIssue && taskIssue.open && taskIssue.meta.attempt === invocation.attempt) {
            const to = receipt.status === 'blocked' ? 'needs-human' : invocation.role === 'reviewer' ? 'in-progress' : 'ready';
            await setState(taskIssue, to, { leaseAt: 0, reviewAt: 0, reviewSha: null });
            taskRecord(state.status, taskIssue, { status: to, last_reason: `Codex ${receipt.status}` });
          }
        }
        if (failure && invocation.role === 'planner') state.status.plannerFiredAt = 0;
        if (failure && invocation.role === 'final-reviewer') state.status.finalReviewAt = 0;
      }
      await persist(state.status, plannerMeta(state.status), { type: 'agent-results-recorded', payload: { invocations: action.results.map((value) => value.invocation_id) } });
      return false;
    }
    case 'cancel-agent-runs': {
      // Cancellation only removes queued or hung transport. The isolated wrapper
      // independently refuses to start Codex after the dispatch deadline.
      for (const cancellation of action.cancellations) {
        const record = state.status.canonical.invocations.find((value) => value.id === cancellation.invocation);
        if (!record || record.result_digest) continue;
        for (const run of cancellation.runs) {
          try { await gh('POST', `${r}/actions/runs/${run}/cancel`); }
          catch (error) { if (!/: 409 /.test(error.message)) throw error; }
        }
        state.status.canonical = updateInvocation(state.status.canonical, record.id, {
          cancelled_runs: [...(record.cancelled_runs ?? []), ...cancellation.runs.map((id) => ({ id, at: Date.now(), reason: cancellation.reason }))],
        });
        notes.push(`Cancelled stale Codex workflow run(s) ${cancellation.runs.join(', ')} for ${record.id}: ${cancellation.reason}.`);
      }
      await persist(state.status, plannerMeta(state.status), { type: 'agent-transport-cancelled', payload: { cancellations: action.cancellations } });
      return true;
    }
    case 'retry-agent-dispatch': {
      const record = state.status.canonical.invocations.find((value) => value.id === action.invocation.id);
      if (!record || record.result_digest) return false;
      const result = await providers.invoke('codex', action.invocation, action.invocation.role);
      state.status.canonical = updateInvocation(state.status.canonical, action.invocation.id, {
        status: result.status, external_id: result.external_id ?? record.external_id,
        error: result.error, transport_attempts: (record.transport_attempts ?? 1) + 1,
        last_dispatch_at: Date.now(), dispatch_result_at: result.at,
      });
      if (['unavailable', 'unauthorized', 'quota-exhausted'].includes(result.status)) state.status.canonical = {
        ...state.status.canonical,
        provider: { ...state.status.canonical.provider, blocked: `codex: ${result.error?.message ?? result.status}` },
      };
      await persist(state.status, plannerMeta(state.status), { type: 'agent-transport-retried', payload: { invocation: action.invocation.id, status: result.status } });
      return true;
    }
    case 'ensure-main-ci': {
      const current = await gh('GET', `${r}/commits/main`);
      if (current.sha !== action.sha) return false;
      const dispatched = await ensureCiWorkflow('main', action.sha);
      notes.push(dispatched ? `Requested exact-main CI for ${action.sha}.` : `Exact-main CI already exists for ${action.sha}.`);
      return true;
    }
    case 'add-corrections': {
      for (const finding of action.review.findings) state.status.canonical = recordFinding(state.status.canonical, {
        ...finding, id: finalFindingId(finding.id), external_id: finding.id, affected_commit: action.review.sha,
        task: 'final-review', status: ['blocking', 'major'].includes(finding.severity) ? 'open' : 'advisory', recorded_at: action.review.at,
      });
      state.status.canonical = {
        ...state.status.canonical,
        corrections: { round: action.round, source_review_sha: action.review.sha, tasks: [...state.status.canonical.corrections.tasks, ...action.tasks], exhausted: false },
      };
      state.status.finalReviewAt = 0;
      state.status.finalReviewFires = 0;
      state.status.finalReviewIgnoreBefore = state.now;
      state.status.finalReviewRequestedSha = null;
      await persist(state.status, plannerMeta(state.status), { type: 'corrections-generated', payload: { round: action.round, findings: action.tasks.map((task) => task.source_finding) } });
      return false;
    }
    case 'create': {
      const prior = await existingTask(action.task.id);
      const id = operationId('create-task', action.task.id, taskHash(action.task));
      const creation = reconcileTaskCreation(state.status.canonical.operations[id], prior, state.now);
      if (creation.action === 'needs-human') { notes.push(`${action.task.id}: ${creation.reason}. Needs human.`); return true; }
      if (creation.action === 'wait') { notes.push(`Task creation ${action.task.id} is awaiting GitHub consistency.`); return true; }
      let made = prior[0];
      if (!made) {
        await operationStart(state, { id, type: 'create-task', task: action.task.id });
        hitFailpoint('after-task-operation-intent');
        const rendered = renderIssue(action.task, {
          id: action.task.id, hash: taskHash(action.task), attempt: 0,
          goal_snapshot_sha: state.goalSnapshot?.hash ?? null,
          source_finding: action.task.source_finding ?? null,
        });
        made = await gh('POST', `${r}/issues`, { ...rendered, labels: ['factory-task', 'planned'] });
        hitFailpoint('after-task-issue-create');
      }
      state.status.pending = [...new Set([...state.status.pending, made.number])];
      taskRecord(state.status, { meta: { id: action.task.id } }, {
        status: made.state === 'closed' ? 'done' : stateOf({ labels: made.labels?.map?.((label) => label.name) ?? ['planned'] }) ?? 'planned',
        goal: action.task.goal, goal_snapshot_sha: state.goalSnapshot?.hash ?? null,
        issue: made.number, attempts: state.status.canonical.tasks[action.task.id]?.attempts ?? [],
        source_finding: action.task.source_finding ?? null,
      });
      await operationFinish(state, id, { issue: made.number });
      return false;
    }
    case 'update': {
      const rendered = renderIssue(action.task, { ...issue.meta, hash: taskHash(action.task), goal_snapshot_sha: state.goalSnapshot?.hash ?? null, source_finding: action.task.source_finding ?? null });
      await gh('PATCH', `${r}/issues/${action.number}`, rendered);
      return false;
    }
    case 'supersede':
      await gh('PATCH', `${r}/issues/${action.number}`, { state: 'closed', state_reason: 'not_planned', labels: ['factory-task', 'superseded'] });
      taskRecord(state.status, issue, { status: 'superseded' });
      await persist(state.status, plannerMeta(state.status), { type: 'task-superseded', payload: { id: issue?.meta?.id } });
      return false;
    case 'close':
      await gh('PATCH', `${r}/issues/${action.number}`, { state: 'closed' });
      taskRecord(state.status, issue, { status: 'done' });
      await persist(state.status, plannerMeta(state.status), { type: 'task-completed', payload: { id: issue?.meta?.id } });
      return false;
    case 'closePr': {
      const current = await gh('GET', `${r}/pulls/${action.number}`);
      if (current.state === 'open') await gh('PATCH', `${r}/pulls/${action.number}`, { state: 'closed' });
      if (!current.merged_at) await gh('POST', `${r}/issues/${action.number}/comments`, { body: `Factory: closed because issue #${action.issue} no longer owns this attempt.` });
      return false;
    }
    case 'merge': {
      const task = state.issues.find((value) => value.number === action.issue);
      const id = operationId('merge', action.number, action.sha);
      await operationStart(state, { id, type: 'merge', pr: action.number, sha: action.sha, task: task?.meta?.id });
      const current = await gh('GET', `${r}/pulls/${action.number}`);
      const recovery = reconcileMerge(current, action.sha);
      if (recovery.action !== 'complete') {
        if (recovery.action === 'needs-human') {
          await setState(task, 'needs-human');
          notes.push(`Merge state for #${action.number} is unsafe: ${recovery.reason}. Needs human.`);
          return true;
        }
        try {
          const approval = await approveExactCommit(gh, r, action.number, action.sha, DISPATCHER, current.user?.login ?? null);
          if (!['approved', 'already-approved'].includes(approval)) {
            await setState(task, 'needs-human');
            notes.push(`Merge of #${action.number} stopped before merge: exact-SHA approval is ${approval}. Branch protection was not bypassed.`);
            return true;
          }
          await mergeExactSha({ gh, repositoryPath: r, pullNumber: action.number, sha: action.sha });
        }
        catch (error) {
          const after = await gh('GET', `${r}/pulls/${action.number}`);
          if (!after.merged_at) {
            await setState(task, 'needs-human');
            notes.push(`Merge of #${action.number} was not confirmed: ${error.message}`);
            return true;
          }
        }
      }
      taskRecord(state.status, task, { status: 'done', completed_sha: action.sha });
      attemptRecord(state.status, task?.meta?.id, task?.meta?.attempt, { result: 'merged', completed_at: state.now, sha: action.sha });
      completeInvocation(state.status, 'reviewer', task?.meta?.id, action.sha, 'review-approve-and-merge', state.now);
      for (const finding of task?.meta?.reviewFindings ?? []) {
        const findingId = taskFindingId(task?.meta?.id, finding.id);
        state.status.canonical = recordFinding(state.status.canonical, {
          ...(state.status.canonical.findings[findingId] ?? finding), id: findingId, external_id: finding.id,
          status: 'verified', resolved_by: action.sha, verified_at: state.now,
          verification: { ci: 'green', independent_task_review: 'approve', required_test: finding.required_test },
        });
      }
      const findingId = task?.meta?.source_finding ?? state.status.canonical.tasks[task?.meta?.id]?.source_finding;
      if (findingId && state.status.canonical.findings[findingId]) state.status.canonical = recordFinding(state.status.canonical, {
        ...state.status.canonical.findings[findingId], status: 'corrected-pending-final-review', corrected_by: action.sha,
        verification: { ci: 'green', task_review: 'approve' }, corrected_at: state.now,
      });
      await operationFinish(state, id, { task: task?.meta?.id, sha: action.sha });
      const mergedMain = await gh('GET', `${r}/commits/main`);
      await ensureCiWorkflow('main', mergedMain.sha);
      return false;
    }
    case 'state':
      await setState(issue, action.to, action.meta);
      taskRecord(state.status, issue, { status: action.to, last_reason: action.reason ?? null });
      if (action.meta?.reviewFindings) completeInvocation(state.status, 'reviewer', issue?.meta?.id, issue?.meta?.reviewSha, 'review-reject', state.now);
      if (action.to === 'ready' || action.to === 'needs-human') attemptRecord(state.status, issue?.meta?.id, issue?.meta?.attempt, {
        result: action.to === 'ready' ? 'retry' : 'needs-human', reason: action.reason ?? null, ended_at: state.now,
      });
      for (const finding of action.meta?.reviewFindings ?? []) state.status.canonical = recordFinding(state.status.canonical, {
        ...finding, id: taskFindingId(issue?.meta?.id, finding.id), external_id: finding.id,
        task: issue?.meta?.id, status: 'open', affected_commit: issue?.meta?.reviewSha ?? null, recorded_at: state.now,
      });
      await persist(state.status, plannerMeta(state.status), { type: 'task-state', payload: { id: issue?.meta?.id, state: action.to, reason: action.reason ?? null } });
      if (action.reason) await gh('POST', `${r}/issues/${action.number}/comments`, { body: `Factory: moved to \`${action.to}\` (${action.reason}).` });
      return false;
    case 'note':
      notes.push(action.text);
      return true;
    case 'fire': {
      if (action.role === 'planner') {
        const before = { plannerFiredSha: state.status.plannerFiredSha, plannerFiredAt: state.status.plannerFiredAt, plannerFires: state.status.plannerFires };
        Object.assign(state.status, { plannerFiredSha: action.sha, plannerFiredAt: state.now, plannerFires: action.fires });
        const result = await invoke(action, state);
        if (['refused', 'failed'].includes(result.status)) {
          Object.assign(state.status, before);
          await persist(state.status, plannerMeta(state.status), { type: 'planner-refused', payload: { invocation: result.invocation_id } });
        }
        return true;
      }
      if (action.role === 'reviewer') {
        const reviewAt = Date.now();
        await setState(issue, 'in-review', { reviewSha: action.sha, reviewAt, reviews: action.reviews, goal_snapshot_sha: state.goalSnapshot?.hash ?? null });
        taskRecord(state.status, issue, { status: 'in-review', review_sha: action.sha, review_at: reviewAt });
        await persist(state.status, plannerMeta(state.status), { type: 'review-leased', payload: { id: issue.meta.id, sha: action.sha, review: action.reviews } });
        const result = await invoke(action, state);
        if (['refused', 'failed'].includes(result.status)) {
          await setState(issue, 'in-progress', { reviewSha: null, reviewAt: 0, reviews: Math.max(0, action.reviews - 1) });
          taskRecord(state.status, issue, { status: 'in-progress' });
          await persist(state.status, plannerMeta(state.status), { type: 'review-refused', payload: { id: issue.meta.id, invocation: result.invocation_id } });
        }
        return true;
      }
      if (action.role === 'final-reviewer') {
        const before = { finalReviewAt: state.status.finalReviewAt, finalReviewFires: state.status.finalReviewFires, finalReviewRequestedSha: state.status.finalReviewRequestedSha };
        state.status.finalReviewAt = state.now;
        state.status.finalReviewFires = action.fires;
        state.status.finalReviewRequestedSha = action.sha;
        const result = await invoke(action, state);
        if (['refused', 'failed'].includes(result.status)) {
          Object.assign(state.status, before);
          await persist(state.status, plannerMeta(state.status), { type: 'final-review-refused', payload: { invocation: result.invocation_id } });
        }
        return true;
      }
      await setState(issue, 'in-progress', { attempt: action.attempt, tries: action.tries, leaseAt: state.now, reviews: 0 });
      taskRecord(state.status, issue, {
        status: 'in-progress', attempt: action.attempt, tries: action.tries,
        attempts: [...(state.status.canonical.tasks[issue.meta.id]?.attempts ?? []), { attempt: action.attempt, tries: action.tries, started_at: state.now, result: 'started' }],
      });
      await persist(state.status, plannerMeta(state.status), { type: 'worker-leased', payload: { id: issue.meta.id, attempt: action.attempt } });
      const result = await invoke(action, state);
      if (['refused', 'failed'].includes(result.status)) {
        await setState(issue, 'ready', { tries: Math.max(0, action.tries - 1) });
        taskRecord(state.status, issue, { status: 'ready', tries: Math.max(0, action.tries - 1) });
        attemptRecord(state.status, issue.meta.id, action.attempt, { result: 'dispatch-refused', ended_at: state.now });
        await persist(state.status, plannerMeta(state.status), { type: 'worker-refused', payload: { id: issue.meta.id, invocation: result.invocation_id } });
      }
      return true;
    }
    default:
      throw new Error(`unknown action ${action.type}`);
  }
}

async function writeStatus(status, notes) {
  const state = await loadState();
  for (const finding of state.finalReview?.findings ?? []) state.status.canonical = recordFinding(state.status.canonical, {
    ...finding, id: finalFindingId(finding.id), external_id: finding.id,
    task: 'final-review', affected_commit: state.finalReview.sha,
    status: ['blocking', 'major'].includes(finding.severity) ? 'open' : 'advisory', recorded_at: state.finalReview.at,
  });
  if (state.finalReview?.verdict === 'approve') {
    for (const finding of Object.values(state.status.canonical.findings)) {
      if (finding.status === 'corrected-pending-final-review') state.status.canonical = recordFinding(state.status.canonical, {
        ...finding, status: 'verified', verified_by: state.finalReview.sha,
        verification: { ...finding.verification, final_review: 'approve', goal_reconciliation: 'satisfied' }, verified_at: state.now,
      });
    }
  }
  const taskState = { ...state.status.canonical.tasks };
  for (const issue of state.issues) if (issue.meta?.id) taskState[issue.meta.id] = {
    ...(taskState[issue.meta.id] ?? {}), id: issue.meta.id,
    status: issue.open ? stateOf(issue) : issue.labels.includes('superseded') ? 'superseded' : issue.mergedForAttempt ? 'done' : 'needs-human',
    issue: issue.number, attempt: issue.meta.attempt ?? 0, tries: issue.meta.tries ?? 0,
  };
  const goalIds = state.goalSnapshot ? goalIdsForSnapshot(state.goalSnapshot.body) : state.goalIds;
  const acceptedPlan = state.plan && state.plan.goals_sha === (state.goalSnapshot?.hash ?? state.goalsSha) &&
    validatePlan(state.plan, goalIds, { goalSnapshot: state.goalSnapshot }).length === 0;
  for (const invocation of state.status.canonical.invocations.filter((value) => value.status === 'accepted')) {
    let evidence = null;
    if (invocation.role === 'planner' && acceptedPlan) evidence = 'accepted-plan';
    else if (['worker', 'corrective-worker'].includes(invocation.role) && ['in-review', 'done'].includes(taskState[invocation.task_id]?.status)) evidence = taskState[invocation.task_id].status;
    else if (invocation.role === 'reviewer') {
      const reviewed = state.issues.find((issue) => issue.meta.id === invocation.task_id)?.review;
      if (reviewed?.sha === invocation.base_sha) evidence = `review-${reviewed.verdict}`;
    } else if (invocation.role === 'final-reviewer' && state.finalReview?.sha === invocation.base_sha) evidence = `final-review-${state.finalReview.verdict}`;
    if (evidence) state.status.canonical = updateInvocation(state.status.canonical, invocation.id, { status: 'completed', completion_evidence: evidence, completed_at: state.now });
  }
  state.status.canonical = {
    ...state.status.canonical, goal: state.goalSnapshot ?? state.status.canonical.goal,
    plan: acceptedPlan ? state.plan : state.status.canonical.plan, tasks: taskState,
    decisions: { ...state.status.canonical.decisions, ...state.repositoryDecisions },
  };
  const gate = completionGate(state);
  const allDone = effectiveTasks(state).length > 0 && effectiveTasks(state).every((task) => taskState[task.id]?.status === 'done');
  const completion = gate.ok && allDone ? { status: 'complete', missing: [] }
    : { status: allDone ? 'blocked' : 'running', missing: gate.missing };
  state.status.canonical = { ...state.status.canonical, completion };
  state.status.body = renderProjectReport(state.status.canonical, { now: state.now, notes });
  await persist(state.status, { ...plannerMeta(state.status), completion }, { type: 'status-materialized', payload: completion });
}

if (!GITHUB_TOKEN || !REPO) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required');
// Anyone with Contents write can dispatch this workflow with a fault_point. An
// unpermitted request must fail here, before any write, not mid-transaction.
try { activeFailpoint(); }
catch (error) { console.error(`Refusing run: ${error.message}`); process.exit(1); }
for (const name of LABELS) await gh('POST', `${r}/labels`, { name });
const notes = [];
let state;
for (let pass = 0; pass < 8; pass++) {
  state = await loadState();
  const actions = decide(state);
  console.log(`pass ${pass}: ${JSON.stringify(actions)}`);
  let stop = actions.length === 0;
  for (const action of actions) stop = (await apply(action, state, notes)) || stop;
  if (stop) break;
}
await writeStatus(state.status, notes);
