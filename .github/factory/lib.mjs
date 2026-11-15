import { createHash } from 'node:crypto';

export const LIMITS = {
  maxTasks: 25, maxAttempts: 3, leaseMs: 90 * 60000, maxLeaseMs: 4 * 60 * 60000,
  plannerRetryMs: 60 * 60000, maxPlannerFires: 3, maxAwaitingMerge: 2,
};
export const STATES = ['planned', 'ready', 'in-progress', 'awaiting-merge', 'needs-human'];
export const BRANCH = /^factory\/(G\d+-T\d+)-a(\d+)$/;
const PROTECTED = [/^GOALS\.md$/, /^\.github\//, /^\.claude\//];
const ID = /^G\d+-T\d+$/;
const MARK = /<!-- factory-meta (.*?) -->/s;

export const parseGoalIds = (md) => [...md.matchAll(/^## (G\d+):/gm)].map((m) => m[1]);
export const touchesProtected = (files) => files.some((f) => PROTECTED.some((re) => re.test(f)));
export const stateOf = (issue) => STATES.find((s) => issue.labels.includes(s)) ?? null;
// Each attempt works on its own branch, so a worker from an earlier attempt
// can never push into the branch the current attempt is judged on.
export const branchOf = (id, attempt) => `factory/${id}-a${attempt}`;
export const taskHash = (t) =>
  createHash('sha1')
    .update(JSON.stringify([t.goal, t.title, t.acceptance, t.depends_on, t.difficulty ?? 'routine']))
    .digest('hex').slice(0, 12);

// What a /fire HTTP status proves. Only a 4xx proves no session was started;
// a 5xx or no answer at all may still have started one.
export const fireOutcome = (status) =>
  status >= 200 && status < 300 ? 'ok' : status >= 400 && status < 500 ? 'refused' : 'unknown';

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

export function ciState(checkRuns) {
  const runs = checkRuns.filter((c) => c.name === 'ci')
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  if (!runs.length || runs[0].status !== 'completed') return 'pending';
  return runs[0].conclusion === 'success' ? 'green' : 'red';
}

export function validatePlan(plan, goalIds) {
  if (!plan || typeof plan.goals_sha !== 'string' || !Array.isArray(plan.tasks)) {
    return ['plan must have goals_sha (string) and tasks (array)'];
  }
  const errors = [];
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
  if (st === 'in-progress' || st === 'awaiting-merge') return prs.filter((p) => p.attempt !== i.meta.attempt);
  return prs;
}

// Returns the next batch of actions. The caller applies them, reloads state and
// calls again until the batch is empty or contains a fire or a note.
export function decide(s) {
  const open = s.issues.filter((i) => i.open);
  const live = s.issues.filter((i) => !i.labels.includes('superseded'));
  const planCurrent = !!s.plan && s.plan.goals_sha === s.goalsSha;
  const planErrors = planCurrent ? validatePlan(s.plan, s.goalIds) : [];
  const planOk = planCurrent && !planErrors.length && s.goalIds.length > 0;
  const early = ['planned', 'ready'];

  if (planOk) {
    const sync = [];
    const byId = new Map(live.map((i) => [i.meta.id, i]));
    for (const t of s.plan.tasks) {
      const i = byId.get(t.id);
      if (!i) sync.push({ type: 'create', task: t });
      else if (i.open && i.meta.hash !== taskHash(t) && early.includes(stateOf(i))) sync.push({ type: 'update', number: i.number, task: t });
    }
    const ids = new Set(s.plan.tasks.map((t) => t.id));
    for (const i of open) {
      if (!ids.has(i.meta.id) && early.includes(stateOf(i))) sync.push({ type: 'supersede', number: i.number });
    }
    if (sync.length) return sync;
  }

  const moves = [];
  const done = new Set(live.filter((i) => !i.open).map((i) => i.meta.id));
  const taskById = new Map((planOk ? s.plan.tasks : []).map((t) => [t.id, t]));
  for (const i of s.issues) {
    const st = i.open ? stateOf(i) : null;
    const pr = i.pr;
    const to = (state, reason) => moves.push({ type: 'state', number: i.number, to: state, reason });
    if (i.open && st === null) { to('needs-human', 'no state label'); continue; }
    if (st === 'ready' && (i.meta.tries ?? 0) >= LIMITS.maxAttempts) {
      moves.push({ type: 'state', number: i.number, to: 'needs-human', reason: 'attempts exhausted', meta: { tries: 0 } });
      continue;
    }
    for (const p of stalePrs(i)) moves.push({ type: 'closePr', number: p.number, issue: i.number });
    if (st === 'in-progress' || st === 'awaiting-merge') {
      const lease = i.meta.leaseAt ?? 0;
      if (pr?.state === 'merged') moves.push({ type: 'close', number: i.number });
      else if (pr?.protectedFiles) to('needs-human', 'PR touches protected paths');
      else if (st === 'in-progress' && pr?.state === 'open' && pr.ci === 'green') to('awaiting-merge');
      else if (st === 'awaiting-merge' && (pr?.state !== 'open' || pr.ci === 'red')) to('ready', 'PR closed or CI red');
      else if (st === 'in-progress' && (s.now - Math.max(lease, i.lastCommitAt ?? 0) > LIMITS.leaseMs || s.now - lease > LIMITS.maxLeaseMs)) to('ready', 'lease expired');
    } else if (st === 'planned') {
      const t = taskById.get(i.meta.id);
      if (t && t.depends_on.every((d) => done.has(d))) to('ready');
    }
  }
  if (moves.length) return moves;

  if (!s.goalIds.length) return [{ type: 'note', text: 'GOALS.md has no "## G<n>: title" headings. Nothing to plan.' }];
  const notes = planErrors.length ? [{ type: 'note', text: `Plan rejected: ${planErrors.join('; ')}` }] : [];
  if (open.some((i) => stateOf(i) === 'in-progress')) return notes;
  if (!planOk) {
    // A missing, outdated or rejected plan: ask the planner again, within its limits.
    const same = s.status.plannerFiredSha === s.goalsSha;
    const fires = same ? s.status.plannerFires : 0;
    if (same && s.now - s.status.plannerFiredAt < LIMITS.plannerRetryMs) return notes;
    if (fires >= LIMITS.maxPlannerFires) return [...notes, { type: 'note', text: `Planner produced no usable plan for ${s.goalsSha} after ${fires} runs. Needs human.` }];
    return [...notes, { type: 'fire', role: 'planner', sha: s.goalsSha, fires: fires + 1, route: 'planner' }];
  }
  if (s.mainCi === 'red') return [{ type: 'note', text: 'CI is red on main. No new work started.' }];
  if (open.filter((i) => stateOf(i) === 'awaiting-merge').length >= LIMITS.maxAwaitingMerge) return [];
  const next = s.plan.tasks.map((t) => open.find((i) => i.meta.id === t.id)).find((i) => i && stateOf(i) === 'ready');
  if (next) {
    // attempt only ever grows (it names the branch); tries counts toward the limit.
    const attempt = (next.meta.attempt ?? 0) + 1;
    const tries = (next.meta.tries ?? 0) + 1;
    const hard = taskById.get(next.meta.id).difficulty === 'hard';
    return [{ type: 'fire', role: 'worker', number: next.number, attempt, tries, route: hard || tries >= LIMITS.maxAttempts ? 'escalation' : 'worker' }];
  }
  if (s.plan.tasks.every((t) => done.has(t.id))) return [{ type: 'note', text: 'Complete' }];
  return [];
}
