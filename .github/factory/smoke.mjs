import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateSmokeScript(script) {
  const errors = [];
  if (typeof script !== 'string' || !script.trim()) return ['e2e script is missing'];
  if (/[;&|`]|$\(|\b(echo|true|false)\b|(?:node\s+)?-e\b|process\.exit\s*\(/i.test(script)) errors.push('e2e script contains an inline or trivially passing command');
  if (!/(node\s+--test|playwright\s+test|cypress\s+run|vitest\s+run|jest\b)/i.test(script)) errors.push('e2e script must execute a recognized test runner');
  return errors;
}

export function validateSmokeSource(source) {
  const errors = [];
  if (!/\b(test|it)\s*\(/.test(source)) errors.push('smoke source defines no tests');
  if (!/(assert\.|expect\s*\()/i.test(source)) errors.push('smoke source contains no assertions');
  if (/assert\.(ok|equal|strictEqual)\s*\(\s*(true|1\s*,\s*1|['"][^'"]*['"]\s*,\s*['"][^'"]*['"])/.test(source) || /expect\s*\(\s*true\s*\)\.toBe\s*\(\s*true\s*\)/.test(source)) {
    errors.push('smoke source contains an obvious constant assertion');
  }
  if (!/(fetch\s*\(|request\s*\(|\.listen\s*\(|page\.(goto|click|fill)|spawn\s*\(|exec(File)?\s*\()/i.test(source)) {
    errors.push('smoke source does not exercise an observable process, HTTP or browser boundary');
  }
  return errors;
}

function filesFor(script) {
  const explicit = script.split(/\s+/).filter((token) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(token) && existsSync(token));
  if (explicit.length) return explicit;
  const roots = ['e2e', 'tests/e2e', 'test/e2e'].filter(existsSync);
  return roots.flatMap((root) => readdirSync(root, { recursive: true }).map((name) => join(root, name)).filter((name) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(name)));
}

export function validateRepositorySmoke(packageJson = JSON.parse(readFileSync('package.json', 'utf8'))) {
  const script = packageJson.scripts?.e2e;
  const errors = validateSmokeScript(script);
  const files = errors.length ? [] : filesFor(script);
  if (!files.length) errors.push('e2e script resolves to no smoke test files');
  for (const path of files) for (const error of validateSmokeSource(readFileSync(path, 'utf8'))) errors.push(`${path}: ${error}`);
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = validateRepositorySmoke();
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log('meaningful smoke contract validated');
}
