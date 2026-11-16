import { createHash } from 'node:crypto';
import { chmod, chown, constants, cp, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createChangeSet, makeExecutionResult, sourceManifest, validateExecutionResult } from '../execution.mjs';
import { validateInvocation } from '../providers/contract.mjs';
import { restrictedEnvironment, runCodexCli } from './codex-cli.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ code: null, stdout, stderr, error }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const INPUT_FILES = ['input.json', 'invocation.json', 'schema.json', 'source.tar'];

// The input directory belongs to the runner account. Copy each regular file
// once into a root-private directory so verification and use see the same bytes.
async function stageInput(inputRoot, stagedRoot) {
  await mkdir(stagedRoot, { mode: 0o700 });
  for (const name of INPUT_FILES) {
    const handle = await open(path.join(inputRoot, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) throw new Error(`${name} is not a regular file`);
      await writeFile(path.join(stagedRoot, name), await handle.readFile(), { mode: 0o600 });
    } finally { await handle.close(); }
  }
}

async function verifyInput(inputRoot, now) {
  const input = JSON.parse(await readFile(path.join(inputRoot, 'input.json'), 'utf8'));
  const { digest, not_after: notAfter, ...base } = input;
  if (digest !== sha256(JSON.stringify(base))) throw new Error('input manifest digest is invalid');
  for (const [name, expected] of [['invocation.json', input.invocation_sha256], ['schema.json', input.schema_sha256], ['source.tar', input.source_tar_sha256]]) {
    if (sha256(await readFile(path.join(inputRoot, name))) !== expected) throw new Error(`${name} failed integrity verification`);
  }
  // A dispatch that waited past its deadline may already have been cancelled
  // and redispatched; starting it now could duplicate the execution.
  if (!Number.isSafeInteger(notAfter)) throw new Error('input has no dispatch deadline');
  if (now > notAfter) throw new Error(`dispatch deadline passed at ${new Date(notAfter).toISOString()}; refusing late execution`);
  const invocation = JSON.parse(await readFile(path.join(inputRoot, 'invocation.json'), 'utf8'));
  const errors = validateInvocation(invocation);
  if (errors.length || invocation.id !== input.invocation_id || invocation.base_sha !== input.base_sha) throw new Error(`input invocation is invalid: ${errors.join('; ')}`);
  return { input, invocation };
}

export function classifyCodexFailure(runResult) {
  const text = `${runResult.stderr ?? ''}\n${runResult.stdout ?? ''}\n${runResult.error ?? ''}`;
  if (/not logged in|authentication|unauthori[sz]ed|login required/i.test(text)) return 'unauthorized';
  if (/quota|usage limit|rate limit|capacity/i.test(text)) return 'quota-exhausted';
  return runResult.status === 'timeout' ? 'timeout' : runResult.status === 'unavailable' ? 'unavailable' : 'failed';
}

export const isChatGptSubscriptionAuth = (authResult) => authResult?.code === 0 && /logged in using chatgpt/i.test(`${authResult.stdout ?? ''}\n${authResult.stderr ?? ''}`);

function observedUsage(stdout) {
  let usage = null;
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (event.usage && typeof event.usage === 'object') usage = event.usage;
    } catch { /* diagnostic output is intentionally ignored */ }
  }
  return usage;
}

async function changeOwner(root, uid, gid) {
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) return;
  await chown(root, uid, gid);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await changeOwner(target, uid, gid);
    else await chown(target, uid, gid);
  }
}

// kill(-1) sent by the dedicated agent account reaches every process that
// account owns (except the sender), on Linux and macOS alike. Nothing the agent
// left behind may run beside the next start or modify the workspace while the
// trusted wrapper reads it.
export async function terminateAgentProcesses(uid, gid) {
  if (!Number.isInteger(uid)) return;
  for (let round = 0; round < 2; round++) {
    const killed = await run(process.execPath, ['-e', "try { process.kill(-1, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }"], { uid, gid, cwd: '/' });
    if (killed.code !== 0) throw new Error(`could not terminate agent processes: ${(killed.stderr || killed.error?.message || '').slice(-300)}`);
  }
}

// The result directory sits in the runner account's temp directory. Leave it
// owned by that account so the runner can upload it and clean its temp tree.
async function writeResult(resultRoot, result) {
  await mkdir(resultRoot, { recursive: true });
  const resultPath = path.join(resultRoot, 'result.json');
  await writeFile(resultPath, JSON.stringify(result), { mode: 0o644 });
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    const owner = await stat(path.dirname(resultRoot));
    await chown(resultRoot, owner.uid, owner.gid);
    await chown(resultPath, owner.uid, owner.gid);
  }
}

const agentIds = (uid, gid) => ({ ...(Number.isInteger(uid) ? { uid } : {}), ...(Number.isInteger(gid) ? { gid } : {}) });
const codexLoginStatus = ({ cwd, env, uid, gid }) => run('codex', ['login', 'status'], { cwd, env, ...agentIds(uid, gid) });

// O_EXCL makes the first model start a durable, atomic one-way transition.
// A crash after this claim is intentionally not retried: without a trusted
// result it is impossible to prove that the first Codex process did no work.
async function claimExecution(claimPath, invocation, inputDigest, claimedAt) {
  let handle;
  try {
    handle = await open(claimPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ version: 1, invocation_id: invocation.id, input_digest: inputDigest, claimed_at: claimedAt }));
    await handle.sync();
  } finally { await handle.close(); }
  // fsync the directory entry as well as the claim contents so a host restart
  // cannot lose the one-way transition after Codex has been allowed to start.
  const directory = await open(path.dirname(claimPath), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
  return true;
}

export async function executeCodexJob({
  inputRoot, resultRoot, agentRoot, ledgerRoot = null, env = process.env, uid, gid,
  runCli = runCodexCli, checkLogin = codexLoginStatus, terminateAgent = terminateAgentProcesses, now = Date.now,
}) {
  if (!path.isAbsolute(agentRoot) || ['/', os.homedir()].includes(path.resolve(agentRoot))) throw new Error('FACTORY_AGENT_ROOT must be a dedicated absolute directory');
  if (!path.isAbsolute(ledgerRoot ?? '') || ['/', os.homedir()].includes(path.resolve(ledgerRoot ?? '.'))) throw new Error('FACTORY_AGENT_LEDGER must be a dedicated absolute directory');
  if ((uid !== undefined || gid !== undefined) && (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid <= 0)) throw new Error('agent uid and gid must identify a non-root dedicated account');
  if (Number.isInteger(uid) && typeof process.getuid === 'function' && process.getuid() !== 0) throw new Error('OS-user isolation requires the root-owned launcher');
  if (!path.isAbsolute(env.HOME ?? '') || !path.isAbsolute(env.CODEX_HOME ?? '') || !path.resolve(env.CODEX_HOME).startsWith(`${path.resolve(env.HOME)}${path.sep}`)) {
    throw new Error('Codex HOME and CODEX_HOME must be dedicated absolute paths');
  }

  // Job layout. The agent account may only traverse the root-owned parents and
  // reach paths handed to it; it never needs the runner's private temp directory.
  //   <agentRoot>/            root 0711
  //     job-XXXXXX/           root 0711
  //       input/              root 0700  staged, verified artifact
  //       original/           root 0700  trusted baseline for the change set
  //       control/schema.json root 0755/0644, read-only for the agent
  //       workspace/          agent      the only writable source tree
  //       output/             agent 0700 structured final message
  await mkdir(agentRoot, { recursive: true, mode: 0o711 });
  await chmod(agentRoot, 0o711);
  const jobRoot = await mkdtemp(path.join(agentRoot, 'job-'));
  await chmod(jobRoot, 0o711);
  const stagedRoot = path.join(jobRoot, 'input');
  const originalRoot = path.join(jobRoot, 'original');
  const controlRoot = path.join(jobRoot, 'control');
  const schemaPath = path.join(controlRoot, 'schema.json');
  const workingRoot = path.join(jobRoot, 'workspace');
  const outputRoot = path.join(jobRoot, 'output');
  const outputPath = path.join(outputRoot, 'agent-output.json');
  try {
    await stageInput(inputRoot, stagedRoot);
    const { input, invocation } = await verifyInput(stagedRoot, now());
    await mkdir(ledgerRoot, { recursive: true, mode: 0o700 });
    try {
      const cached = JSON.parse(await readFile(path.join(ledgerRoot, `${invocation.id}.json`), 'utf8'));
      const errors = validateExecutionResult(cached, invocation, input.source_manifest.sha256, input.digest);
      if (errors.length) throw new Error(`cached result is invalid: ${errors.join('; ')}`);
      await writeResult(resultRoot, cached);
      return cached;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }

    await terminateAgent(uid, gid);
    await mkdir(originalRoot, { mode: 0o700 });
    const extract = await run('tar', ['--no-same-owner', '-xf', path.join(stagedRoot, 'source.tar'), '-C', originalRoot]);
    if (extract.code !== 0) throw new Error(`source extraction failed: ${extract.stderr.slice(-500)}`);
    await chmod(originalRoot, 0o700);
    const unpacked = await sourceManifest(originalRoot);
    if (unpacked.sha256 !== input.source_manifest.sha256) throw new Error('extracted source does not match trusted manifest');
    await mkdir(controlRoot, { mode: 0o755 });
    await chmod(controlRoot, 0o755);
    await writeFile(schemaPath, await readFile(path.join(stagedRoot, 'schema.json')), { mode: 0o644 });
    await chmod(schemaPath, 0o644);
    await cp(originalRoot, workingRoot, { recursive: true, verbatimSymlinks: true });
    await chmod(workingRoot, 0o755);
    await mkdir(outputRoot, { mode: 0o700 });
    await changeOwner(workingRoot, uid, gid);
    await changeOwner(outputRoot, uid, gid);

    let result;
    const childEnv = restrictedEnvironment(env);
    const auth = await checkLogin({ cwd: workingRoot, env: childEnv, uid, gid });
    if (!isChatGptSubscriptionAuth(auth)) {
      result = makeExecutionResult(invocation, unpacked, { status: 'unauthorized', input_digest: input.digest, error: { code: 'codex-login', message: auth.code === 0 ? 'Codex is not explicitly authenticated with ChatGPT; API-backed execution is refused' : `${auth.stderr || auth.stdout || auth.error?.message || ''}`.slice(-500) } });
    } else {
      // Keep the historic suffix so an existing Stage B attempt file also
      // prevents this hardened runner from repeating that invocation.
      const attemptsPath = path.join(ledgerRoot, `${invocation.id}.attempts`);
      if (!(await claimExecution(attemptsPath, invocation, input.digest, now()))) {
        result = makeExecutionResult(invocation, unpacked, { status: 'failed', input_digest: input.digest, error: { code: 'local-attempt-limit', message: 'Codex execution attempt limit reached for this invocation' } });
      } else {
        let runResult;
        try {
          runResult = await runCli(invocation, { workspace: workingRoot, schemaPath, outputPath, env: childEnv, uid, gid });
        } finally { await terminateAgent(uid, gid); }
        if (runResult.status !== 'completed') {
          result = makeExecutionResult(invocation, unpacked, { status: classifyCodexFailure(runResult), input_digest: input.digest, usage: observedUsage(runResult.stdout), error: { code: 'codex-exec', message: `${runResult.error ?? runResult.stderr ?? 'Codex execution failed'}`.slice(-1000) } });
        } else {
          let output;
          try { output = JSON.parse(await readFile(outputPath, 'utf8')); }
          catch (error) { throw new Error(`Codex produced no valid structured output: ${error.message}`); }
          const changes = await createChangeSet(originalRoot, workingRoot, invocation.role);
          const status = output.status === 'blocked' ? 'blocked' : 'completed';
          result = makeExecutionResult(invocation, unpacked, { status, input_digest: input.digest, output, changes, usage: observedUsage(runResult.stdout) });
        }
      }
    }
    const errors = validateExecutionResult(result, invocation, unpacked.sha256, input.digest);
    if (errors.length) throw new Error(`generated result is invalid: ${errors.join('; ')}`);
    await writeResult(resultRoot, result);
    const temporary = path.join(ledgerRoot, `${invocation.id}.${process.pid}.tmp`);
    await writeFile(temporary, JSON.stringify(result), { mode: 0o600 });
    await rename(temporary, path.join(ledgerRoot, `${invocation.id}.json`));
    return result;
  } finally {
    await rm(jobRoot, { recursive: true, force: true });
  }
}

async function main() {
  const uid = process.env.FACTORY_AGENT_UID ? Number(process.env.FACTORY_AGENT_UID) : undefined;
  const gid = process.env.FACTORY_AGENT_GID ? Number(process.env.FACTORY_AGENT_GID) : undefined;
  // A cancelled Actions step signals this wrapper; never leave Codex running.
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.once(signal, () => { terminateAgentProcesses(uid, gid).finally(() => process.exit(128 + os.constants.signals[signal])); });
  }
  await executeCodexJob({
    inputRoot: process.env.FACTORY_INPUT_ROOT,
    resultRoot: process.env.FACTORY_RESULT_ROOT,
    agentRoot: process.env.FACTORY_AGENT_ROOT,
    ledgerRoot: process.env.FACTORY_AGENT_LEDGER,
    env: process.env, uid, gid,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
