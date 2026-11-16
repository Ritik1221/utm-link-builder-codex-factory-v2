import { createClaudeAdapter } from './claude.mjs';
import { createCodexAdapter } from './codex.mjs';

export function createProviderRegistry(options = {}) {
  const adapters = {
    claude: createClaudeAdapter(options.claude),
    codex: createCodexAdapter(options.codex),
  };
  return {
    adapters,
    availability(provider, route) {
      if (!adapters[provider]) return { available: false, reason: `Unknown provider: ${provider}` };
      return adapters[provider].availability(route);
    },
    invoke(provider, invocation, route, options = {}) {
      if (!adapters[provider]) throw new Error(`Unknown provider: ${provider}`);
      // Deliberately no fallback. Provider changes are explicit state transitions.
      return adapters[provider].invoke(invocation, route, options);
    },
  };
}
