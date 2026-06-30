import { createServer } from 'node:http';
import { DevcontainerSandboxCore } from '@devspace/sandbox-core';

const SERVICE = 'sandbox-core';
const PORT = Number(process.env.PORT ?? 4001);

// Instantiated to prove the wiring compiles; real HTTP/gRPC routes land in M1.
const core = new DevcontainerSandboxCore();
void core;

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
