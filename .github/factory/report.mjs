import { statusSummary } from './state.mjs';
import { planVersionHash } from './lib.mjs';

const display = (value) => value ?? 'none';

export function renderProjectReport(state, { now = Date.now(), notes = [] } = {}) {
  const tasks = Object.values(state.tasks ?? {}).sort((a, b) => a.id.localeCompare(b.id));
  const findings = Object.values(state.findings ?? {}).sort((a, b) => a.id.localeCompare(b.id));
  const activeInvocations = (state.invocations ?? []).filter((invocation) => ['dispatching', 'accepted', 'unknown', 'timeout'].includes(invocation.status));
  const blockedTasks = tasks.filter((task) => task.status === 'needs-human');
  const openFindings = findings.filter((finding) => ['blocking', 'major'].includes(finding.severity) && !['verified', 'resolved'].includes(finding.status));
  const currentPlanHash = state.plan ? planVersionHash(state.plan) : null;
  const pendingDecisions = (state.plan?.decisions ?? []).filter((decision) => decision.requires_human_approval &&
    !(state.decisions?.[`plan:${decision.id}`]?.status === 'approved' && state.decisions[`plan:${decision.id}`].plan_hash === currentPlanHash));
  const architecture = state.plan?.architecture?.components?.join(', ') || 'not accepted';
  const taskRows = tasks.map((task) => `| ${task.id} | ${display(task.status)} | ${task.attempt ?? 0} | ${display(task.last_reason)} |`);
  const findingRows = findings.map((finding) => `| ${finding.id} | ${finding.severity} | ${display(finding.status)} | ${display(finding.affected_commit)} | ${display(finding.verified_by ?? finding.corrected_by)} |`);
  return [
    `Updated ${new Date(now).toISOString()}.`, '',
    '## Request and architecture', '',
    `- Goal: #${display(state.goal?.issue)} — ${display(state.goal?.title)}`,
    `- Immutable goal version: \`${display(state.goal?.hash)}\``,
    `- Active provider: **${display(state.provider?.active)}**`,
    `- Accepted architecture components: ${architecture}`,
    `- Accepted assumptions: ${state.plan?.assumptions?.length ?? 0}; constraints: ${state.plan?.constraints?.length ?? 0}; plan decisions: ${state.plan?.decisions?.length ?? 0}`,
    `- Durable ADR records: ${Object.keys(state.decisions ?? {}).length}`,
    `- Decisions requiring owner approval: ${pendingDecisions.map((decision) => decision.id).join(', ') || 'none'}`, '',
    '## Execution', '',
    `- Summary: \`${JSON.stringify(statusSummary(state))}\``,
    `- Active invocations: ${activeInvocations.length}`,
    `- Tasks requiring attention: ${blockedTasks.length}`,
    '', '| Task | State | Attempt | Last reason |', '|---|---|---:|---|', ...taskRows, '',
    '## Audit', '',
    `- Unresolved blocking/major findings: ${openFindings.length}`,
    '| Finding | Severity | Status | Affected commit | Corrected/verified by |', '|---|---|---|---|---|', ...findingRows, '',
    '## Delivery', '',
    `- Completion: **${state.completion?.status ?? 'running'}**`,
    `- Missing evidence: ${(state.completion?.missing ?? []).join('; ') || 'none'}`,
    ...(notes.length ? ['', '## Dispatcher notes', '', ...notes.map((note) => `- ${note}`)] : []),
  ].join('\n');
}
