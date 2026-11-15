import { createHash } from 'node:crypto';

export const LIMITS = {
  maxTasks: 25, maxAttempts: 3, leaseMs: 90 * 60000, maxLeaseMs: 4 * 60 * 60000,
  plannerRetryMs: 60 * 60000, maxPlannerFires: 3,
  reviewLeaseMs: 45 * 60000, maxReviews: 2, maxFiles: 100,
};
export const STATES = ['planned', 'ready', 'in-progress', 'in-review', 'needs-human'];
export const BRANCH = /^factory\/(G\d+-T\d+)-a(\d+)$/;
// Never merged automatically: the owner's file, the factory itself, secrets,
// and deployment, infrastructure or database-migration files.
const PROTECTED = [
  /^GOALS\.md$/, /^\.github\//, /^\.claude\//, /^CODEOWNERS$/,
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

// The newest review verdict among a PR's comments (oldest first), or null.
export function pickReview(comments) {
  for (const c of [...comments].reverse()) {
    const m = REVIEW.exec(c.body ?? '');
    if (!m) continue;
    try {
      const v = JSON.parse(m[1]);
      if (typeof v.sha === 'string' && ['approve', 'reject'].includes(v.verdict)) return { sha: v.sha, verdict: v.verdict, at: Date.parse(c.created_at) };
    } catch { /* not a verdict */ }
  }
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

export function ciState(checkRuns) {
  // Only a run reported by GitHub Actions counts; no other identity can vouch for CI.
  const runs = checkRuns.filter((c) => c.name === 'ci' && c.app?.slug === 'github-actions')
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
  if (st === 'in-progress' || st === 'in-review') return prs.filter((p) => p.attempt !== i.meta.attempt);
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
    if (st === 'in-progress' || st === 'in-review') {
      const m = i.meta;
      const lease = m.leaseAt ?? 0;
      const review = () => {
        if ((m.reviews ?? 0) >= LIMITS.maxReviews) to('needs-human', 'review limit reached');
        else moves.push({ type: 'fire', role: 'reviewer', number: i.number, pr: pr.number, sha: pr.headSha, reviews: (m.reviews ?? 0) + 1, route: 'reviewer' });
      };
      // Back to the worker with a fresh lease, so its fix is not cut short.
      const back = (reason) => moves.push({ type: 'state', number: i.number, to: 'in-progress', reason, meta: { leaseAt: s.now } });
      if (pr?.state === 'merged') moves.push({ type: 'close', number: i.number });
      else if (pr?.protectedFiles) to('needs-human', 'PR touches protected paths');
      else if (pr?.weakened) to('needs-human', pr.weakened);
      else if (pr && pr.files > LIMITS.maxFiles) to('needs-human', 'PR too large to validate');
      else if (st === 'in-progress') {
        if (pr?.state === 'open' && pr.ci === 'green') review();
        else if (s.now - Math.max(lease, i.lastCommitAt ?? 0) > LIMITS.leaseMs || s.now - lease > LIMITS.maxLeaseMs) to('ready', 'lease expired');
      } else if (pr?.state !== 'open') to('ready', 'PR closed');
      else if (pr.headSha !== m.reviewSha) back('commits changed during review');
      else if (pr.ci === 'red') back('CI red');
      else {
        // A verdict counts only for the commit under review and only if it was
        // posted after this review began. Approval alone merges nothing: CI,
        // paths, size, conflicts and freshness were all checked above or below,
        // by this code, on that same commit.
        const v = i.review && i.review.sha === pr.headSha && i.review.at > (m.reviewAt ?? 0) ? i.review.verdict : null;
        if (v === 'reject') to('ready', `review rejected, see #${pr.number}`);
        else if (v === 'approve') {
          if (pr.ci !== 'green' || pr.mergeable === null) { /* wait for CI or GitHub */ }
          else if (pr.behind) to('ready', 'branch is behind main');
          else if (!pr.mergeable) to('ready', 'merge conflict');
          else moves.push({ type: 'merge', number: pr.number, issue: i.number, sha: pr.headSha });
        } else if (s.now - (m.reviewAt ?? 0) > LIMITS.reviewLeaseMs) review();
      }
    } else if (st === 'planned') {
      const t = taskById.get(i.meta.id);
      if (t && t.depends_on.every((d) => done.has(d))) to('ready');
    }
  }
  if (moves.length) return moves;

  if (!s.goalIds.length) return [{ type: 'note', text: 'GOALS.md has no "## G<n>: title" headings. Nothing to plan.' }];
  const notes = planErrors.length ? [{ type: 'note', text: `Plan rejected: ${planErrors.join('; ')}` }] : [];
  if (open.some((i) => ['in-progress', 'in-review'].includes(stateOf(i)))) return notes;
  if (!planOk) {
    // A missing, outdated or rejected plan: ask the planner again, within its limits.
    const same = s.status.plannerFiredSha === s.goalsSha;
    const fires = same ? s.status.plannerFires : 0;
    if (same && s.now - s.status.plannerFiredAt < LIMITS.plannerRetryMs) return notes;
    if (fires >= LIMITS.maxPlannerFires) return [...notes, { type: 'note', text: `Planner produced no usable plan for ${s.goalsSha} after ${fires} runs. Needs human.` }];
    return [...notes, { type: 'fire', role: 'planner', sha: s.goalsSha, fires: fires + 1, route: 'planner' }];
  }
  if (s.mainCi === 'red') return [{ type: 'note', text: 'CI is red on main. No new work started.' }];
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
