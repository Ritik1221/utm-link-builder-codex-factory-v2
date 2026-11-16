import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEventComments, parseFactoryState, recoverFactoryState } from '../state.mjs';
import { validateInvocation } from '../providers/contract.mjs';
import { sourceManifest } from '../execution.mjs';
import { CODEX_TRANSPORT_LIMITS } from '../recovery.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function gh(token, repository, route) {
  const response = await fetch(`https://api.github.com/repos/${repository}${route}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
  if (!response.ok) throw new Error(`GitHub ${route}: ${response.status} ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

async function all(token, repository, route) {
  const values = [];
  for (let page = 1; ; page++) {
    const items = await gh(token, repository, `${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    values.push(...items);
    if (items.length < 100) return values;
  }
}

export function recoverInvocation(statusBody, comments, invocationId, dispatcherLogin) {
  const events = parseEventComments(comments, dispatcherLogin);
  const matches = events.filter((event) => event.type === 'agent-dispatching' && event.payload?.invocation?.id === invocationId);
  if (matches.length !== 1) throw new Error(`expected one authenticated invocation journal event, found ${matches.length}`);
  const invocation = matches[0].payload.invocation;
  const errors = validateInvocation(invocation);
  if (errors.length) throw new Error(`journaled invocation is invalid: ${errors.join('; ')}`);
  const recovered = recoverFactoryState(parseFactoryState(statusBody), events);
  if (recovered.ambiguous) throw new Error(`canonical journal is ambiguous: ${recovered.error}`);
  const record = recovered.state.invocations.find((value) => value.id === invocationId);
  const dispatchable = ['dispatching', 'accepted', 'unknown', 'timeout'];
  if (!record || !dispatchable.includes(record.status)) throw new Error(`invocation is not dispatchable in canonical state (${record?.status ?? 'missing'})`);
  const newer = recovered.state.invocations.find((value) => value.id !== invocationId && value.provider === invocation.provider &&
    value.role === invocation.role && value.task_id === invocation.task_id && value.started_at > record.started_at && dispatchable.includes(value.status));
  if (newer) throw new Error(`invocation was superseded by ${newer.id}`);
  return { invocation, canonical: recovered.state };
}

export async function fetchInvocation({ token, repository, invocationId, dispatcherLogin }) {
  const statuses = (await all(token, repository, '/issues?state=all&labels=factory-status')).filter((issue) => !issue.pull_request);
  if (statuses.length !== 1) throw new Error(`expected one factory-status issue, found ${statuses.length}`);
  const comments = await all(token, repository, `/issues/${statuses[0].number}/comments`);
  return { ...recoverInvocation(statuses[0].body, comments, invocationId, dispatcherLogin), statusIssue: statuses[0].number };
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} failed (${code}): ${stderr.slice(-500)}`)));
  });
}

// The dispatcher chooses the deadline; this GitHub-hosted job only accepts a
// near-future value and records it in the input manifest.
export function validateDispatchDeadline(value, now = Date.now()) {
  const deadline = /^\d+$/.test(String(value ?? '')) ? Number(value) : NaN;
  const latest = now + CODEX_TRANSPORT_LIMITS.queueWindowMs + CODEX_TRANSPORT_LIMITS.graceMs;
  if (!Number.isSafeInteger(deadline) || deadline <= now || deadline > latest) throw new Error('dispatch deadline is missing, expired or too far in the future');
  return deadline;
}

export async function packageCodexInput({ invocationPath, sourceRoot, outputRoot, notAfter, now = Date.now() }) {
  const deadline = validateDispatchDeadline(notAfter, now);
  const invocationBytes = await readFile(invocationPath);
  const invocation = JSON.parse(invocationBytes);
  const errors = validateInvocation(invocation);
  if (errors.length) throw new Error(`invalid invocation: ${errors.join('; ')}`);
  const source = await sourceManifest(sourceRoot);
  await mkdir(outputRoot, { recursive: true });
  const schemaBytes = Buffer.from(JSON.stringify(invocation.output_schema));
  await writeFile(path.join(outputRoot, 'invocation.json'), invocationBytes);
  await writeFile(path.join(outputRoot, 'schema.json'), schemaBytes);
  await run('tar', ['--exclude=.git', '-cf', path.join(outputRoot, 'source.tar'), '.'], sourceRoot);
  const tarBytes = await readFile(path.join(outputRoot, 'source.tar'));
  const base = {
    version: 1, invocation_id: invocation.id, repository: invocation.repository, base_sha: invocation.base_sha,
    invocation_sha256: sha256(invocationBytes), schema_sha256: sha256(schemaBytes),
    source_tar_sha256: sha256(tarBytes), source_manifest: source,
  };
  // The digest identifies the invocation input and is bound into its result,
  // so it must not change when the same invocation is redispatched. The
  // per-dispatch deadline travels beside it.
  await writeFile(path.join(outputRoot, 'input.json'), JSON.stringify({ ...base, digest: sha256(JSON.stringify(base)), not_after: deadline }));
  return base;
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'fetch') {
    const result = await fetchInvocation({
      token: process.env.GITHUB_TOKEN, repository: process.env.GITHUB_REPOSITORY,
      invocationId: process.env.FACTORY_INVOCATION_ID,
      dispatcherLogin: process.env.FACTORY_DISPATCHER_LOGIN,
    });
    const output = process.env.FACTORY_INVOCATION_PATH;
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(result.invocation));
    if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `base_sha=${result.invocation.base_sha}\nrole=${result.invocation.role}\n`, { flag: 'a' });
  } else if (mode === 'package') {
    await packageCodexInput({ invocationPath: process.env.FACTORY_INVOCATION_PATH, sourceRoot: process.env.FACTORY_SOURCE_ROOT, outputRoot: process.env.FACTORY_INPUT_ROOT, notAfter: process.env.FACTORY_NOT_AFTER });
  } else throw new Error('usage: prepare-codex-job.mjs fetch|package');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
