import { createHash } from 'node:crypto';

const STATE_MARK = /<!-- factory-state (.*?) -->/s;
const EVENT_MARK = /<!-- factory-event (.*?) -->/s;

export const STATE_VERSION = 2;
export const EVENT_VERSION = 1;
export const MAX_STATE_BYTES = 48 * 1024;
export const MAX_JOURNAL_EVENTS = 2000;
export const MAX_EVENT_BYTES = 56 * 1024;

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));

export function emptyFactoryState() {
  return {
    version: STATE_VERSION,
    revision: 0,
    journal: { count: 0, head: null, last_comment_id: null },
    goal: null,
    provider: { active: null, history: [] },
    plan: null,
    tasks: {},
    findings: {},
    invocations: [],
    operations: {},
    decisions: {},
    corrections: { round: 0, tasks: [], exhausted: false },
    completion: { status: 'running', missing: [] },
    updated_at: null,
  };
}

export function migrateFactoryState(input) {
  if (!input || typeof input !== 'object') return emptyFactoryState();
  if (input.version === STATE_VERSION) return {
    ...emptyFactoryState(), ...input,
    journal: { ...emptyFactoryState().journal, ...(input.journal ?? {}) },
    provider: { ...emptyFactoryState().provider, ...(input.provider ?? {}) },
    operations: input.operations ?? {},
    corrections: { ...emptyFactoryState().corrections, ...(input.corrections ?? {}) },
  };
  if (input.version === 1) {
    const state = emptyFactoryState();
    return {
      ...state,
      goal: input.goal ?? null,
      plan: input.plan ?? null,
      tasks: input.tasks ?? {},
      findings: input.findings ?? {},
      invocations: Array.isArray(input.invocations) ? input.invocations : [],
      operations: input.operations ?? {},
      decisions: Array.isArray(input.decisions)
        ? Object.fromEntries(input.decisions.filter((x) => x?.id).map((x) => [x.id, x]))
        : (input.decisions ?? {}),
      completion: input.completion ?? state.completion,
      updated_at: input.updated_at ?? null,
      migration: { from: 1, at: new Date().toISOString() },
    };
  }
  throw new Error(`unsupported factory state version: ${input.version ?? 'missing'}`);
}

export function validateFactoryState(state) {
  const errors = [];
  if (state?.version !== STATE_VERSION) errors.push(`state version must be ${STATE_VERSION}`);
  if (!Number.isInteger(state?.revision) || state.revision < 0) errors.push('revision must be a non-negative integer');
  if (!Number.isInteger(state?.journal?.count) || state.journal.count < 0) errors.push('journal count is invalid');
  if (!state?.tasks || Array.isArray(state.tasks)) errors.push('tasks must be an object');
  if (!state?.findings || Array.isArray(state.findings)) errors.push('findings must be an object');
  if (!Array.isArray(state?.invocations)) errors.push('invocations must be an array');
  if (!state?.operations || Array.isArray(state.operations)) errors.push('operations must be an object');
  if (!state?.provider || !Array.isArray(state.provider.history)) errors.push('provider state is invalid');
  if (!state?.corrections || !Array.isArray(state.corrections.tasks)) errors.push('correction state is invalid');
  return errors;
}

export function parseFactoryState(body) {
  const match = STATE_MARK.exec(body ?? '');
  if (!match) return null;
  try {
    const state = migrateFactoryState(JSON.parse(match[1]));
    return validateFactoryState(state).length ? null : state;
  } catch {
    return null;
  }
}

export function compactFactoryState(state) {
  const compact = clone(state);
  compact.invocations = compact.invocations.slice(-150).map(({ output, logs, ...rest }) => rest);
  for (const finding of Object.values(compact.findings)) {
    if (Array.isArray(finding.history) && finding.history.length > 8) {
      finding.history_count = finding.history.length;
      finding.history = finding.history.slice(-8);
    }
  }
  return compact;
}

export function stateBytes(state) {
  return Buffer.byteLength(JSON.stringify(state));
}

export function withFactoryState(text, state) {
  const compact = compactFactoryState(state);
  const bytes = stateBytes(compact);
  if (bytes > MAX_STATE_BYTES) throw new Error(`factory state is ${bytes} bytes; limit is ${MAX_STATE_BYTES}`);
  return `${(text ?? '').replace(STATE_MARK, '').trimEnd()}\n\n<!-- factory-state ${JSON.stringify(compact)} -->`;
}

export function stateDiff(before, after) {
  const patch = {};
  for (const key of ['goal', 'provider', 'plan', 'tasks', 'findings', 'invocations', 'operations', 'decisions', 'corrections', 'completion']) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) patch[key] = clone(after[key]);
  }
  return patch;
}

export function prepareEvent(state, type, payload = {}, patch = {}, at = Date.now()) {
  if (state.journal.count >= MAX_JOURNAL_EVENTS) {
    throw new Error(`journal retention limit of ${MAX_JOURNAL_EVENTS} events reached; archive requires human approval`);
  }
  const base = {
    version: EVENT_VERSION,
    seq: state.journal.count + 1,
    previous: state.journal.head,
    type,
    at,
    payload,
    patch,
  };
  return { ...base, id: hash(base) };
}

export function renderEvent(event) {
  const rendered = `<!-- factory-event ${JSON.stringify(event)} -->`;
  if (Buffer.byteLength(rendered) > MAX_EVENT_BYTES) throw new Error(`factory event exceeds ${MAX_EVENT_BYTES} bytes`);
  return rendered;
}

export function parseEventComments(comments, expectedAuthor = null) {
  const events = [];
  for (const comment of comments ?? []) {
    const match = EVENT_MARK.exec(comment.body ?? '');
    if (!match) continue;
    if (expectedAuthor && comment.user?.login !== expectedAuthor) continue;
    try {
      const event = JSON.parse(match[1]);
      const { id, ...base } = event;
      if (event.version !== EVENT_VERSION || id !== hash(base)) continue;
      events.push({ ...event, comment_id: comment.id ?? null, author: comment.user?.login ?? null });
    } catch { /* malformed journal comment */ }
  }
  return events.sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
}

export function applyEvent(state, event) {
  if (event.seq !== state.journal.count + 1) throw new Error(`journal sequence gap at ${event.seq}`);
  if (event.previous !== state.journal.head) throw new Error(`journal predecessor mismatch at ${event.seq}`);
  const { comment_id, author, ...stored } = event;
  const { id, ...base } = stored;
  if (id !== hash(base)) throw new Error(`journal hash mismatch at ${event.seq}`);
  const next = {
    ...state,
    ...clone(event.patch ?? {}),
    version: STATE_VERSION,
    revision: state.revision + 1,
    journal: { count: event.seq, head: event.id, last_comment_id: comment_id ?? state.journal.last_comment_id },
    updated_at: new Date(event.at).toISOString(),
  };
  const errors = validateFactoryState(next);
  if (errors.length) throw new Error(`event produced invalid state: ${errors.join('; ')}`);
  return next;
}

export function recoverFactoryState(snapshot, events) {
  let state = migrateFactoryState(snapshot ?? emptyFactoryState());
  const byId = new Map();
  const bySeq = new Map();
  for (const event of events) {
    if (byId.has(event.id)) continue;
    byId.set(event.id, event);
    const prior = bySeq.get(event.seq);
    if (prior && prior.id !== event.id) {
      return { state, recovered: false, ambiguous: true, error: `journal fork at sequence ${event.seq}` };
    }
    bySeq.set(event.seq, event);
  }
  if (state.journal.count > 0) {
    let previous = null;
    for (let seq = 1; seq <= state.journal.count; seq++) {
      const event = bySeq.get(seq);
      if (!event) return { state, recovered: false, ambiguous: true, error: `journal history is missing sequence ${seq}` };
      if (event.previous !== previous) return { state, recovered: false, ambiguous: true, error: `journal predecessor mismatch at ${seq}` };
      previous = event.id;
    }
    if (previous !== state.journal.head) {
      return { state, recovered: false, ambiguous: true, error: 'snapshot head does not match journal history' };
    }
  }
  const tail = [...bySeq.values()].filter((event) => event.seq > state.journal.count).sort((a, b) => a.seq - b.seq);
  for (const event of tail) {
    try {
      state = applyEvent(state, event);
    } catch (error) {
      return { state, recovered: false, ambiguous: true, error: error.message };
    }
  }
  return { state, recovered: true, ambiguous: false, error: null };
}

// Pure helper retained for tests and local simulations. The live dispatcher
// appends renderEvent(event) before materializing the returned state.
export function appendEvent(state, type, payload, at = Date.now(), patch = {}) {
  return applyEvent(state, prepareEvent(state, type, payload, patch, at));
}

export function recordInvocation(state, invocation) {
  if (state.invocations.some((x) => x.id === invocation.id)) return state;
  return { ...state, invocations: [...state.invocations, invocation] };
}

export function updateInvocation(state, id, patch) {
  if (!state.invocations.some((x) => x.id === id)) return state;
  return { ...state, invocations: state.invocations.map((x) => x.id === id ? { ...x, ...patch } : x) };
}

export function recordOperation(state, operation) {
  if (!operation?.id) return state;
  const current = state.operations[operation.id];
  return { ...state, operations: { ...state.operations, [operation.id]: { ...current, ...operation } } };
}

export function recordFinding(state, finding) {
  const current = state.findings[finding.id];
  const { history: ignoredHistory, history_count: ignoredCount, fingerprint: ignoredFingerprint, ...entry } = finding;
  const fingerprint = hash(entry);
  if (current?.fingerprint === fingerprint) return state;
  const history = [...(current?.history ?? []), { ...entry, fingerprint }];
  return { ...state, findings: { ...state.findings, [finding.id]: { ...entry, fingerprint, history } } };
}

export function recordDecision(state, decision) {
  if (!decision?.id) return state;
  return { ...state, decisions: { ...state.decisions, [decision.id]: decision } };
}

export function statusSummary(state) {
  const taskValues = Object.values(state.tasks ?? {});
  const counts = Object.fromEntries(['planned', 'ready', 'in-progress', 'in-review', 'needs-human', 'done', 'superseded'].map((s) => [s, 0]));
  for (const task of taskValues) counts[task.status] = (counts[task.status] ?? 0) + 1;
  return {
    revision: state.revision,
    journal: state.journal,
    goal: state.goal ? { issue: state.goal.issue, hash: state.goal.hash } : null,
    provider: state.provider.active,
    counts,
    invocations: state.invocations.length,
    operations: Object.values(state.operations).reduce((out, operation) => ({ ...out, [operation.status]: (out[operation.status] ?? 0) + 1 }), {}),
    findings: Object.values(state.findings).reduce((out, f) => ({ ...out, [f.status ?? 'open']: (out[f.status ?? 'open'] ?? 0) + 1 }), {}),
    corrections: {
      round: state.corrections.round,
      tasks: state.corrections.tasks.map((task) => task.id),
      exhausted: state.corrections.exhausted,
    },
    completion: state.completion,
    updated_at: state.updated_at,
  };
}
