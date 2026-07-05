/**
 * 세션 상태 머신 — 골든패스(scenarios/golden-path.md)의 도메인 표현.
 *
 * 시나리오 단계와의 대응:
 *   provisioning(2~3) → ready(3) → agent-working(4~5) → awaiting-approval(6)
 *   → opening-pr(7) → pr-opened(7~8)
 */
export type SessionState =
  | 'provisioning'
  | 'ready'
  | 'agent-working'
  | 'awaiting-approval'
  | 'opening-pr'
  | 'pr-opened'
  | 'failed';

export type SessionEvent =
  | { type: 'sandbox-ready' }
  | { type: 'user-message'; text: string }
  | { type: 'agent-finished' }
  | { type: 'approve-pr' }
  | { type: 'pr-created'; url: string }
  | { type: 'failure'; reason: string };

const TRANSITIONS: Record<SessionState, Partial<Record<SessionEvent['type'], SessionState>>> = {
  provisioning: { 'sandbox-ready': 'ready', failure: 'failed' },
  ready: { 'user-message': 'agent-working', failure: 'failed' },
  'agent-working': { 'agent-finished': 'awaiting-approval', failure: 'failed' },
  'awaiting-approval': {
    'approve-pr': 'opening-pr',
    // 승인 대신 추가 지시를 보내면 다시 에이전트 작업으로
    'user-message': 'agent-working',
    failure: 'failed',
  },
  'opening-pr': { 'pr-created': 'pr-opened', failure: 'failed' },
  'pr-opened': {},
  failed: {},
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly state: SessionState,
    readonly event: SessionEvent['type'],
  ) {
    super(`세션 상태 '${state}'에서는 '${event}' 이벤트를 처리할 수 없습니다`);
    this.name = 'InvalidTransitionError';
  }
}

/** 유일한 상태 전이 지점. 허용되지 않은 전이는 예외 — 조용히 무시하지 않는다. */
export function transition(state: SessionState, event: SessionEvent): SessionState {
  const next = TRANSITIONS[state][event.type];
  if (!next) throw new InvalidTransitionError(state, event.type);
  return next;
}
