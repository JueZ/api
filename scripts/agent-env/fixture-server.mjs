import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const [port, record] = process.argv.slice(2);
const fixtures = {
  '/health': { ok: true },
  '/reddit/comments/seed.json': [{ data: { children: [] } }],
  '/bring/bringlists': { lists: [{ listUuid: '00000000-0000-4000-8000-000000000001', name: 'Agent list' }] },
  '/wlh/search': { items: [{ id: 'fixture-offer', title: 'Fixture bicycle' }] },
};
createServer((req, res) => {
  let bytes = 0;
  req.on('data', (b) => (bytes += b.length));
  req.on('end', () => {
    appendFileSync(
      record,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        method: req.method,
        path: new URL(req.url, 'http://localhost').pathname,
        bytes,
      }) + '\n',
    );
    const body = fixtures[new URL(req.url, 'http://localhost').pathname];
    res.setHeader('content-type', 'application/json');
    if (!body) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'unexpected fixture request' }));
      return;
    }
    res.end(JSON.stringify(body));
  });
}).listen(Number(port), '127.0.0.1');
