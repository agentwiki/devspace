import { describe, expect, it } from 'vitest';
import { renderChatScreen } from './ui';

describe('채팅 화면 렌더링 (골든패스 1단계)', () => {
  it('접속하면 보이는 채팅 화면 루트를 담는다', () => {
    expect(renderChatScreen()).toContain('data-testid="chat-screen"');
  });

  it('완결된 HTML 문서를 돌려준다', () => {
    expect(renderChatScreen().trimStart().toLowerCase().startsWith('<!doctype html>')).toBe(true);
  });
});

describe('세션 재접속 (이슈 A)', () => {
  it('로드 시 URL 해시의 세션 id로 곧바로 재구독한다', () => {
    const html = renderChatScreen();
    // 세션 id를 해시에 보존하고, 로드 시 있으면 이어붙인다.
    expect(html).toContain('location.hash');
    expect(html).toContain('const resumeId = location.hash.slice(1)');
  });

  it('없는 세션 재접속은 조용히 멈추지 않고 명확히 안내한다', () => {
    const html = renderChatScreen();
    expect(html).toContain('EventSource.CLOSED');
    expect(html).toContain('이전 세션을 찾을 수 없습니다');
  });
});

describe('종료 상태 UX + 조용한 실패 제거 (이슈 C)', () => {
  it('종료 상태(pr-opened/failed)에서 입력창을 잠근다', () => {
    const html = renderChatScreen();
    // 상태에 맞춰 컴포저를 잠그는 경로가 있다.
    expect(html).toContain('applyComposerState');
    expect(html).toContain("state === 'pr-opened' || state === 'failed'");
  });

  it('PR 만들기 버튼은 클릭 즉시 비활성화된다 (중복 클릭으로 조용히 삼켜지지 않게)', () => {
    const html = renderChatScreen();
    expect(html).toContain('e.currentTarget.disabled = true');
  });

  it('할 수 없는 동작에 대한 안내(notice)를 조용히 삼키지 않고 화면에 띄운다', () => {
    const html = renderChatScreen();
    expect(html).toContain("update.kind === 'notice'");
    expect(html).toContain("setAttribute('data-testid', 'notice')");
  });
});

describe('반복 지시 후 PR (이슈 B)', () => {
  it('라운드마다 diff 패널을 최신 진행 아래로 옮겨 갱신한다', () => {
    const html = renderChatScreen();
    // showDiff는 패널을 재사용하되 매번 messages 끝으로 이동시킨다(appendChild).
    expect(html).toContain('messages.appendChild(panel)');
  });

  it('작업 중(agent-working)엔 이전 라운드 PR 버튼을 잠갔다가 새 요약이 오면 다시 연다', () => {
    const html = renderChatScreen();
    expect(html).toContain("state === 'opening-pr' || state === 'agent-working'");
    expect(html).toContain(
      "panel.querySelector('[data-testid=\"create-pr-button\"]').disabled = false",
    );
  });
});
