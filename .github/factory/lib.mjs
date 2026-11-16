import { createHash } from 'node:crypto';

export const LIMITS = {
  maxTasks: 25, maxAttempts: 3, leaseMs: 90 * 60000, maxLeaseMs: 4 * 60 * 60000,
  plannerRetryMs: 60 * 60000, maxPlannerFires: 3,
  reviewLeaseMs: 45 * 60000, maxReviews: 2, maxFinalReviews: 2, maxFiles: 100,
  maxCorrectionRounds: 2, maxCorrectionTasks: 6, maxInvocations: 100,
};
export const STATES = ['planned', 'ready', 'in-progress', 'in-review', 'needs-human'];
export const BRANCH = /^factory\/(G\d+-T\d+)-a(\d+)$/;
// Never merged automatically: the owner's file, the factory itself, secrets,
// and deployment, infrastructure or database-migration files.
const PROTECTED = [
  /^GOALS\.md$/, /^\.github\//, /^\.claude\//, /^CODEOWNERS$/, /^factory\/(phase2|plan)\.json$/,
  /(^|\/)\.env(\.(?!example$)[^/]*)?$/, /(^|\/)\.npmrc$/, /\.(pem|key|p12|pfx)$/,
  /(^|\/)Dockerfile[^/]*$/, /(^|\/)docker-compose[^/]*$/,
  /(^|\/)(vercel\.json|netlify\.toml|fly\.toml|render\.yaml|wrangler\.toml|Procfile|app\.yaml)$/,
  /\.tf(vars)?$/, /(^|\/)(infra|deploy|k8s|terraform|helm|migrations)\//,
];
const REVIEW = /<!-- factory-review (.*?) -->/s;
const CI_SCRIPTS = ['lint', 'typecheck', 'test', 'build'];
const TEST_FILE = /(\.(test|spec)\.[^/]+$)|((^|\/)(__tests__|tests?)\/)/;
const ID = /^G\d+-T\d+$/;
const MARK = /<!-- factory-meta (.*?) -->/s;
const GOAL_SNAPSHOT = /<!-- factory-goal-snapshot (.*?) -->/s;
const FINAL_REVIEW = /<!-- factory-final-review (.*?) -->/s;

export const parseGoalIds = (md) => [...md.matchAll(/^## (G\d+):/gm)].map((m) => m[1]);
export const goalIdsForSnapshot = (body) => {
  const ids = parseGoalIds(body ?? '');
  return ids.length ? ids : ['G1'];
};
export const goalSnapshotHash = (body, title = '') => createHash('sha256').update(`${title}\n${body ?? ''}`).digest('hex');
export const verifiedGoalSnapshot = (snapshot) => snapshot &&
  snapshot.hash === goalSnapshotHash(snapshot.body, snapshot.title) ? snapshot : null;
export const planVersionHash = (plan) => createHash('sha256').update(JSON.stringify(plan)).digest('hex');
export function parseGoalCommand(issue) {
  const line = [issue?.title, String(issue?.body ?? '').split(/\r?\n/)[0]].find((value) => /^\/goal(?:\s|$)/i.test(String(value ?? '').trim()));
  if (!line) return null;
  const provider = /^\/goal\s+(claude|codex)(?:\s|$)/i.exec(line.trim())?.[1]?.toLowerCase() ?? null;
  return { provider };
}
// Goals spend the owner's agent subscription. Only issues the configured owner
// opened are goals; anyone else's /goal issue or factory-goal label is ignored.
export function goalCandidates(openIssues, owner) {
  if (!owner) return [];
  return openIssues
    .filter((issue) => issue.user?.login === owner)
    .filter((issue) => issue.labels.some((label) => (label.name ?? label) === 'factory-goal') || parseGoalCommand(issue))
    .sort((a, b) => a.number - b.number);
}
export function providerFromLabels(labels = [], fallback = 'claude') {
  const names = labels.map((label) => typeof label === 'string' ? label : label?.name).filter(Boolean);
  const selected = names.filter((name) => name === 'provider:claude' || name === 'provider:codex');
  if (selected.length > 1) throw new Error('goal selects more than one provider');
  return selected[0]?.slice('provider:'.length) ?? fallback;
}
export function makeGoalSnapshot(issue) {
  const body = String(issue.body ?? '');
  return {
    issue: Number(issue.number),
    title: String(issue.title ?? ''),
    body,
    hash: goalSnapshotHash(body, issue.title ?? ''),
    created_at: issue.created_at ?? null,
    initial_provider: providerFromLabels(issue.labels ?? [], 'claude'),
  };
}
export function parseGoalSnapshot(comments, expectedAuthor = null) {
  const found = [];
  for (const c of comments ?? []) {
    const m = GOAL_SNAPSHOT.exec(c.body ?? '');
    if (!m) continue;
    if (expectedAuthor && c.user?.login !== expectedAuthor) continue;
    try {
      const snapshot = JSON.parse(m[1]);
      if (Number.isInteger(snapshot.issue) && typeof snapshot.body === 'string' &&
          typeof snapshot.hash === 'string' && snapshot.hash === goalSnapshotHash(snapshot.body, snapshot.title ?? '')) {
        found.push({ ...snapshot, at: Date.parse(c.created_at), author: c.user?.login ?? null });
      }
    } catch { /* malformed snapshot */ }
  }
  if (!found.length) return null;
  const hashes = new Set(found.map((x) => x.hash));
  if (hashes.size !== 1) return { invalid: 'multiple goal snapshots' };
  return found[0];
}
export const renderGoalSnapshot = (snapshot) =>
  `<!-- factory-goal-snapshot ${JSON.stringify(snapshot)} -->`;
export const touchesProtected = (files) => files.some((f) => PROTECTED.some((re) => re.test(f)));
export const stateOf = (issue) => STATES.find((s) => issue.labels.includes(s)) ?? null;
// Each attempt works on its own branch, so a worker from an earlier attempt
// can never push into the branch the current attempt is judged on.
export const branchOf = (id, attempt) => `factory/${id}-a${attempt}`;
export const taskHash = (t) =>
  createHash('sha1')
    .update(JSON.stringify([t.goal, t.title, t.acceptance, t.depends_on, t.difficulty ?? 'routine',
      t.corrective ?? false, t.source_finding ?? null, t.correction_round ?? null, t.affected_commit ?? null]))
    .digest('hex').slice(0, 12);

// What a /fire HTTP status proves. Only a 4xx proves no session was started;
// a 5xx or no answer at all may still have started one.
export const fireOutcome = (status) =>
  status >= 200 && status < 300 ? 'ok' : status >= 400 && status < 500 ? 'refused' : 'unknown';

// The newest review verdict among a PR's comments (oldest first), or null.
// Authorization comes only from a distinct configured reviewer identity. A
// secret later published in a mutable comment cannot distinguish two sessions
// that share one GitHub account, so that configuration is rejected before here.
export function pickReview(comments, { sha = null, expectedAuthor = null, after = 0, goalVersion = null } = {}) {
  const candidates = [];
  for (const c of comments ?? []) {
    const m = REVIEW.exec(c.body ?? '');
    if (!m) continue;
    try {
      const v = JSON.parse(m[1]);
      const review = {
        sha: v.sha, goal_snapshot_sha: v.goal_snapshot_sha, verdict: v.verdict, at: Date.parse(c.created_at),
        findings: Array.isArray(v.findings) ? v.findings : [], author: c.user?.login ?? null,
      };
      if (!Number.isFinite(review.at) || review.at <= after) continue;
      const errors = validateReview(review, { sha: sha ?? v.sha, expectedAuthor, after, goalVersion });
      candidates.push({ review, errors });
    } catch {
      candidates.push({ review: null, errors: ['malformed review'] });
    }
  }
  if (!candidates.length) return null;
  if (candidates.length > 1) return { invalid: 'duplicate review results', errors: ['duplicate review results'] };
  if (candidates[0].errors.length) return { invalid: candidates[0].errors.join('; '), errors: candidates[0].errors };
  return candidates[0].review;
}

function validFinding(f) {
  return f && typeof f.id === 'string' && /^[A-Z][A-Z0-9-]+$/.test(f.id) &&
    ['blocking', 'major', 'minor', 'advisory'].includes(f.severity) &&
    typeof f.file === 'string' && f.file.trim() && typeof f.problem === 'string' &&
    typeof f.evidence === 'string' && f.evidence.trim() &&
    typeof f.affected_commit === 'string' && f.affected_commit.trim() &&
    typeof f.required_test === 'string' && f.problem.trim() && f.required_test.trim();
}

export function validateReview(review, { sha, expectedAuthor = null, after = 0, goalVersion = null, requireReconciliation = false } = {}) {
  const errors = [];
  if (!review || typeof review !== 'object') return ['review is missing'];
  if (review.sha !== sha) errors.push('review SHA is stale');
  if (goalVersion && review.goal_snapshot_sha !== goalVersion) errors.push('review goal version is stale or missing');
  if (!['approve', 'reject'].includes(review.verdict)) errors.push('review verdict is invalid');
  if (expectedAuthor && review.author !== expectedAuthor) errors.push('review author is unauthorized');
  if (!Number.isFinite(review.at) || review.at <= after) errors.push('review timestamp is stale');
  if (!Array.isArray(review.findings)) errors.push('review findings must be an array');
  else {
    const ids = new Set();
    for (const f of review.findings) {
      if (!validFinding(f)) errors.push(`${f?.id ?? 'finding'} is malformed`);
      else if (f.affected_commit !== review.sha) errors.push(`${f.id}: affected_commit does not match reviewed SHA`);
      else if (ids.has(f.id)) errors.push(`duplicate finding ${f.id}`);
      else ids.add(f.id);
    }
    if (review.verdict === 'reject' && !review.findings.some((f) => f.severity === 'blocking' || f.severity === 'major')) {
      errors.push('rejected review must contain a blocking or major finding');
    }
    if (review.verdict === 'approve' && review.findings.some((f) => f.severity === 'blocking' || f.severity === 'major')) {
      errors.push('approved review cannot contain blocking or major findings');
    }
  }
  if (requireReconciliation) {
    if (!Array.isArray(review.reconciliation) || !review.reconciliation.length) errors.push('final review must reconcile the original goal');
    else {
      for (const item of review.reconciliation) {
        if (!item || typeof item.id !== 'string' || !['satisfied', 'not_satisfied'].includes(item.status) || typeof item.evidence !== 'string' || !item.evidence.trim()) {
          errors.push('final review reconciliation is malformed');
        }
      }
      if (review.verdict === 'approve' && review.reconciliation.some((x) => x.status !== 'satisfied')) errors.push('final approval cannot contain unsatisfied goal requirements');
    }
    for (const finding of review.findings ?? []) {
      if (!['blocking', 'major'].includes(finding.severity)) continue;
      if (typeof finding.autonomous_fix !== 'boolean') errors.push(`${finding.id}: final finding must declare autonomous_fix`);
      if (finding.autonomous_fix === true && (!Array.isArray(finding.acceptance_tests) ||
          !finding.acceptance_tests.length || finding.acceptance_tests.some((x) => !nonPlaceholder(x)))) {
        errors.push(`${finding.id}: autonomous correction requires meaningful acceptance_tests`);
      }
    }
  }
  return errors;
}

export function pickFinalReview(comments, { sha, expectedAuthor = null, after = 0, goalVersion = null } = {}) {
  const candidates = [];
  for (const c of comments ?? []) {
    const m = FINAL_REVIEW.exec(c.body ?? '');
    if (!m) continue;
    try {
      const v = JSON.parse(m[1]);
      const review = { ...v, at: Date.parse(c.created_at), author: c.user?.login ?? null };
      if (!Number.isFinite(review.at) || review.at <= after) continue;
      const errors = validateReview(review, { sha, expectedAuthor, after, goalVersion, requireReconciliation: true });
      if (!expectedAuthor) errors.push('final reviewer identity is not configured');
      candidates.push({ review, errors });
    } catch {
      candidates.push({ review: null, errors: ['malformed final review'] });
    }
  }
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) return { invalid: 'duplicate final review results', errors: ['duplicate final review results'] };
  return candidates[0].errors.length ? { invalid: candidates[0].errors.join('; '), errors: candidates[0].errors } : candidates[0].review;
}

export const renderFinalReview = (review) =>
  `<!-- factory-final-review ${JSON.stringify(review)} -->`;

export function identityBoundaryError({ credentialIsolated, dispatcher, worker, reviewer }) {
  if (credentialIsolated) return dispatcher ? null : 'dispatcher identity is required for credential-isolated publication';
  if (!worker) return 'FACTORY_WORKER_LOGIN is required for Phase 2 worker authorization';
  if (!reviewer) return 'FACTORY_REVIEWER_LOGIN is required for independent-review authorization';
  if (!dispatcher) return 'FACTORY_DISPATCHER_LOGIN is required for dispatcher authorization';
  if (worker === reviewer) return 'worker and reviewer identities must be distinct; shared-identity review attestation is not secure';
  if (worker === dispatcher || reviewer === dispatcher) return 'worker, reviewer and dispatcher identities must be distinct';
  return null;
}

// A reason when a PR makes CI prove less than it did on main, else null.
// files: [{ filename, status }]; scripts: the package.json "scripts" on main and on the PR head.
export function weakened(files, baseScripts, headScripts) {
  const gone = CI_SCRIPTS.filter((k) => baseScripts?.[k] && !headScripts?.[k]?.trim());
  if (gone.length) return `PR removes the CI script: ${gone.join(', ')}`;
  if (files.some((f) => f.status === 'removed' && TEST_FILE.test(f.filename))) return 'PR deletes tests';
  return null;
}

export function parseMeta(body) {
  const m = MARK.exec(body ?? '');
  try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
}
export const withMeta = (text, meta) =>
  `${(text ?? '').replace(MARK, '').trimEnd()}\n\n<!-- factory-meta ${JSON.stringify(meta)} -->`;

export function renderIssue(t, meta) {
  const body = [
    `Goal: ${t.goal} (see GOALS.md)`, '',
    '## Acceptance criteria', ...t.acceptance.map((c) => `- [ ] ${c}`), '',
    `Depends on: ${t.depends_on.join(', ') || 'none'}`,
    `Difficulty: ${t.difficulty ?? 'routine'}`,
    `Branch: \`factory/${t.id}-a<attempt>\``,
  ].join('\n');
  return { title: `[${t.id}] ${t.title}`, body: withMeta(body, meta) };
}

export function ciState(checkRuns, name = 'ci') {
  // Only a run reported by GitHub Actions counts; no other identity can vouch for CI.
  const runs = checkRuns.filter((c) => c.name === name && c.app?.slug === 'github-actions')
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  if (!runs.length || runs[0].status !== 'completed') return 'pending';
  return runs[0].conclusion === 'success' ? 'green' : 'red';
}

const nonPlaceholder = (value) => typeof value === 'string' && value.trim().length > 0 &&
  !/(placeholder|always\s*pass|echo\s+(ok|pass)|exit\s*\(?\s*0|return\s+true|true\s*;)/i.test(value);

function validatePhase2Plan(plan, errors, goalIds, goalSnapshot) {
  if (!goalSnapshot) return;
  if (plan.goal_snapshot_sha !== goalSnapshot.hash) errors.push('plan must reference the immutable goal snapshot hash');
  const a = plan.architecture;
  if (!a || !Array.isArray(a.components) || !a.components.length || !Array.isArray(a.data_model) || !Array.isArray(a.security_boundaries)) {
    errors.push('architecture must include components, data_model and security_boundaries');
  }
  if (!Array.isArray(plan.invariants) || !plan.invariants.length || plan.invariants.some((x) => typeof x !== 'string' || !x.trim())) {
    errors.push('invariants must be a non-empty list');
  }
  if (!Array.isArray(plan.assumptions) || plan.assumptions.some((x) => typeof x !== 'string' || !x.trim())) errors.push('assumptions must be a list of non-empty strings');
  if (!Array.isArray(plan.constraints) || plan.constraints.some((x) => typeof x !== 'string' || !x.trim())) errors.push('constraints must be a list of non-empty strings');
  if (!Array.isArray(plan.decisions)) errors.push('decisions must be an array');
  else {
    const decisionIds = new Set();
    for (const decision of plan.decisions) {
    if (!decision || typeof decision.id !== 'string' || !/^ADR-\d+$/.test(decision.id) || decisionIds.has(decision.id) || typeof decision.decision !== 'string' || !decision.decision.trim() ||
        typeof decision.rationale !== 'string' || !decision.rationale.trim() || !Array.isArray(decision.alternatives)) {
      errors.push(`${decision?.id ?? 'decision'}: decision, rationale and alternatives are required`);
    }
    if (typeof decision?.requires_human_approval !== 'boolean') errors.push(`${decision?.id ?? 'decision'}: requires_human_approval must be boolean`);
    decisionIds.add(decision?.id);
    }
  }
  if (!Array.isArray(plan.requirements) || !plan.requirements.length) errors.push('requirements must be a non-empty list');
  else {
    const ids = new Set();
    for (const r of plan.requirements) {
      if (!r || typeof r.id !== 'string' || !/^REQ-\d+$/.test(r.id) || ids.has(r.id)) errors.push(`bad or duplicate requirement id: ${r?.id ?? 'missing'}`);
      ids.add(r?.id);
      if (typeof r.description !== 'string' || !r.description.trim()) errors.push(`${r?.id ?? 'requirement'}: description is required`);
      if (!Array.isArray(r.acceptance_tests) || !r.acceptance_tests.length || r.acceptance_tests.some((x) => !nonPlaceholder(x))) errors.push(`${r?.id ?? 'requirement'}: meaningful acceptance_tests are required`);
      if (!Array.isArray(r.tasks) || !r.tasks.length) errors.push(`${r?.id ?? 'requirement'}: tasks mapping is required`);
    }
  }
  const c = plan.completion;
  if (!c || !Array.isArray(c.required_checks) || !c.required_checks.includes('ci') || !c.required_checks.includes('e2e')) {
    errors.push('completion must require ci and e2e checks');
  }
  if (!c?.smoke_test || typeof c.smoke_test !== 'object' || !nonPlaceholder(c.smoke_test.name) ||
      !nonPlaceholder(c.smoke_test.command) || !Array.isArray(c.smoke_test.assertions) ||
      c.smoke_test.assertions.length < 1 || c.smoke_test.assertions.some((x) => !nonPlaceholder(x))) {
    errors.push('completion.smoke_test must describe meaningful executable behavior and assertions');
  }
  if (c?.smoke_test?.command !== 'npm run e2e') errors.push('completion.smoke_test.command must be npm run e2e');
  const taskIds = new Set((plan.tasks ?? []).map((t) => t.id));
  for (const r of plan.requirements ?? []) for (const id of r.tasks ?? []) if (!taskIds.has(id)) errors.push(`${r.id}: unknown task mapping ${id}`);
}

export function validatePlan(plan, goalIds, { goalSnapshot = null } = {}) {
  if (!plan || typeof plan.goals_sha !== 'string' || !Array.isArray(plan.tasks)) {
    return ['plan must have goals_sha (string) and tasks (array)'];
  }
  const errors = [];
  validatePhase2Plan(plan, errors, goalIds, goalSnapshot);
  if (plan.tasks.length > LIMITS.maxTasks) errors.push(`more than ${LIMITS.maxTasks} tasks`);
  const seen = new Set();
  for (const t of plan.tasks) {
    const id = String(t?.id);
    if (!ID.test(id)) { errors.push(`bad id: ${id}`); continue; }
    if (seen.has(id)) errors.push(`duplicate id: ${id}`);
    seen.add(id);
    if (!goalIds.includes(t.goal) || !id.startsWith(`${t.goal}-`)) errors.push(`${id}: goal must be a GOALS.md heading and match the id prefix`);
    if (typeof t.title !== 'string' || !t.title.trim() || t.title.length > 200) errors.push(`${id}: title must be 1 to 200 characters`);
    if (!Array.isArray(t.acceptance) || !t.acceptance.length || t.acceptance.some((c) => typeof c !== 'string' || !c.trim())) {
      errors.push(`${id}: acceptance must be a non-empty list of non-empty strings`);
    }
    if (!Array.isArray(t.depends_on)) errors.push(`${id}: depends_on must be an array`);
    if (t.difficulty !== undefined && !['routine', 'hard'].includes(t.difficulty)) errors.push(`${id}: difficulty must be "routine" or "hard"`);
  }
  if (errors.length) return errors;
  const index = new Map(plan.tasks.map((t, i) => [t.id, i]));
  plan.tasks.forEach((t, i) => {
    for (const d of t.depends_on) {
      if (!index.has(d)) errors.push(`${t.id}: unknown dependency ${d}`);
      else if (index.get(d) >= i) errors.push(`${t.id}: dependency ${d} must appear earlier in the list`);
    }
  });
  return errors;
}

// Open PRs that no longer belong to the attempt the issue is leased to.
function stalePrs(i) {
  const st = i.open ? stateOf(i) : null;
  const prs = i.openPrs ?? [];
  if (i.open && (st === null || st === 'needs-human')) return [];
  if (st === 'in-progress' || st === 'in-review') return prs.filter((p) => p.attempt !== i.meta.attempt);
  return prs;
}

export function completionGate(s) {
  if (!s.goalSnapshot) return { ok: true, legacy: true, missing: [] };
  const missing = [];
  const checks = s.mainChecks ?? {};
  for (const name of s.plan?.completion?.required_checks ?? ['ci', 'e2e']) {
    if (checks[name] !== 'green') missing.push(`${name} check is not green`);
  }
  if (!s.finalReview || s.finalReview.sha !== s.mainSha || s.finalReview.goal_snapshot_sha !== s.goalSnapshot.hash || s.finalReview.verdict !== 'approve') missing.push('final review is not approved for the current main SHA and goal version');
  if (!s.finalReview?.reconciliation?.length || s.finalReview.reconciliation.some((x) => x.status !== 'satisfied')) missing.push('original goal is not fully reconciled by final review');
  if (s.finalReview?.findings?.some((f) => f.severity === 'blocking' || f.severity === 'major')) missing.push('final review has unresolved blocking findings');
  const unresolved = Object.values(s.status?.canonical?.findings ?? {}).filter((f) =>
    ['blocking', 'major'].includes(f.severity) && !['verified', 'resolved'].includes(f.status));
  if (unresolved.length) missing.push(`${unresolved.length} blocking audit finding(s) remain unresolved`);
  return { ok: missing.length === 0, legacy: false, missing };
}

export function effectiveTasks(s) {
  return [...(s.plan?.tasks ?? []), ...(s.status?.canonical?.corrections?.tasks ?? [])];
}

export function correctionTasks(review, baseTasks, round) {
  const findings = (review?.findings ?? []).filter((f) => ['blocking', 'major'].includes(f.severity));
  if (!findings.length) return { tasks: [], reason: 'rejected final review has no blocking findings' };
  if (findings.some((f) => f.autonomous_fix !== true)) return { tasks: [], reason: 'final review contains an ambiguous or non-autonomous correction' };
  if (findings.length > LIMITS.maxCorrectionTasks) return { tasks: [], reason: 'correction task limit exceeded' };
  const max = Math.max(0, ...baseTasks.map((t) => Number(/-T(\d+)$/.exec(t.id)?.[1] ?? 0)));
  const goal = baseTasks[0]?.goal ?? 'G1';
  return {
    tasks: findings.map((finding, index) => ({
      id: `${goal}-T${max + index + 1}`,
      goal,
      title: `Correct ${finding.id}: ${finding.problem}`.slice(0, 200),
      acceptance: [...new Set([finding.required_test, ...(finding.acceptance_tests ?? [])])],
      depends_on: [],
      difficulty: 'hard',
      corrective: true,
      source_finding: `final:${finding.id}`,
      correction_round: round,
      affected_commit: review.sha,
    })),
    reason: null,
  };
}

// Returns the next batch of actions. The caller applies them, reloads state and
// calls again until the batch is empty or contains a fire or a note.
export function decide(s) {
  if (s.unsafeState) return [{ type: 'note', text: `Canonical journal is ambiguous. Needs human reconciliation: ${s.unsafeState}` }];
  if (s.agentResults?.length) return [{ type: 'record-agent-results', results: s.agentResults }];
  if (s.agentRecoveryBlocked) return [{ type: 'note', text: `Codex execution recovery needs human attention: ${s.agentRecoveryBlocked}` }];
  if (s.agentCancellations?.length) return [{ type: 'cancel-agent-runs', cancellations: s.agentCancellations }];
  if (s.agentRecoveries?.length) return [{ type: 'retry-agent-dispatch', invocation: s.agentRecoveries[0].invocation, reason: s.agentRecoveries[0].reason }];
  const open = s.issues.filter((i) => i.open);
  const live = s.issues.filter((i) => !i.labels.includes('superseded'));
  const unmergedClosed = live.find((issue) => !issue.open && issue.mergedForAttempt === false);
  if (unmergedClosed) return [{ type: 'note', text: `Task ${unmergedClosed.meta.id} was closed without a confirmed merged attempt. Needs human.` }];
  if (s.goalCandidate?.needsIntake) return [{ type: 'intake-goal', issue: s.goalCandidate.number, provider: s.goalCandidate.requestedProvider }];
  if (s.goalCandidate && !s.goalSnapshot) return [{ type: 'snapshot-goal', issue: s.goalCandidate.number }];
  if (s.operationRecoveries?.length) return [{ type: 'recover-operations', operations: s.operationRecoveries }];
  if (s.stateDrift) return [{ type: 'reconcile', drift: s.stateDrift }];
  const activeProvider = s.status?.canonical?.provider?.active ?? null;
  const busy = s.issues.some((issue) => issue.open && ['in-progress', 'in-review'].includes(stateOf(issue)));
  const providerSwitch = s.desiredProvider && activeProvider !== s.desiredProvider;
  if (providerSwitch && !busy) {
    return [{ type: 'switch-provider', from: activeProvider, to: s.desiredProvider }];
  }
  const providerBlocked = s.status?.canonical?.provider?.blocked;
  if (providerBlocked) {
    if (s.providerResumeNonce && s.providerResumeNonce !== s.status.canonical.provider.resume_nonce) {
      return [{ type: 'resume-provider', provider: activeProvider, nonce: s.providerResumeNonce }];
    }
    if (!busy) return [{ type: 'note', text: `Provider unavailable. Needs human: ${providerBlocked}` }];
  }
  const invocationLimit = Number.isInteger(s.invocationLimit) && s.invocationLimit > 0
    ? Math.min(s.invocationLimit, LIMITS.maxInvocations) : LIMITS.maxInvocations;
  const invocationBudgetExhausted = (s.status?.canonical?.invocations?.length ?? 0) >= invocationLimit;
  const agentsPaused = providerSwitch || providerBlocked || s.agentsDisabled || invocationBudgetExhausted;
  const goalVersion = s.goalSnapshot?.hash ?? s.goalsSha;
  const activeAgent = (role, taskId = null) => (s.activeAgentInvocations ?? []).some((invocation) =>
    invocation.role === role && (taskId === null || invocation.task_id === taskId));
  const goalIds = s.goalSnapshot ? goalIdsForSnapshot(s.goalSnapshot.body) : s.goalIds;
  const planCurrent = !!s.plan && s.plan.goals_sha === goalVersion &&
    (!s.goalSnapshot || s.plan.goal_snapshot_sha === s.goalSnapshot.hash);
  const planErrors = planCurrent ? validatePlan(s.plan, goalIds, { goalSnapshot: s.goalSnapshot }) : [];
  if (planCurrent && Number.isInteger(s.taskLimit) && s.taskLimit > 0 && s.plan.tasks.length > s.taskLimit) {
    planErrors.push(`plan exceeds configured task limit of ${s.taskLimit}`);
  }
  const planOk = planCurrent && !planErrors.length && goalIds.length > 0;
  const allTasks = planOk ? effectiveTasks(s) : [];
  const early = ['planned', 'ready'];

  if (planOk) {
    const currentPlanHash = planVersionHash(s.plan);
    const required = (s.plan.decisions ?? []).filter((decision) => decision.requires_human_approval);
    const observed = new Set((s.decisionApprovals ?? []).filter((approval) => approval.plan_hash === currentPlanHash).map((approval) => approval.id));
    const approved = (decision) => {
      const record = s.status?.canonical?.decisions?.[`plan:${decision.id}`];
      return record?.status === 'approved' && record.plan_hash === currentPlanHash;
    };
    const toRecord = required.filter((decision) => observed.has(decision.id) && !approved(decision));
    if (toRecord.length) return [{ type: 'record-decision-approvals', planHash: currentPlanHash, decisions: toRecord.map((decision) => decision.id) }];
    const pending = required.filter((decision) => !approved(decision));
    if (pending.length) return [{ type: 'note', text: `Human architecture approval required: ${pending.map((decision) => decision.id).join(', ')} for plan ${currentPlanHash}.` }];
  }

  // One issue per task. GitHub's issue list can lag a create, so a duplicate is
  // repaired here whatever caused it: keep the issue furthest along, then the oldest.
  const rank = (i) => (!i.open ? 3 : early.includes(stateOf(i)) ? 1 : 2);
  const keep = new Map();
  for (const i of [...live].sort((a, b) => rank(b) - rank(a) || a.number - b.number)) if (!keep.has(i.meta.id)) keep.set(i.meta.id, i);
  const dupes = live.filter((i) => keep.get(i.meta.id) !== i && i.open && early.includes(stateOf(i)));
  if (dupes.length) return dupes.map((i) => ({ type: 'supersede', number: i.number }));

  if (planOk) {
    const sync = [];
    const byId = new Map(live.map((i) => [i.meta.id, i]));
    for (const t of allTasks) {
      const i = byId.get(t.id);
      if (!i) sync.push({ type: 'create', task: t });
      else if (i.open && i.meta.hash !== taskHash(t) && early.includes(stateOf(i))) sync.push({ type: 'update', number: i.number, task: t });
    }
    const ids = new Set(allTasks.map((t) => t.id));
    for (const i of open) {
      if (!ids.has(i.meta.id) && early.includes(stateOf(i))) sync.push({ type: 'supersede', number: i.number });
    }
    if (sync.length) return sync;
  }

  const moves = [];
  const done = new Set(live.filter((i) => !i.open && i.mergedForAttempt !== false).map((i) => i.meta.id));
  const taskById = new Map(allTasks.map((t) => [t.id, t]));
  for (const i of s.issues) {
    const st = i.open ? stateOf(i) : null;
    const pr = i.pr;
    const to = (state, reason, meta = undefined) => moves.push({ type: 'state', number: i.number, to: state, reason, ...(meta ? { meta } : {}) });
    if (i.open && st === null) { to('needs-human', 'no state label'); continue; }
    if (st === 'ready' && (i.meta.tries ?? 0) >= LIMITS.maxAttempts) {
      moves.push({ type: 'state', number: i.number, to: 'needs-human', reason: 'attempts exhausted', meta: { tries: 0 } });
      continue;
    }
    // A superseded issue gives no say over PRs that a live issue for the same task owns.
    const owner = i.labels.includes('superseded') ? keep.get(i.meta.id) : i;
    if (!owner || owner === i) for (const p of stalePrs(i)) moves.push({ type: 'closePr', number: p.number, issue: i.number });
    if (st === 'in-progress' || st === 'in-review') {
      const m = i.meta;
      const lease = m.leaseAt ?? 0;
      const review = () => {
        if (agentsPaused) return;
        if ((m.reviews ?? 0) >= LIMITS.maxReviews) to('needs-human', 'review limit reached');
        else moves.push({ type: 'fire', role: 'reviewer', number: i.number, pr: pr.number, sha: pr.headSha, reviews: (m.reviews ?? 0) + 1, route: 'reviewer' });
      };
      // Back to the worker with a fresh lease, so its fix is not cut short.
      const back = (reason) => moves.push({ type: 'state', number: i.number, to: 'in-progress', reason, meta: { leaseAt: s.now } });
      if (pr?.state === 'merged') moves.push({ type: 'close', number: i.number });
      else if (pr?.unauthorizedAuthor) to('needs-human', 'PR author is not the configured worker identity');
      else if (pr?.protectedFiles) to('needs-human', 'PR touches protected paths');
      else if (pr?.weakened) to('needs-human', pr.weakened);
      else if (pr && pr.files > LIMITS.maxFiles) to('needs-human', 'PR too large to validate');
      else if (st === 'in-progress') {
        if (pr?.state === 'open' && pr.ci === 'green') {
          if (agentsPaused && (s.now - Math.max(lease, i.lastCommitAt ?? 0) > LIMITS.leaseMs || s.now - lease > LIMITS.maxLeaseMs)) to('ready', 'provider change or outage after lease expiry');
          else review();
        }
        else if (pr?.state === 'open' && pr.ci === 'red') to('ready', 'CI red');
        else if (!activeAgent('worker', i.meta.id) && !activeAgent('corrective-worker', i.meta.id) &&
          (s.now - Math.max(lease, i.lastCommitAt ?? 0) > LIMITS.leaseMs || s.now - lease > LIMITS.maxLeaseMs)) to('ready', 'lease expired');
      } else if (pr?.state !== 'open') to('ready', 'PR closed');
      else if (pr.headSha !== m.reviewSha) back('commits changed during review');
      else if (pr.ci === 'red') back('CI red');
      else if (i.review?.invalid) to('needs-human', `invalid review result: ${i.review.invalid}`);
      else {
        // A verdict counts only for the commit under review and only if it was
        // posted after this review began. Approval alone merges nothing: CI,
        // paths, size, conflicts and freshness were all checked above or below,
        // by this code, on that same commit.
        const v = i.review && i.review.sha === pr.headSha && i.review.at > (m.reviewAt ?? 0) ? i.review.verdict : null;
        if (v === 'reject') to('ready', `review rejected, see #${pr.number}`, { reviewFindings: i.review.findings ?? [] });
        else if (v === 'approve') {
          if (pr.ci !== 'green' || pr.mergeable === null) { /* wait for CI or GitHub */ }
          else if (pr.behind) to('ready', 'branch is behind main');
          else if (!pr.mergeable) to('ready', 'merge conflict');
          else moves.push({ type: 'merge', number: pr.number, issue: i.number, sha: pr.headSha });
        } else if (s.now - (m.reviewAt ?? 0) > LIMITS.reviewLeaseMs && !activeAgent('reviewer', i.meta.id)) {
          if (agentsPaused) to('ready', 'provider change or outage after review lease expiry');
          else review();
        }
      }
    } else if (st === 'planned') {
      const t = taskById.get(i.meta.id);
      if (t && t.depends_on.every((d) => done.has(d))) to('ready');
    }
  }
  if (moves.length) return moves;

  if (!goalIds.length) return [{ type: 'note', text: 'No goal headings or immutable goal issue snapshot exists. Nothing to plan.' }];
  const notes = planErrors.length ? [{ type: 'note', text: `Plan rejected: ${planErrors.join('; ')}` }] : [];
  if (providerSwitch) notes.push({ type: 'note', text: `Provider switch from ${activeProvider ?? 'unset'} to ${s.desiredProvider} is waiting for active leases to expire.` });
  else if (providerBlocked) notes.push({ type: 'note', text: `Provider unavailable. Needs human: ${providerBlocked}` });
  if (s.agentsDisabled) notes.push({ type: 'note', text: 'Agent execution is disabled by factory configuration.' });
  if (invocationBudgetExhausted) notes.push({ type: 'note', text: `Goal invocation budget of ${invocationLimit} is exhausted. Needs human.` });
  if (open.some((i) => ['in-progress', 'in-review'].includes(stateOf(i)))) return notes;
  if (s.agentsDisabled || invocationBudgetExhausted) return notes;
  if (!planOk) {
    // A missing, outdated or rejected plan: ask the planner again, within its limits.
    if (activeAgent('planner')) return notes;
    const same = s.status.plannerFiredSha === goalVersion;
    const fires = same ? s.status.plannerFires : 0;
    if (same && s.now - s.status.plannerFiredAt < LIMITS.plannerRetryMs) return notes;
    if (fires >= LIMITS.maxPlannerFires) return [...notes, { type: 'note', text: `Planner produced no usable plan for ${goalVersion} after ${fires} runs. Needs human.` }];
    return [...notes, { type: 'fire', role: 'planner', sha: goalVersion, ...(s.goalSnapshot ? { goalIssue: s.goalSnapshot.issue } : {}), fires: fires + 1, route: 'planner' }];
  }
  if (s.missingMainChecks?.length) {
    if (s.mainCiWorkflowActive) return [];
    return [{ type: 'ensure-main-ci', sha: s.mainSha, missing: s.missingMainChecks }];
  }
  if (s.mainChecks && (s.mainChecks.ci === 'pending' || s.mainChecks.e2e === 'pending')) return [];
  if (s.mainCi === 'red' || s.mainChecks?.e2e === 'red') return [{ type: 'note', text: 'CI is red on main. No new work started.' }];
  const next = allTasks.map((t) => open.find((i) => i.meta.id === t.id)).find((i) => i && stateOf(i) === 'ready');
  if (next) {
    // attempt only ever grows (it names the branch); tries counts toward the limit.
    const attempt = (next.meta.attempt ?? 0) + 1;
    const tries = (next.meta.tries ?? 0) + 1;
    const hard = taskById.get(next.meta.id).difficulty === 'hard';
    return [{ type: 'fire', role: 'worker', number: next.number, attempt, tries, route: hard || tries >= LIMITS.maxAttempts ? 'escalation' : 'worker' }];
  }
  if (allTasks.every((t) => done.has(t.id))) {
    const gate = completionGate(s);
    if (gate.legacy) return [{ type: 'note', text: 'Complete' }];
    if (gate.ok) return [{ type: 'note', text: 'Complete' }];
    if (s.finalReview?.invalid) return [{ type: 'note', text: `Final review rejected: ${s.finalReview.invalid}` }];
    if (s.missingMainChecks?.length) {
      if (s.mainCiWorkflowActive) return [];
      return [{ type: 'ensure-main-ci', sha: s.mainSha, missing: s.missingMainChecks }];
    }
    if (s.mainChecks?.ci !== 'green' || s.mainChecks?.e2e !== 'green') return [{ type: 'note', text: `Completion blocked: ${gate.missing.join('; ')}` }];
    if (s.finalReview?.verdict === 'reject') {
      const corrections = s.status?.canonical?.corrections ?? { round: 0, tasks: [] };
      if (corrections.round >= LIMITS.maxCorrectionRounds) return [{ type: 'note', text: 'Final-review correction budget exhausted. Needs human.' }];
      const generated = correctionTasks(s.finalReview, allTasks, corrections.round + 1);
      if (generated.reason) return [{ type: 'note', text: `${generated.reason}. Needs human.` }];
      return [{ type: 'add-corrections', review: s.finalReview, round: corrections.round + 1, tasks: generated.tasks }];
    }
    if (activeAgent('final-reviewer')) return [];
    if ((s.status.finalReviewFires ?? 0) >= LIMITS.maxFinalReviews) return [{ type: 'note', text: `Final review limit reached. Needs human: ${gate.missing.join('; ')}` }];
    if (s.status.finalReviewAt && s.now - s.status.finalReviewAt < LIMITS.reviewLeaseMs) return [];
    return [{ type: 'fire', role: 'final-reviewer', sha: s.mainSha, goalIssue: s.goalSnapshot.issue, fires: (s.status.finalReviewFires ?? 0) + 1, route: 'final-reviewer' }];
  }
  return [];
}
