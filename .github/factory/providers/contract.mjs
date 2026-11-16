import { createHash } from 'node:crypto';
import { validateCodexExecutionConfig } from './codex-routing.mjs';

export const CONTRACT_VERSION = 1;
export const PROVIDERS = ['claude', 'codex'];
export const ROLES = ['planner', 'worker', 'reviewer', 'corrective-worker', 'final-reviewer'];
export const RESULT_STATUSES = ['accepted', 'completed', 'refused', 'unavailable', 'unauthorized', 'quota-exhausted', 'timeout', 'failed', 'unknown'];

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function makeInvocation(input) {
  const base = {
    version: CONTRACT_VERSION,
    goal_id: input.goal_id,
    goal_version: input.goal_version,
    role: input.role,
    provider: input.provider,
    repository: input.repository,
    base_sha: input.base_sha ?? null,
    task_id: input.task_id ?? null,
    issue: input.issue ?? null,
    pull_request: input.pull_request ?? null,
    attempt: input.attempt ?? 1,
    timeout_ms: input.timeout_ms,
    retry_budget: input.retry_budget,
    ...(input.execution_config === undefined ? {} : { execution_config: input.execution_config }),
    immutable_context: input.immutable_context ?? {},
    output_schema: input.output_schema,
  };
  return { ...base, id: `inv_${digest(base).slice(0, 24)}` };
}

export function validateInvocation(invocation) {
  const errors = [];
  if (invocation?.version !== CONTRACT_VERSION) errors.push(`contract version must be ${CONTRACT_VERSION}`);
  if (!PROVIDERS.includes(invocation?.provider)) errors.push('provider is invalid');
  if (!ROLES.includes(invocation?.role)) errors.push('role is invalid');
  if (typeof invocation?.goal_id !== 'string' || !invocation.goal_id) errors.push('goal_id is required');
  if (typeof invocation?.goal_version !== 'string' || !invocation.goal_version) errors.push('goal_version is required');
  if (typeof invocation?.repository !== 'string' || !invocation.repository.includes('/')) errors.push('repository is invalid');
  if (!Number.isInteger(invocation?.attempt) || invocation.attempt < 1) errors.push('attempt must be positive');
  if (!Number.isInteger(invocation?.timeout_ms) || invocation.timeout_ms < 1000) errors.push('timeout_ms is invalid');
  if (!Number.isInteger(invocation?.retry_budget) || invocation.retry_budget < 0) errors.push('retry_budget is invalid');
  if (invocation?.provider === 'codex') {
    errors.push(...validateCodexExecutionConfig(invocation.execution_config));
  }
  if (!invocation?.output_schema || typeof invocation.output_schema !== 'object') errors.push('output_schema is required');
  if (invocation?.id !== `inv_${digest(Object.fromEntries(Object.entries(invocation).filter(([key]) => key !== 'id'))).slice(0, 24)}`) errors.push('invocation id does not match its content');
  return errors;
}

export function makeResult(invocation, status, details = {}) {
  if (!RESULT_STATUSES.includes(status)) throw new Error(`invalid invocation result status: ${status}`);
  return {
    version: CONTRACT_VERSION,
    invocation_id: invocation.id,
    provider: invocation.provider,
    role: invocation.role,
    status,
    external_id: details.external_id ?? null,
    error: details.error ?? null,
    usage: details.usage ?? null,
    output: details.output ?? null,
    at: details.at ?? Date.now(),
  };
}

export function encodeInvocation(invocation) {
  const errors = validateInvocation(invocation);
  if (errors.length) throw new Error(`invalid invocation: ${errors.join('; ')}`);
  return Buffer.from(JSON.stringify(invocation)).toString('base64url');
}

export function legacyPayload(invocation) {
  const fields = [`ROLE=${invocation.role}`, `INVOCATION_ID=${invocation.id}`, `GOAL_VERSION=${invocation.goal_version}`];
  if (invocation.issue) fields.push(`ISSUE=${invocation.issue}`);
  if (invocation.pull_request) fields.push(`PR=${invocation.pull_request}`);
  if (invocation.base_sha) fields.push(`SHA=${invocation.base_sha}`);
  if (invocation.attempt) fields.push(`ATTEMPT=${invocation.attempt}`);
  fields.push(`CONTRACT=${encodeInvocation(invocation)}`);
  return fields.join(' ');
}
