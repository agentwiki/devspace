import { createServer } from 'node:http';
import { classifyAction } from '@devspace/orchestrator';

const SERVICE = 'orchestrator';
const PORT = Number(process.env.PORT ?? 4000);

// Smoke-reference the control-plane logic so wiring compiles; full handlers in M3/M4.
void classifyAction('view-pr');

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: SERVICE }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`[${SERVICE}] listening on :${PORT}`);
});
