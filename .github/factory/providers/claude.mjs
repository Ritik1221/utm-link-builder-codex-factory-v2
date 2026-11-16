import { fireOutcome } from '../lib.mjs';
import { legacyPayload, makeResult, validateInvocation } from './contract.mjs';

// A routine runs one model and a fire cannot change it, so every route names its
// expected tier. Tier pairs are preferred; explicit older configuration shapes
// remain usable without ever switching to the other configured tier.
export const CLAUDE_ROUTE_MODELS = {
  planner: 'opus', escalation: 'opus', 'final-reviewer': 'opus',
  worker: 'sonnet', reviewer: 'sonnet',
};

function routine(env, route) {
  const model = CLAUDE_ROUTE_MODELS[route];
  if (!model) return { model: null, reason: `Claude route ${route} has no model tier` };
  const routeNames = [route.toUpperCase().replaceAll('-', '_')];
  // Before final-reviewer had its own route, it used the reviewer routine.
  if (route === 'final-reviewer') routeNames.push('REVIEWER');
  const candidates = [
    { kind: 'model-tier', idName: `FACTORY_ROUTINE_ID_${model.toUpperCase()}`, tokenName: `FACTORY_FIRE_TOKEN_${model.toUpperCase()}` },
    ...routeNames.map((name) => ({ kind: 'role', idName: `FACTORY_ROUTINE_ID_${name}`, tokenName: `FACTORY_FIRE_TOKEN_${name}` })),
    { kind: 'legacy', idName: 'FACTORY_ROUTINE_ID', tokenName: 'FACTORY_FIRE_TOKEN' },
  ];
  for (const candidate of candidates) {
    const id = env[candidate.idName];
    const token = env[candidate.tokenName];
    if (id || token) {
      return id && token
        ? { model, id, token, configuration: candidate.kind }
        : { model, reason: `${candidate.idName} and ${candidate.tokenName} must be configured together` };
    }
  }
  return { model, reason: `Claude ${model}, ${route} and legacy routine id/token pairs are not configured` };
}

export function createClaudeAdapter({ env = process.env, fetchImpl = fetch } = {}) {
  return {
    provider: 'claude',
    availability(route = 'worker') {
      const configured = routine(env, route);
      return configured.id
        ? { available: true, authentication: 'claude-routine-token', model: configured.model }
        : { available: false, reason: configured.reason };
    },
    async invoke(invocation, route = invocation.role) {
      const errors = validateInvocation(invocation);
      if (errors.length) return makeResult(invocation, 'failed', { error: { code: 'invalid-contract', message: errors.join('; ') } });
      const configured = routine(env, route);
      if (!configured.id) return makeResult(invocation, 'unavailable', { error: { code: 'not-configured', message: configured.reason } });
      const text = [legacyPayload(invocation), `EXPECTED_MODEL=${configured.model}`].join(' ');
      try {
        const response = await fetchImpl(`https://api.anthropic.com/v1/claude_code/routines/${configured.id}/fire`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${configured.token}`,
            'anthropic-beta': 'experimental-cc-routine-2026-04-01',
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(invocation.timeout_ms),
        });
        let body = null;
        try { body = await response.json(); } catch { /* response body is optional */ }
        if (response.status === 401 || response.status === 403) return makeResult(invocation, 'unauthorized', { error: { code: `http-${response.status}`, message: 'Claude authentication was rejected' } });
        if (response.status === 429) return makeResult(invocation, 'quota-exhausted', { error: { code: 'http-429', message: 'Claude routine quota or rate limit was reached' } });
        const outcome = fireOutcome(response.status);
        if (outcome === 'ok') return makeResult(invocation, 'accepted', { external_id: body?.id ?? body?.session_id ?? null });
        if (outcome === 'refused') return makeResult(invocation, 'refused', { error: { code: `http-${response.status}`, message: 'Claude routine refused the invocation' } });
        return makeResult(invocation, 'unknown', { error: { code: `http-${response.status}`, message: 'Claude routine outcome is unknown' } });
      } catch (error) {
        const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        return makeResult(invocation, timeout ? 'timeout' : 'unknown', { error: { code: timeout ? 'timeout' : 'network', message: error.message } });
      }
    },
  };
}
