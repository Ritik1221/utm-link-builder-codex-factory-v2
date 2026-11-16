import { makeResult, validateInvocation } from './contract.mjs';
import { CODEX_TRANSPORT_LIMITS } from '../recovery.mjs';

export function createCodexAdapter({ env = process.env, fetchImpl = fetch } = {}) {
  return {
    provider: 'codex',
    availability() {
      if (env.FACTORY_CODEX_EXECUTION_MODE !== 'github-actions') return { available: false, reason: 'Codex GitHub Actions execution is not enabled' };
      if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) return { available: false, reason: 'Repository-scoped dispatcher credentials are unavailable' };
      return { available: true, authentication: 'GitHub Actions dispatch; ChatGPT subscription auth stays on the isolated runner' };
    },
    async invoke(invocation) {
      const errors = validateInvocation(invocation);
      if (errors.length) return makeResult(invocation, 'failed', { error: { code: 'invalid-contract', message: errors.join('; ') } });
      const available = this.availability();
      if (!available.available) return makeResult(invocation, 'unavailable', { error: { code: 'not-configured', message: available.reason } });
      try {
        const response = await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/codex-agent.yml/dispatches`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${env.GITHUB_TOKEN}`,
            accept: 'application/vnd.github+json',
            'content-type': 'application/json',
            'x-github-api-version': '2022-11-28',
          },
          // The isolated wrapper refuses to start Codex after not_after, so a run
          // that waits for an offline runner can be cancelled and redispatched
          // without a late duplicate execution.
          body: JSON.stringify({ ref: 'main', inputs: { invocation_id: invocation.id, not_after: String(Date.now() + CODEX_TRANSPORT_LIMITS.queueWindowMs) } }),
          signal: AbortSignal.timeout(invocation.timeout_ms),
        });
        if (response.status === 401 || response.status === 403) return makeResult(invocation, 'unauthorized', { error: { code: `http-${response.status}`, message: 'Codex runner authentication was rejected' } });
        if (response.status === 429) return makeResult(invocation, 'quota-exhausted', { error: { code: 'github-rate-limit', message: 'GitHub refused the workflow dispatch due to rate limits' } });
        if (!response.ok) {
          const message = (await response.text()).slice(0, 500);
          return makeResult(invocation, response.status >= 500 ? 'unknown' : 'failed', { error: { code: `http-${response.status}`, message: message || 'GitHub rejected the Codex workflow dispatch' } });
        }
        return makeResult(invocation, 'accepted');
      } catch (error) {
        const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        return makeResult(invocation, timeout ? 'timeout' : 'unavailable', { error: { code: timeout ? 'timeout' : 'runner-unreachable', message: error.message } });
      }
    },
  };
}
