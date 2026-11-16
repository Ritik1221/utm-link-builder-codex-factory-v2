import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { touchesProtected } from './lib.mjs';

export const EXECUTION_VERSION = 1;
export const EXECUTION_LIMITS = {
  maxFiles: 100,
  maxChangedBytes: 2 * 1024 * 1024,
  maxSourceBytes: 20 * 1024 * 1024,
};

const RESULT_MARK = /<!-- factory-agent-result (.*?) -->/s;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const jsonHash = (value) => sha256(JSON.stringify(value));

function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 300 &&
    !path.isAbsolute(value) && !value.includes('\\') &&
    value.split('/').every((part) => part && part !== '.' && part !== '..');
}

export function outputSchemaForRole(role) {
  const finding = {
    type: 'object',
    required: ['id', 'severity', 'file', 'problem', 'evidence', 'affected_commit', 'required_test'],
    properties: {
      id: { type: 'string' }, severity: { enum: ['blocking', 'major', 'minor', 'advisory'] },
      file: { type: 'string' }, problem: { type: 'string' }, evidence: { type: 'string' },
      affected_commit: { type: 'string' }, required_test: { type: 'string' },
      autonomous_fix: { type: 'boolean' }, acceptance_tests: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: false,
  };
  const common = {
    status: { enum: ['completed', 'blocked'] },
    summary: { type: 'string' },
    tests: { type: 'array', items: { type: 'string' } },
  };
  if (role === 'planner') return {
    type: 'object', required: ['status', 'summary', 'plan_sha256'],
    properties: { ...common, plan_sha256: { type: 'string' }, unresolved_ambiguities: { type: 'array', items: { type: 'string' } } },
    additionalProperties: false,
  };
  if (role === 'reviewer') return {
    type: 'object', required: ['status', 'summary', 'review'],
    properties: { ...common, review: { type: 'object', required: ['verdict', 'findings'], properties: { verdict: { enum: ['approve', 'reject'] }, findings: { type: 'array', items: finding } }, additionalProperties: false } },
    additionalProperties: false,
  };
  if (role === 'final-reviewer') return {
    type: 'object', required: ['status', 'summary', 'review'],
    properties: { ...common, review: { type: 'object', required: ['verdict', 'findings', 'reconciliation'], properties: {
      verdict: { enum: ['approve', 'reject'] }, findings: { type: 'array', items: finding },
      reconciliation: { type: 'array', items: { type: 'object', required: ['id', 'status', 'evidence'], properties: { id: { type: 'string' }, status: { enum: ['satisfied', 'not_satisfied'] }, evidence: { type: 'string' } }, additionalProperties: false } },
    }, additionalProperties: false } },
    additionalProperties: false,
  };
  return {
    type: 'object', required: ['status', 'summary', 'tests'],
    properties: { ...common, decisions: { type: 'array', items: { type: 'string' } }, blockers: { type: 'array', items: { type: 'string' } } },
    additionalProperties: false,
  };
}

async function walk(root, relative = '', out = []) {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!relative && entry.name === '.git') continue;
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    const stat = await lstat(path.join(root, name));
    if (stat.isSymbolicLink()) throw new Error(`source contains unsupported symbolic link: ${name}`);
    if (stat.isDirectory()) await walk(root, name, out);
    else if (stat.isFile()) out.push({ path: name, size: stat.size, mode: stat.mode & 0o777, sha256: sha256(await readFile(path.join(root, name))) });
    else throw new Error(`source contains unsupported file type: ${name}`);
  }
  return out;
}

export async function sourceManifest(root) {
  const files = await walk(root);
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  if (files.length > 10_000) throw new Error('source snapshot contains too many files');
  if (bytes > EXECUTION_LIMITS.maxSourceBytes) throw new Error('source snapshot exceeds size limit');
  const base = { version: EXECUTION_VERSION, files, bytes };
  return { ...base, sha256: jsonHash(base) };
}

function changeAllowed(role, file) {
  if (role === 'planner') return file === 'factory/plan.json';
  if (role === 'reviewer' || role === 'final-reviewer') return false;
  return !touchesProtected([file]);
}

export async function createChangeSet(originalRoot, workingRoot, role) {
  const before = await sourceManifest(originalRoot);
  const after = await sourceManifest(workingRoot);
  const oldFiles = new Map(before.files.map((file) => [file.path, file]));
  const newFiles = new Map(after.files.map((file) => [file.path, file]));
  const paths = [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort();
  const changes = [];
  let bytes = 0;
  for (const name of paths) {
    const oldFile = oldFiles.get(name);
    const newFile = newFiles.get(name);
    if (oldFile?.sha256 === newFile?.sha256 && oldFile?.mode === newFile?.mode) continue;
    if (!safeRelative(name)) throw new Error(`unsafe changed path: ${name}`);
    if (!changeAllowed(role, name)) throw new Error(`role ${role} may not change ${name}`);
    const content = newFile ? await readFile(path.join(workingRoot, name)) : null;
    bytes += content?.length ?? 0;
    changes.push({
      path: name,
      operation: newFile ? 'write' : 'delete',
      before_sha256: oldFile?.sha256 ?? null,
      after_sha256: newFile?.sha256 ?? null,
      mode: newFile?.mode ?? null,
      content_base64: content?.toString('base64') ?? null,
    });
  }
  if (changes.length > EXECUTION_LIMITS.maxFiles) throw new Error('result changes too many files');
  if (bytes > EXECUTION_LIMITS.maxChangedBytes) throw new Error('result changes exceed byte limit');
  return { version: EXECUTION_VERSION, source_manifest_sha256: before.sha256, changes, bytes };
}

export function makeExecutionResult(invocation, source, details) {
  const base = {
    version: EXECUTION_VERSION,
    invocation_id: invocation.id,
    provider: invocation.provider,
    role: invocation.role,
    base_sha: invocation.base_sha,
    goal_version: invocation.goal_version,
    attempt: invocation.attempt,
    input_digest: details.input_digest ?? null,
    source_manifest_sha256: source.sha256,
    status: details.status,
    output: details.output ?? null,
    changes: details.changes ?? { version: EXECUTION_VERSION, source_manifest_sha256: source.sha256, changes: [], bytes: 0 },
    usage: details.usage ?? null,
    error: details.error ?? null,
    completed_at: details.completed_at ?? Date.now(),
  };
  return { ...base, digest: jsonHash(base) };
}

function validateRoleOutput(output, role, status) {
  const errors = [];
  if (!['completed', 'blocked'].includes(status)) return errors;
  if (!output || typeof output !== 'object' || !['completed', 'blocked'].includes(output.status) || typeof output.summary !== 'string') {
    return ['structured agent output is malformed'];
  }
  if (role === 'planner' && (typeof output.plan_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(output.plan_sha256))) errors.push('planner output is missing the plan hash');
  if (['worker', 'corrective-worker'].includes(role) && (!Array.isArray(output.tests) || output.tests.some((value) => typeof value !== 'string'))) errors.push('worker output tests are malformed');
  if (['reviewer', 'final-reviewer'].includes(role)) {
    if (!output.review || !['approve', 'reject'].includes(output.review.verdict) || !Array.isArray(output.review.findings)) errors.push('review output is malformed');
    if (role === 'final-reviewer' && !Array.isArray(output.review?.reconciliation)) errors.push('final review reconciliation is missing');
  }
  return errors;
}

export function validateExecutionResult(result, invocation, sourceSha = null, inputDigest = null) {
  const errors = [];
  if (result?.version !== EXECUTION_VERSION) errors.push('execution result version is invalid');
  if (result?.invocation_id !== invocation?.id) errors.push('invocation id does not match');
  if (result?.provider !== 'codex' || invocation?.provider !== 'codex') errors.push('provider does not match Codex invocation');
  for (const key of ['role', 'base_sha', 'goal_version', 'attempt']) if (result?.[key] !== invocation?.[key]) errors.push(`${key} does not match invocation`);
  if (sourceSha && result?.source_manifest_sha256 !== sourceSha) errors.push('source manifest does not match');
  if (inputDigest && result?.input_digest !== inputDigest) errors.push('input artifact digest does not match');
  if (!['completed', 'blocked', 'unavailable', 'unauthorized', 'quota-exhausted', 'timeout', 'failed'].includes(result?.status)) errors.push('result status is invalid');
  errors.push(...validateRoleOutput(result?.output, invocation?.role, result?.status));
  const { digest, ...base } = result ?? {};
  if (digest !== jsonHash(base)) errors.push('result digest is invalid');
  const changes = result?.changes?.changes;
  if (!Array.isArray(changes)) errors.push('change set is missing');
  else {
    if (changes.length > EXECUTION_LIMITS.maxFiles) errors.push('change set has too many files');
    let bytes = 0;
    const seen = new Set();
    for (const change of changes) {
      if (!safeRelative(change?.path) || seen.has(change.path)) errors.push(`unsafe or duplicate path: ${change?.path}`);
      else seen.add(change.path);
      if (!changeAllowed(invocation.role, change.path)) errors.push(`role may not change ${change.path}`);
      if (!['write', 'delete'].includes(change?.operation)) errors.push(`${change?.path}: invalid operation`);
      if (change?.operation === 'write') {
        let content;
        try { content = Buffer.from(change.content_base64, 'base64'); } catch { content = null; }
        if (!content || sha256(content) !== change.after_sha256) errors.push(`${change.path}: content hash mismatch`);
        if (!Number.isInteger(change.mode) || change.mode < 0 || change.mode > 0o777) errors.push(`${change.path}: file mode is invalid`);
        bytes += content?.length ?? 0;
      } else if (change.content_base64 !== null || change.after_sha256 !== null) errors.push(`${change.path}: malformed deletion`);
    }
    if (bytes > EXECUTION_LIMITS.maxChangedBytes || bytes !== result?.changes?.bytes) errors.push('change byte count is invalid');
  }
  if (['reviewer', 'final-reviewer'].includes(invocation?.role) && changes?.length) errors.push('reviewers cannot return file changes');
  return errors;
}

export async function applyChangeSet(root, result, invocation) {
  const errors = validateExecutionResult(result, invocation, result.source_manifest_sha256);
  if (errors.length) throw new Error(`invalid execution result: ${errors.join('; ')}`);
  for (const change of result.changes.changes) {
    const target = path.join(root, change.path);
    let current = null;
    try { current = sha256(await readFile(target)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current !== change.before_sha256) throw new Error(`${change.path}: base content changed before apply`);
    if (change.operation === 'delete') await rm(target);
    else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(change.content_base64, 'base64'), { flag: current === null ? 'wx' : 'w' });
      await chmod(target, change.mode & 0o777);
    }
  }
}

export function renderAgentResultReceipt(receipt) {
  return `<!-- factory-agent-result ${JSON.stringify(receipt)} -->`;
}

export function parseAgentResultReceipts(comments, expectedAuthor = null) {
  const receipts = [];
  for (const comment of comments ?? []) {
    const match = RESULT_MARK.exec(comment.body ?? '');
    if (!match || (expectedAuthor && comment.user?.login !== expectedAuthor)) continue;
    try {
      const value = JSON.parse(match[1]);
      if (typeof value.invocation_id === 'string' && typeof value.digest === 'string' && typeof value.status === 'string') {
        receipts.push({ ...value, comment_id: comment.id, at: Date.parse(comment.created_at), author: comment.user?.login ?? null });
      }
    } catch { /* malformed receipts are ignored and cannot change state */ }
  }
  return receipts;
}
