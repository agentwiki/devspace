/**
 * 웹 채팅 화면 — 골든패스 1단계("접속하면 채팅 화면이 보인다")의 표면.
 *
 * 지금은 정적 셸이다: 레포를 지정해 세션을 시작하는 패널과, 대화/작성 영역의
 * 뼈대만 있다. 세션 시작·에이전트 진행·PR 생성 같은 동작은 골든패스의 다음
 * 단계에서 이 셸 위에 차례로 얹힌다.
 *
 * 순수 함수로 유지한다(포트도 node 내장도 모른다) — 유닛테스트로 고정된다.
 * e2e 셀렉터(data-testid)는 scenarios/golden-path.md 의 단계와 대응한다.
 */
export function renderChatScreen(): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>devspace</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 15px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif;
    background: Canvas;
    color: CanvasText;
  }
  .chat-screen {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    max-width: 820px;
    margin: 0 auto;
  }
  header {
    padding: 16px 20px;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
  }
  header h1 { margin: 0; font-size: 17px; }
  header p { margin: 4px 0 0; opacity: 0.65; font-size: 13px; }
  .session-start {
    display: flex;
    gap: 8px;
    padding: 16px 20px;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
  }
  .session-start input { flex: 1; }
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .messages:empty::after {
    content: '레포를 지정해 세션을 시작하세요.';
    opacity: 0.5;
  }
  .composer {
    display: flex;
    gap: 8px;
    padding: 16px 20px;
    border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
  }
  .composer input { flex: 1; }
  input, button {
    font: inherit;
    padding: 9px 14px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    background: Canvas;
    color: CanvasText;
  }
  button {
    cursor: pointer;
    background: color-mix(in srgb, CanvasText 8%, Canvas);
  }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
</head>
<body>
  <main class="chat-screen" data-testid="chat-screen">
    <header>
      <h1>devspace</h1>
      <p>채팅으로 코드 수정을 시키고 PR을 받는다.</p>
    </header>

    <form class="session-start" data-testid="session-start">
      <input
        type="text"
        name="repo"
        data-testid="repo-input"
        placeholder="작업할 레포 (owner/name)"
        autocomplete="off"
      />
      <button type="submit" data-testid="start-session-button">세션 시작</button>
    </form>

    <section class="messages" data-testid="messages" aria-live="polite"></section>

    <form class="composer" data-testid="composer">
      <input
        type="text"
        name="message"
        data-testid="chat-input"
        placeholder="메시지를 입력하세요…"
        autocomplete="off"
        disabled
      />
      <button type="submit" data-testid="send-button" disabled>보내기</button>
    </form>
  </main>
</body>
</html>
`;
}
