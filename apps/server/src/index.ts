/**
 * 조립 루트(composition root) — 웹 채팅 서버가 사는 곳.
 * 실제 어댑터를 포트에 꽂아(wiring) 세션을 구동하는 HTTP 서버를 띄운다.
 * 골든패스 전 단계(접속 → 샌드박스 → 에이전트 → PR)가 여기서 조립된다.
 */
import { createServer } from './server';
import { buildPorts } from './wiring';

const port = Number(process.env.PORT ?? 3000);

createServer(buildPorts()).listen(port, () => {
  console.log(`devspace 서버 대기 중: http://localhost:${port}`);
});
