/**
 * 조립 루트(composition root) — 웹 채팅 서버가 사는 곳.
 * 포트에 어댑터를 꽂아 세션을 구동한다. 골든패스가 진행되며 여기서 조립된다.
 *
 * 1단계("접속하면 채팅 화면이 보인다")에서는 아직 꽂을 어댑터가 없다 —
 * 정적 채팅 화면을 내려주는 HTTP 서버를 띄우는 것으로 충분하다.
 */
import { createServer } from './server';

const port = Number(process.env.PORT ?? 3000);

createServer().listen(port, () => {
  console.log(`devspace 서버 대기 중: http://localhost:${port}`);
});
