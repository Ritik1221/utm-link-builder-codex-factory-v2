import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const pkgUrl = new URL('../package.json', import.meta.url);

export const app = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  } else if (req.method === 'GET' && req.url === '/version') {
    const { version } = JSON.parse(readFileSync(pkgUrl, 'utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version }));
  } else {
    res.writeHead(404).end();
  }
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) app.listen(process.env.PORT ?? 3000);
