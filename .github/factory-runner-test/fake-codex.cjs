#!/usr/local/bin/node
// Stand-in for the Codex CLI inside the Linux UID integration image. It runs as
// the dedicated agent account, opens its inputs the way the real CLI does and
// records which paths that account can and cannot reach. It makes no network
// call and has no model.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
const calls = '/tmp/fake-codex-calls.log';
if (args[0] === 'login' && args[1] === 'status') {
  console.log('Logged in using ChatGPT');
  process.exit(0);
}
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const workspace = flag('--cd');
const schemaPath = flag('--output-schema');
const outputPath = flag('--output-last-message');
fs.appendFileSync(calls, `exec ${process.getuid()}\n`);

let schema;
try {
  process.chdir(fs.realpathSync(workspace));
  schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  fs.accessSync(path.dirname(outputPath), fs.constants.W_OK);
} catch (error) {
  // The real CLI reports an EACCES like this; it is the Stage B failure.
  console.error(`Error: ${error.code === 'EACCES' ? 'Permission denied (os error 13)' : error.message}`);
  process.exit(1);
}

const jobRoot = path.dirname(workspace);
const denied = (action) => {
  try { action(); return false; } catch (error) { return ['EACCES', 'EPERM'].includes(error.code); }
};
const probe = {
  uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(),
  env: Object.keys(process.env).sort(),
  schema_type: schema.type,
  denied: {
    runner_home: denied(() => fs.readdirSync('/home/factory-runner')),
    runner_input: denied(() => fs.readFileSync('/home/factory-runner/actions-runner/_work/_temp/factory-input/input.json')),
    jobs_listing: denied(() => fs.readdirSync('/var/factory-codex/jobs')),
    ledger: denied(() => fs.readdirSync('/var/factory-codex/ledger')),
    job_listing: denied(() => fs.readdirSync(jobRoot)),
    staged_input: denied(() => fs.readdirSync(path.join(jobRoot, 'input'))),
    original: denied(() => fs.readdirSync(path.join(jobRoot, 'original'))),
    schema_write: denied(() => fs.writeFileSync(schemaPath, '{}')),
    control_create: denied(() => fs.writeFileSync(path.join(path.dirname(schemaPath), 'planted'), '')),
    runner_config: denied(() => fs.readFileSync('/etc/factory-codex-runner.conf')),
    sudoers: denied(() => fs.readFileSync('/etc/sudoers.d/factory-codex')),
    app_write: denied(() => fs.writeFileSync('/usr/local/libexec/factory-codex/app/planted', '')),
  },
};

fs.writeFileSync(path.join(workspace, 'src/app.js'), 'export const value = 2;\n');
fs.writeFileSync(path.join(workspace, 'probe.json'), `${JSON.stringify(probe, null, 2)}\n`);
// A process left behind must not survive the job or touch the workspace later.
const straggler = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
straggler.unref();
fs.writeFileSync('/tmp/fake-codex-straggler.pid', String(straggler.pid));
fs.writeFileSync(outputPath, JSON.stringify({ status: 'completed', summary: 'probe', tests: ['linux uid probe'] }));
