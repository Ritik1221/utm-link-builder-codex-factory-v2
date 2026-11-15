import {
  decide, parseGoalIds, parseMeta, withMeta, renderIssue, taskHash,
  stateOf, touchesProtected, ciState, branchOf, fireOutcome, pickReview, weakened, STATES, BRANCH,
} from './lib.mjs';

const { GITHUB_TOKEN, GITHUB_REPOSITORY: REPO } = process.env;
const r = `/repos/${REPO}`;
const LABELS = [...STATES, 'superseded', 'factory-task', 'factory-status'];

// Model routing: a routine runs one model, so each route may name its own
// routine (FACTORY_ROUTINE_ID_PLANNER, _WORKER, _ESCALATION, _REVIEWER and the matching
// FACTORY_FIRE_TOKEN_*). Unset routes fall back to the base pair.
function routine(route) {
  const R = route.toUpperCase();
  const id = process.env[`FACTORY_ROUTINE_ID_${R}`];
  const token = process.env[`FACTORY_FIRE_TOKEN_${R}`];
  return id && token ? { id, token } : { id: process.env.FACTORY_ROUTINE_ID, token: process.env.FACTORY_FIRE_TOKEN };
}

async function gh(method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 && method === 'GET') return null;
  if (res.status === 422 && path === `${r}/labels`) return null; // label already exists
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
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
  const f = await gh('GET', `${r}/contents/${path}?ref=${encodeURIComponent(ref)}`);
  return f ? Buffer.from(f.content, 'base64').toString() : null;
}

const ciOf = async (sha) => ciState((await gh('GET', `${r}/commits/${sha}/check-runs?per_page=100`))?.check_runs ?? []);

async function scripts(ref) {
  try { return JSON.parse((await file('package.json', ref)) ?? '{}').scripts ?? {}; } catch { return {}; }
}

// Everything the merge decision needs, read fresh for one commit of one PR.
async function prDetails(number) {
  const p = await gh('GET', `${r}/pulls/${number}`);
  const sha = p.head.sha;
  const files = await all(`${r}/pulls/${number}/files`);
  const cmp = await gh('GET', `${r}/compare/main...${sha}`);
  return {
    number,
    state: p.merged_at ? 'merged' : p.state,
    headSha: sha,
    ci: await ciOf(sha),
    files: files.length,
    protectedFiles: touchesProtected(files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean))),
    weakened: weakened(files, await scripts('main'), await scripts(sha)),
    mergeable: p.mergeable,
    behind: !cmp || cmp.behind_by > 0, // CI ran on this tree only if nothing landed on main since
  };
}

let statusNumber = null;
async function loadStatus() {
  // The oldest status issue is the one; reopen it rather than lose the planner counters.
  // Looked up by number after the first time: the issue list lags behind a create.
  let s = statusNumber ? await gh('GET', `${r}/issues/${statusNumber}`)
    : (await gh('GET', `${r}/issues?state=all&labels=factory-status&sort=created&direction=asc&per_page=1`))[0];
  if (!s) s = await gh('POST', `${r}/issues`, { title: 'Factory status', body: withMeta('Starting.', {}), labels: ['factory-status'] });
  else if (s.state !== 'open') await gh('PATCH', `${r}/issues/${s.number}`, { state: 'open' });
  statusNumber = s.number;
  return { number: s.number, body: s.body, plannerFiredSha: null, plannerFiredAt: 0, plannerFires: 0, pending: [], ...parseMeta(s.body) };
}

async function loadState() {
  const goalsSha = (await gh('GET', `${r}/commits?path=GOALS.md&sha=main&per_page=1`))?.[0]?.sha ?? null;
  let plan;
  try { plan = JSON.parse((await file('factory/plan.json', 'factory/plan')) ?? 'null'); } catch { plan = { goals_sha: goalsSha, tasks: null }; }

  // Factory PRs grouped by task id; newest first within a task.
  const prsById = new Map();
  for (const p of (await all(`${r}/pulls?state=all&sort=created&direction=desc`)).filter((x) => x.head.repo?.full_name === REPO && x.base.ref === 'main')) {
    const m = BRANCH.exec(p.head.ref);
    if (m) prsById.set(m[1], [...(prsById.get(m[1]) ?? []), { ...p, attempt: Number(m[2]) }]);
  }

  // The issue list lags behind a create. Issues created recently are recorded in
  // the status marker and read by number until the list shows them.
  const status = await loadStatus();
  const listed = (await all(`${r}/issues?state=all&labels=factory-task`)).filter((x) => !x.pull_request);
  const missing = status.pending.filter((n) => !listed.some((x) => x.number === n));
  for (const n of missing) listed.push(await gh('GET', `${r}/issues/${n}`));
  status.pending = missing;

  const issues = [];
  for (const i of listed) {
    const meta = parseMeta(i.body);
    if (!meta?.id) continue;
    const prs = prsById.get(meta.id) ?? [];
    const issue = {
      number: i.number, open: i.state === 'open', labels: i.labels.map((l) => l.name), meta, body: i.body,
      openPrs: prs.filter((p) => p.state === 'open').map((p) => ({ number: p.number, attempt: p.attempt })),
      pr: null, lastCommitAt: 0,
    };
    const st = issue.open ? stateOf(issue) : null;
    if (st === 'in-progress' || st === 'in-review') {
      const current = prs.find((p) => p.attempt === meta.attempt);
      if (current) issue.pr = await prDetails(current.number);
      if (current && st === 'in-review') issue.review = pickReview(await all(`${r}/issues/${current.number}/comments`));
      const branch = await gh('GET', `${r}/branches/${encodeURIComponent(branchOf(meta.id, meta.attempt))}`);
      if (branch) issue.lastCommitAt = Date.parse(branch.commit.commit.committer.date);
    }
    issues.push(issue);
  }
  const main = await gh('GET', `${r}/commits/main`);
  return {
    now: Date.now(), goalsSha, plan, issues,
    goalIds: parseGoalIds((await file('GOALS.md', 'main')) ?? ''),
    status,
    mainCi: await ciOf(main.sha),
  };
}

async function setState(issue, to, metaPatch = {}) {
  const labels = issue.labels.filter((l) => !STATES.includes(l)).concat(to);
  await gh('PATCH', `${r}/issues/${issue.number}`, { labels, body: withMeta(issue.body, { ...issue.meta, ...metaPatch }) });
}

const planner = ({ plannerFiredSha, plannerFiredAt, plannerFires, pending }) => ({ plannerFiredSha, plannerFiredAt, plannerFires, pending });
const saveStatus = (status, meta) => gh('PATCH', `${r}/issues/${status.number}`, { body: withMeta(status.body, meta) });

// 'ok': a session started. 'refused': a 4xx, so no session exists.
// 'unknown': a 5xx or no answer, so a session may or may not have started.
async function fire(route, text) {
  const { id, token } = routine(route);
  if (!id || !token) { console.log(`fire "${text}" (${route}) -> no routine configured`); return 'refused'; }
  try {
    const res = await fetch(`https://api.anthropic.com/v1/claude_code/routines/${id}/fire`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(60000),
    });
    console.log(`fire "${text}" (${route}) -> HTTP ${res.status}`);
    return fireOutcome(res.status);
  } catch (e) {
    console.log(`fire "${text}" (${route}) -> ${e.name}`);
    return 'unknown';
  }
}

// Returns true when the run must stop after this batch.
async function apply(a, s, notes) {
  const issue = s.issues.find((i) => i.number === a.number);
  switch (a.type) {
    case 'create': {
      const { title, body } = renderIssue(a.task, { id: a.task.id, hash: taskHash(a.task), attempt: 0 });
      const made = await gh('POST', `${r}/issues`, { title, body, labels: ['factory-task', 'planned'] });
      s.status.pending.push(made.number);
      await saveStatus(s.status, planner(s.status));
      return false;
    }
    case 'update': {
      const { title, body } = renderIssue(a.task, { ...issue.meta, hash: taskHash(a.task) });
      await gh('PATCH', `${r}/issues/${a.number}`, { title, body });
      return false;
    }
    case 'supersede':
      await gh('PATCH', `${r}/issues/${a.number}`, { state: 'closed', state_reason: 'not_planned', labels: ['factory-task', 'superseded'] });
      return false;
    case 'close':
      await gh('PATCH', `${r}/issues/${a.number}`, { state: 'closed' });
      return false;
    case 'closePr':
      await gh('PATCH', `${r}/pulls/${a.number}`, { state: 'closed' });
      await gh('POST', `${r}/issues/${a.number}/comments`, { body: `Factory: closed because issue #${a.issue} is no longer assigned to this attempt.` });
      return false;
    case 'merge': {
      // GitHub merges only if the head is still exactly the validated commit.
      const task = s.issues.find((i) => i.number === a.issue);
      try {
        await gh('PUT', `${r}/pulls/${a.number}/merge`, { sha: a.sha, merge_method: 'squash' });
        await gh('POST', `${r}/issues/${a.issue}/comments`, { body: `Factory: merged #${a.number} at \`${a.sha}\`.` });
      } catch (e) {
        await setState(task, 'needs-human');
        await gh('POST', `${r}/issues/${a.issue}/comments`, { body: `Factory: moved to \`needs-human\` (merge of #${a.number} at \`${a.sha}\` refused: ${e.message.slice(0, 300)}).` });
      }
      return false;
    }
    case 'state':
      await setState(issue, a.to, a.meta);
      if (a.reason) await gh('POST', `${r}/issues/${a.number}/comments`, { body: `Factory: moved to \`${a.to}\` (${a.reason}).` });
      return false;
    case 'note':
      notes.push(a.text);
      return true;
    case 'fire': {
      if (a.role === 'planner') {
        // Record first, so a crash after the call can never hide a fire.
        // An unanswered fire counts as a fire: the session may exist.
        const before = planner(s.status);
        const fired = { ...before, plannerFiredSha: a.sha, plannerFiredAt: s.now, plannerFires: a.fires };
        await saveStatus(s.status, fired);
        if ((await fire(a.route, `ROLE=planner SHA=${a.sha}`)) === 'refused') {
          await saveStatus(s.status, before);
          notes.push('Planner fire refused. Will retry on the next run.');
        } else s.status = { ...s.status, ...fired };
        return true;
      }
      if (a.role === 'reviewer') {
        // Only a verdict posted after this moment, for this commit, will count.
        await setState(issue, 'in-review', { reviewSha: a.sha, reviewAt: Date.now(), reviews: a.reviews });
        const result = await fire(a.route, `ROLE=reviewer ISSUE=${a.number} PR=${a.pr} SHA=${a.sha}`);
        if (result === 'refused') {
          await setState(issue, stateOf(issue)); // roll back: no review spent
          notes.push(`Reviewer fire refused for #${a.number}. Will retry on the next run.`);
        } else if (result === 'unknown') {
          notes.push(`Reviewer fire for #${a.number} got no answer. It is refired if no verdict arrives.`);
        }
        return true;
      }
      // Lease first, so a concurrent reader never sees a session without a lease.
      await setState(issue, 'in-progress', { attempt: a.attempt, tries: a.tries, leaseAt: s.now, reviews: 0 });
      const result = await fire(a.route, `ROLE=worker ISSUE=${a.number} ATTEMPT=${a.attempt}`);
      if (result === 'refused') {
        await setState(issue, 'ready'); // roll back: original labels and meta, no attempt spent
        notes.push(`Worker fire refused for #${a.number}. Will retry on the next run.`);
      } else if (result === 'unknown') {
        notes.push(`Worker fire for #${a.number} got no answer. The lease stands and will expire if no session started.`);
      }
      return true;
    }
    default:
      throw new Error(`unknown action ${a.type}`);
  }
}

async function writeStatus(status, notes) {
  const s = await loadState();
  const rows = s.issues.map((i) => `| #${i.number} | ${i.meta.id} | ${i.open ? stateOf(i) : i.labels.includes('superseded') ? 'superseded' : 'done'} | ${i.meta.tries ?? 0} | ${i.pr ? `#${i.pr.number} (${i.pr.ci})` : ''} |`);
  const body = [
    `Updated ${new Date(s.now).toISOString()}. GOALS.md at \`${s.goalsSha}\`, plan at \`${s.plan?.goals_sha ?? 'none'}\`.`, '',
    ...(notes.length ? ['**Notes**', ...notes.map((n) => `- ${n}`), ''] : []),
    '| Issue | Task | State | Tries | PR |', '|---|---|---|---|---|', ...rows,
  ].join('\n');
  await gh('PATCH', `${r}/issues/${s.status.number}`, { body: withMeta(body, planner(status)) });
}

for (const name of LABELS) await gh('POST', `${r}/labels`, { name });
const notes = [];
let s;
for (let pass = 0; pass < 6; pass++) {
  s = await loadState();
  const actions = decide(s);
  console.log(`pass ${pass}: ${JSON.stringify(actions)}`);
  let stop = actions.length === 0;
  for (const a of actions) stop = (await apply(a, s, notes)) || stop;
  if (stop) break;
}
await writeStatus(s.status, notes);
