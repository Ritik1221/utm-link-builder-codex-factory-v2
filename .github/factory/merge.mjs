import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { requiredChecksState } from './lib.mjs';

const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function transientMergeReadinessFailure(error) {
  return /\b405\b/.test(error?.message ?? '') &&
    /required status check .+ (is in progress|is expected)/i.test(error?.message ?? '');
}

export async function mergeExactSha({
  gh, repositoryPath, pullNumber, sha, attempts = 3, retryDelayMs = 5000, sleep = defaultSleep,
}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) throw new Error('merge attempts must be between 1 and 5');
  let lastError = new Error('merge readiness was not established');
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const pull = await gh('GET', `${repositoryPath}/pulls/${pullNumber}`);
    if (pull.state !== 'open' || pull.merged_at) throw new Error(`pull request #${pullNumber} is no longer open`);
    if (pull.head?.sha !== sha) throw new Error(`pull request #${pullNumber} head changed from exact SHA ${sha}`);
    if (pull.base?.ref !== 'main') throw new Error(`pull request #${pullNumber} no longer targets main`);

    const checks = await gh('GET', `${repositoryPath}/commits/${sha}/check-runs?per_page=100`);
    const readiness = requiredChecksState(checks?.check_runs ?? []);
    if (readiness === 'red') throw new Error(`required check failed for exact SHA ${sha}`);
    if (readiness !== 'green') {
      lastError = new Error(`required checks remain pending for exact SHA ${sha} (attempt ${attempt}/${attempts})`);
    } else {
      try {
        return await gh('PUT', `${repositoryPath}/pulls/${pullNumber}/merge`, { sha, merge_method: 'squash' });
      } catch (error) {
        if (!transientMergeReadinessFailure(error)) throw error;
        lastError = error;
      }
    }
    if (attempt < attempts) await sleep(retryDelayMs);
  }
  throw lastError;
}

async function api(method, path, body) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${(await response.text()).slice(0, 500)}`);
  return response.status === 204 ? null : response.json();
}

async function main() {
  if (process.argv[2] === 'check') {
    const checks = JSON.parse(await readFile('/dev/stdin', 'utf8'));
    process.stdout.write(`${requiredChecksState(checks?.check_runs ?? [])}\n`);
    return;
  }
  const repository = process.env.GITHUB_REPOSITORY;
  const pullNumber = Number(process.env.PULL_NUMBER);
  const sha = process.env.HEAD_SHA;
  if (!process.env.GH_TOKEN || !repository || !Number.isInteger(pullNumber) || !sha) throw new Error('merge CLI environment is incomplete');
  const result = await mergeExactSha({ gh: api, repositoryPath: `/repos/${repository}`, pullNumber, sha });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
