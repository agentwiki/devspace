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
