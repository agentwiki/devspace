/**
 * HTTP 서버 — 조립 루트의 일부. 라우팅만 담당하고 화면은 ui.ts가 그린다.
 * 골든패스 1단계: GET / 로 채팅 화면을 돌려준다. (다음 단계에서 세션
 * 시작·에이전트 스트리밍·PR 생성 라우트가 여기에 얹힌다.)
 */
import { createServer as createHttpServer, type Server } from 'node:http';
import { renderChatScreen } from './ui';

export function createServer(): Server {
  return createHttpServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderChatScreen());
      return;
    }

    // 서버 기동 확인용(예: Playwright webServer 준비 대기).
    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
}
