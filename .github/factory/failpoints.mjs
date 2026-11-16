export const STAGE_A_FAILPOINTS = Object.freeze([
  'after-journal-append',
  'after-task-operation-intent',
  'after-task-issue-create',
]);

const DISPOSABLE_REPOSITORY = /\/factory-phase2-stage-a-[a-z0-9-]+$/;

export function activeFailpoint(env = process.env) {
  const requested = String(env.FACTORY_FAULT_POINT ?? '').trim();
  if (!requested || requested === 'none') return null;
  if (!STAGE_A_FAILPOINTS.includes(requested)) throw new Error(`unknown Stage A failpoint: ${requested}`);
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch') {
    throw new Error('Stage A failpoints are permitted only for workflow_dispatch');
  }
  if (env.FACTORY_INTEGRATION_TEST !== 'true') {
    throw new Error('Stage A failpoints require FACTORY_INTEGRATION_TEST=true');
  }
  const repository = String(env.GITHUB_REPOSITORY ?? '');
  if (!DISPOSABLE_REPOSITORY.test(repository)) {
    throw new Error('Stage A failpoints require a disposable factory-phase2-stage-a-* repository');
  }
  if (env.FACTORY_INTEGRATION_REPOSITORY !== repository) {
    throw new Error('Stage A failpoints require an exact FACTORY_INTEGRATION_REPOSITORY match');
  }
  return requested;
}

export function hitFailpoint(name, env = process.env) {
  if (!STAGE_A_FAILPOINTS.includes(name)) throw new Error(`unknown Stage A failpoint location: ${name}`);
  if (activeFailpoint(env) === name) throw new Error(`intentional Stage A failpoint: ${name}`);
}
