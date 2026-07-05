/**
 * 조립 루트(composition root) — 웹 채팅 UI + HTTP/WS 서버가 사는 곳.
 * 포트에 어댑터를 꽂아 세션 상태 머신을 구동한다.
 * 골든패스 1단계("접속하면 채팅 화면이 보인다")부터 여기서 구현된다.
 */
import { transition, type SessionState } from '@devspace/core';

// 구현 전 임시 앵커 — 경계 규칙(core만 알고, adapters를 조립)이 살아있음을 보인다.
export const initialState: SessionState = 'provisioning';
export { transition };
