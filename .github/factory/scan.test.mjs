import test from 'node:test';
import assert from 'node:assert/strict';
import { findSecret } from './scan.mjs';

test('findSecret flags credential shapes and ignores ordinary text', () => {
  // built at run time so this file never contains a credential shape itself
  const x = (n) => 'A1b2'.repeat(n);
  for (const s of ['-----BEGIN RSA ' + 'PRIVATE KEY-----', 'AKIA' + 'ABCDEFGHIJKLMNOP', 'ghp' + '_' + x(9), 'sk-ant' + '-' + x(6), 'sk_live' + '_' + x(6)]) {
    assert.ok(findSecret(`const k = "${s}";`), s);
  }
  for (const s of ['process.env.STRIPE_SECRET_KEY', 'sk_test_placeholder', 'const token = readToken();']) {
    assert.equal(findSecret(s), null, s);
  }
});
