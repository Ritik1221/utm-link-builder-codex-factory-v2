import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const app = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  } else {
    res.writeHead(404).end();
  }
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) app.listen(process.env.PORT ?? 3000);
