import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './server.mjs';

test('health endpoint and 404', async (t) => {
  await new Promise((r) => app.listen(0, r));
  t.after(() => app.close());
  const base = `http://localhost:${app.address().port}`;
  const ok = await fetch(`${base}/health`);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { status: 'ok' });
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});

test('version endpoint reads package.json', async (t) => {
  await new Promise((r) => app.listen(0, r));
  t.after(() => app.close());
  const base = `http://localhost:${app.address().port}`;
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(version);
  const res = await fetch(`${base}/version`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { version });
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});
