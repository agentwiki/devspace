/**
 * HTTP 서버 — 조립 루트의 일부. 라우팅만 담당하고, 세션 상태는 SessionHub,
 * 오케스트레이션은 core 유스케이스, 화면은 ui.ts가 맡는다.
 *
 * 포트를 주입받아(SessionPorts) 허브를 만든다 — 조립 루트(index.ts)는 실제
 * 어댑터를, 스모크 검증은 인메모리 포트를 꽂을 수 있다.
 *
 * 라우트 ↔ 골든패스 단계:
 *   GET  /                       1  채팅 화면
 *   POST /api/sessions           2  세션 시작(레포 지정)
 *   GET  /api/sessions/:id/events 3~7 진행 상황 SSE 스트림
 *   POST /api/sessions/:id/messages 4  지시 전송
 *   POST /api/sessions/:id/pr    7  PR 만들기
 */
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { SessionPorts } from '@devspace/core';
import { renderChatScreen } from './ui';
import { SessionHub } from './session-hub';

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error('요청 본문이 너무 큽니다'));
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, code: number, payload: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendText(res: ServerResponse, code: number, text: string): void {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function openSseStream(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  // 프록시/브라우저가 스트림을 바로 열도록 한 번 흘려준다.
  res.write(': ok\n\n');
}

async function stringField(req: IncomingMessage, field: string): Promise<string | null> {
  const body = await readJson(req);
  if (!body || typeof body !== 'object') return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' ? value.trim() || null : null;
}

export function createServer(ports: SessionPorts): Server {
  const hub = new SessionHub(ports);

  return createHttpServer((req, res) => {
    void route(req, res, hub).catch((error) => {
      console.error('요청 처리 실패:', error);
      if (!res.headersSent) sendText(res, 500, '서버 오류');
    });
  });
}

async function route(req: IncomingMessage, res: ServerResponse, hub: SessionHub): Promise<void> {
  const method = req.method ?? 'GET';
  const path = (req.url ?? '/').split('?')[0] ?? '/';

  const sessionRoute = path.match(/^\/api\/sessions\/([^/]+)\/(events|messages|pr)$/);
  const id = sessionRoute?.[1];
  const action = sessionRoute?.[2];
  if (id && action) return sessionSubRoute(req, res, hub, id, action, method);

  return topRoute(req, res, hub, method, path);
}

async function topRoute(
  req: IncomingMessage,
  res: ServerResponse,
  hub: SessionHub,
  method: string,
  path: string,
): Promise<void> {
  if (method === 'GET' && path === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderChatScreen());
    return;
  }
  if (method === 'GET' && path === '/healthz') {
    return sendText(res, 200, 'ok');
  }
  if (method === 'POST' && path === '/api/sessions') {
    const repo = await stringField(req, 'repo');
    if (!repo) return sendJson(res, 400, { error: 'repo가 필요합니다' });
    return sendJson(res, 201, { id: hub.create(repo) });
  }
  sendText(res, 404, 'not found');
}

async function sessionSubRoute(
  req: IncomingMessage,
  res: ServerResponse,
  hub: SessionHub,
  id: string,
  action: string,
  method: string,
): Promise<void> {
  if (method === 'GET' && action === 'events') {
    // 없는 세션은 스트림을 열기 전에 404로 끊는다 — 브라우저 EventSource가 CLOSED로
    // 판단해 재접속 실패를 UI로 표면화한다(조용한 실패 금지). 200으로 스트림을 연 뒤
    // 닫으면 EventSource가 정상 종료로 보고 무한 재시도한다.
    if (!hub.has(id)) return sendText(res, 404, 'no such session');
    openSseStream(res);
    if (!hub.subscribe(id, res)) res.end();
    return;
  }
  if (method === 'POST' && action === 'messages') {
    const text = await stringField(req, 'text');
    if (!text) return sendJson(res, 400, { error: 'text가 필요합니다' });
    return sendJson(res, hub.sendMessage(id, text) ? 202 : 404, {});
  }
  if (method === 'POST' && action === 'pr') {
    return sendJson(res, hub.openPullRequest(id) ? 202 : 404, {});
  }
  sendText(res, 404, 'not found');
}
