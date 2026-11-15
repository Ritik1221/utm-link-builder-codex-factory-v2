// Fails CI when a tracked file contains something shaped like a credential.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/, /\bsk-ant-[A-Za-z0-9_-]{20,}/, /\b[sr]k_live_[A-Za-z0-9]{20,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{20,}/, /\bAIza[0-9A-Za-z_-]{35}\b/,
];
export const findSecret = (text) => PATTERNS.find((re) => re.test(text)) ?? null;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const hits = [];
  for (const f of execFileSync('git', ['ls-files', '-z']).toString().split('\0').filter(Boolean)) {
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    if (text.length < 2_000_000 && findSecret(text)) hits.push(f);
  }
  if (hits.length) { console.error(`Possible secrets in: ${hits.join(', ')}`); process.exit(1); }
  console.log('No secrets found.');
}
