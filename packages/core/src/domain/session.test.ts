import { describe, expect, it } from 'vitest';
import {
  canTransition,
  InvalidTransitionError,
  transition,
  type SessionEvent,
  type SessionState,
} from './session';

describe('세션 상태 머신', () => {
  it('골든패스 시나리오의 전이 순서를 그대로 통과한다', () => {
    const events: SessionEvent[] = [
      { type: 'sandbox-ready' },
      { type: 'user-message', text: 'README에 한 줄 추가해줘' },
      { type: 'agent-finished' },
      { type: 'approve-pr' },
      { type: 'pr-created', url: 'https://github.com/o/r/pull/1' },
    ];
    const path = events.reduce<SessionState[]>(
      (states, event) => [...states, transition(states.at(-1)!, event)],
      ['provisioning'],
    );
    expect(path).toEqual([
      'provisioning',
      'ready',
      'agent-working',
      'awaiting-approval',
      'opening-pr',
      'pr-opened',
    ]);
  });

  it('승인 대기 중 추가 지시를 보내면 다시 에이전트 작업으로 돌아간다', () => {
    expect(transition('awaiting-approval', { type: 'user-message', text: '주석도 달아줘' })).toBe(
      'agent-working',
    );
  });

  it('허용되지 않은 전이는 조용히 무시되지 않고 예외를 던진다', () => {
    expect(() => transition('provisioning', { type: 'approve-pr' })).toThrow(InvalidTransitionError);
    expect(() => transition('pr-opened', { type: 'user-message', text: 'x' })).toThrow(
      InvalidTransitionError,
    );
  });

  it('어느 상태에서든 실패 이벤트는 failed로 수렴한다 (종결 상태 제외)', () => {
    for (const state of ['provisioning', 'ready', 'agent-working', 'awaiting-approval', 'opening-pr'] as const) {
      expect(transition(state, { type: 'failure', reason: 'boom' })).toBe('failed');
    }
  });

  it('canTransition은 던지지 않고 전이 가능 여부만 알려준다 (무효 전이 가드용, 이슈 C)', () => {
    // 종료 상태에선 추가 지시·PR 모두 불가 — 유스케이스가 이걸로 조용한 삼킴 대신 안내한다.
    expect(canTransition('pr-opened', 'user-message')).toBe(false);
    expect(canTransition('failed', 'user-message')).toBe(false);
    // opening-pr에서 다시 승인(중복 PR 클릭)은 불가.
    expect(canTransition('opening-pr', 'approve-pr')).toBe(false);
    expect(canTransition('pr-opened', 'approve-pr')).toBe(false);
    // 유효한 전이는 true.
    expect(canTransition('ready', 'user-message')).toBe(true);
    expect(canTransition('awaiting-approval', 'user-message')).toBe(true);
    expect(canTransition('awaiting-approval', 'approve-pr')).toBe(true);
  });
});
