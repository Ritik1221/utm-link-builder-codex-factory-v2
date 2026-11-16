export const CODEX_AVAILABLE_MODELS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
export const CODEX_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Verified against the ChatGPT-authenticated Codex CLI 0.146.0 model catalog
// on 2026-11-16. These are explicit defaults, not runtime fallbacks.
export const CODEX_ROLE_ROUTES = Object.freeze({
  planner: Object.freeze({ model: 'gpt-5.6-sol', reasoning_effort: 'high' }),
  worker: Object.freeze({ model: 'gpt-5.6-luna', reasoning_effort: 'medium' }),
  'corrective-worker': Object.freeze({ model: 'gpt-5.6-sol', reasoning_effort: 'high' }),
  reviewer: Object.freeze({ model: 'gpt-5.6-sol', reasoning_effort: 'high' }),
  'final-reviewer': Object.freeze({ model: 'gpt-5.6-sol', reasoning_effort: 'high' }),
});

const suffix = (role) => role.replaceAll('-', '_').toUpperCase();

export function validateCodexExecutionConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') return ['Codex execution config is required'];
  if (!CODEX_AVAILABLE_MODELS.includes(config.model)) errors.push(`unsupported Codex model: ${config.model ?? 'missing'}`);
  if (!CODEX_REASONING_EFFORTS.includes(config.reasoning_effort)) errors.push(`unsupported Codex reasoning effort: ${config.reasoning_effort ?? 'missing'}`);
  return errors;
}

export function resolveCodexRoute(role, env = process.env) {
  const defaults = CODEX_ROLE_ROUTES[role];
  if (!defaults) throw new Error(`no Codex route exists for role ${role}`);
  const name = suffix(role);
  const model = env[`FACTORY_CODEX_MODEL_${name}`];
  const effort = env[`FACTORY_CODEX_REASONING_${name}`];
  if ((model && !effort) || (!model && effort)) {
    throw new Error(`FACTORY_CODEX_MODEL_${name} and FACTORY_CODEX_REASONING_${name} must be configured together`);
  }
  const selected = model ? { model, reasoning_effort: effort } : { ...defaults };
  const errors = validateCodexExecutionConfig(selected);
  if (errors.length) throw new Error(errors.join('; '));
  return selected;
}
