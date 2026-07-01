import { createServer } from 'node:http';
import type { ChatPlatform } from '@devspace/contracts';

const SERVICE = 'chat-gateway';
const PORT = Number(process.env.PORT ?? 4002);
const platform: ChatPlatform = 'slack';

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: SERVICE, platform }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`[${SERVICE}] listening on :${PORT} (default platform: ${platform})`);
});
