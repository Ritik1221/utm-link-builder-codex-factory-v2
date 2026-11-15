import {
  decide, parseGoalIds, parseMeta, withMeta, renderIssue, taskHash,
  stateOf, touchesProtected, ciState, branchOf, STATES, BRANCH,
} from './lib.mjs';

const { GITHUB_TOKEN, GITHUB_REPOSITORY: REPO } = process.env;
const r = `/repos/${REPO}`;
const LABELS = [...STATES, 'superseded', 'factory-task', 'factory-status'];

// Model routing: a routine runs one model, so each route may name its own
// routine (FACTORY_ROUTINE_ID_PLANNER, _WORKER, _ESCALATION and the matching
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

async function prDetails(p) {
  const files = (await all(`${r}/pulls/${p.number}/files`)).map((f) => f.filename);
  return {
    number: p.number,
    state: p.merged_at ? 'merged' : p.state,
    ci: await ciOf(p.head.sha),
    protectedFiles: touchesProtected(files),
  };
}

async function loadStatus() {
  let [s] = await gh('GET', `${r}/issues?state=open&labels=factory-status&per_page=1`);
  if (!s) s = await gh('POST', `${r}/issues`, { title: 'Factory status', body: withMeta('Starting.', {}), labels: ['factory-status'] });
  return { number: s.number, plannerFiredSha: null, plannerFiredAt: 0, plannerFires: 0, ...parseMeta(s.body) };
}

async function loadState() {
  const goalsSha = (await gh('GET', `${r}/commits?path=GOALS.md&sha=main&per_page=1`))?.[0]?.sha ?? null;
  let plan;
  try { plan = JSON.parse((await file('factory/plan.json', 'factory/plan')) ?? 'null'); } catch { plan = { goals_sha: goalsSha, tasks: null }; }

  // Factory PRs grouped by task id; newest first within a task.
  const prsById = new Map();
  for (const p of (await all(`${r}/pulls?state=all&sort=created&direction=desc`)).filter((x) => x.head.repo?.full_name === REPO)) {
    const m = BRANCH.exec(p.head.ref);
    if (m) prsById.set(m[1], [...(prsById.get(m[1]) ?? []), { ...p, attempt: Number(m[2]) }]);
  }

  const issues = [];
  for (const i of (await all(`${r}/issues?state=all&labels=factory-task`)).filter((x) => !x.pull_request)) {
    const meta = parseMeta(i.body);
    if (!meta?.id) continue;
    const prs = prsById.get(meta.id) ?? [];
    const issue = {
      number: i.number, open: i.state === 'open', labels: i.labels.map((l) => l.name), meta, body: i.body,
      openPrs: prs.filter((p) => p.state === 'open').map((p) => ({ number: p.number, attempt: p.attempt })),
      pr: null, lastCommitAt: 0,
    };
    const st = issue.open ? stateOf(issue) : null;
    if (st === 'in-progress' || st === 'awaiting-merge') {
      const current = prs.find((p) => p.attempt === meta.attempt);
      if (current) issue.pr = await prDetails(current);
      const branch = await gh('GET', `${r}/branches/${encodeURIComponent(branchOf(meta.id, meta.attempt))}`);
      if (branch) issue.lastCommitAt = Date.parse(branch.commit.commit.committer.date);
    }
    issues.push(issue);
  }
  const main = await gh('GET', `${r}/commits/main`);
  return {
    now: Date.now(), goalsSha, plan, issues,
    goalIds: parseGoalIds((await file('GOALS.md', 'main')) ?? ''),
    status: await loadStatus(),
    mainCi: await ciOf(main.sha),
  };
}

async function setState(issue, to, metaPatch = {}) {
  const labels = issue.labels.filter((l) => !STATES.includes(l)).concat(to);
  await gh('PATCH', `${r}/issues/${issue.number}`, { labels, body: withMeta(issue.body, { ...issue.meta, ...metaPatch }) });
}

// 'ok': a session started. 'refused': the API answered and no session exists.
// 'unknown': no answer, so a session may or may not have started.
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
    return res.ok ? 'ok' : 'refused';
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
      await gh('POST', `${r}/issues`, { title, body, labels: ['factory-task', 'planned'] });
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
      await gh('POST', `${r}/issues/${a.number}/comments`, { body: `Factory: closed because issue #${a.issue} is no longer assigned to this attempt.` });
      await gh('PATCH', `${r}/pulls/${a.number}`, { state: 'closed' });
      return false;
    case 'state':
      await setState(issue, a.to);
      if (a.reason) await gh('POST', `${r}/issues/${a.number}/comments`, { body: `Factory: moved to \`${a.to}\` (${a.reason}).` });
      return false;
    case 'note':
      notes.push(a.text);
      return true;
    case 'fire': {
      if (a.role === 'planner') {
        // An unanswered fire counts as a fire: the session may exist.
        if ((await fire(a.route, `ROLE=planner SHA=${a.sha}`)) !== 'refused') s.status = { ...s.status, plannerFiredSha: a.sha, plannerFiredAt: s.now, plannerFires: a.fires };
        else notes.push('Planner fire refused. Will retry on the next run.');
        return true;
      }
      // Lease first, so a concurrent reader never sees a session without a lease.
      await setState(issue, 'in-progress', { attempt: a.attempt, leaseAt: s.now });
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

async function writeStatus(planner, notes) {
  const s = await loadState();
  const rows = s.issues.map((i) => `| #${i.number} | ${i.meta.id} | ${i.open ? stateOf(i) : i.labels.includes('superseded') ? 'superseded' : 'done'} | ${i.meta.attempt ?? 0} | ${i.pr ? `#${i.pr.number} (${i.pr.ci})` : ''} |`);
  const body = [
    `Updated ${new Date(s.now).toISOString()}. GOALS.md at \`${s.goalsSha}\`, plan at \`${s.plan?.goals_sha ?? 'none'}\`.`, '',
    ...(notes.length ? ['**Notes**', ...notes.map((n) => `- ${n}`), ''] : []),
    '| Issue | Task | State | Attempts | PR |', '|---|---|---|---|---|', ...rows,
  ].join('\n');
  const { plannerFiredSha, plannerFiredAt, plannerFires } = planner;
  await gh('PATCH', `${r}/issues/${s.status.number}`, { body: withMeta(body, { plannerFiredSha, plannerFiredAt, plannerFires }) });
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
