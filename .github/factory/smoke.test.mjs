import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRepositorySmoke, validateSmokeScript, validateSmokeSource } from './smoke.mjs';

test('smoke validator rejects common always-passing contracts', () => {
  for (const script of ['echo pass', 'node -e "process.exit(0)"', 'true', 'node fake.js']) assert.ok(validateSmokeScript(script).length, script);
  assert.ok(validateSmokeSource("test('fake', () => assert.ok(true));").length);
  assert.ok(validateSmokeSource("test('math', () => assert.equal(1, 1));").length);
});

test('repository smoke command exercises observable HTTP behavior', () => {
  assert.deepEqual(validateRepositorySmoke(), []);
});
