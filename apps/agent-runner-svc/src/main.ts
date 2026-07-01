import { createServer } from 'node:http';
import { codexBackend } from '@devspace/agent-runner';

const SERVICE = 'agent-runner';
const PORT = Number(process.env.PORT ?? 4003);

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: SERVICE, backends: [codexBackend.kind] }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`[${SERVICE}] listening on :${PORT} (backends: ${codexBackend.kind})`);
});
