/**
 * 웹 채팅 화면 — 골든패스 전 단계의 표면.
 *
 * 셸(HTML/CSS)과 클라이언트 스크립트를 함께 문자열로 낸다. 스크립트는 세션을
 * 시작하고 SSE로 진행 갱신을 받아 화면을 갱신한다. e2e 셀렉터(data-testid)는
 * scenarios/golden-path.md 의 단계와 대응한다:
 *   chat-screen(1) · repo-input/start-session-button(2) · session-status/message(3)
 *   · chat-input/send-button(4) · agent-activity(5) · diff-summary/create-pr-button(6)
 *   · pr-link(7)
 *
 * 순수 함수로 유지한다(포트도 node 내장도 모른다) — 유닛테스트로 고정된다.
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
    background: Canvas; color: CanvasText;
  }
  .chat-screen { display: flex; flex-direction: column; height: 100dvh; max-width: 820px; margin: 0 auto; }
  header { padding: 16px 20px; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent); }
  header h1 { margin: 0; font-size: 17px; }
  header p { margin: 4px 0 0; opacity: 0.65; font-size: 13px; }
  .bar { display: flex; gap: 8px; padding: 12px 20px; align-items: center; }
  .bar.session-start { border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent); }
  .bar input { flex: 1; }
  .status { padding: 8px 20px; font-size: 13px; opacity: 0.8; }
  .status[hidden] { display: none; }
  .messages { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 10px; }
  .messages:empty::after { content: '레포를 지정해 세션을 시작하세요.'; opacity: 0.5; }
  .msg { padding: 8px 12px; border-radius: 10px; max-width: 80%; background: color-mix(in srgb, CanvasText 7%, Canvas); }
  .msg.user { align-self: flex-end; background: color-mix(in srgb, AccentColor 22%, Canvas); }
  .activity { font-family: ui-monospace, monospace; font-size: 12.5px; opacity: 0.75; white-space: pre-wrap; }
  .diff-panel { margin: 4px 0; padding: 12px; border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 10px; }
  .diff-panel[hidden] { display: none; }
  .diff-panel pre { margin: 0 0 10px; max-height: 220px; overflow: auto; font-size: 12.5px; }
  a.pr-link[hidden] { display: none; }
  a.pr-link { display: inline-block; margin-top: 8px; }
  .composer { border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent); }
  input, button {
    font: inherit; padding: 9px 14px; border-radius: 8px;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    background: Canvas; color: CanvasText;
  }
  button { cursor: pointer; background: color-mix(in srgb, CanvasText 8%, Canvas); }
  button:disabled, input:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
</head>
<body>
  <main class="chat-screen" data-testid="chat-screen">
    <header>
      <h1>devspace</h1>
      <p>채팅으로 코드 수정을 시키고 PR을 받는다.</p>
    </header>

    <form class="bar session-start" data-testid="session-start">
      <input type="text" data-testid="repo-input" placeholder="작업할 레포 (owner/name)" autocomplete="off" />
      <button type="submit" data-testid="start-session-button">세션 시작</button>
    </form>

    <div class="status" data-testid="session-status" hidden></div>

    <section class="messages" data-testid="messages" aria-live="polite"></section>

    <form class="bar composer" data-testid="composer">
      <input type="text" data-testid="chat-input" placeholder="메시지를 입력하세요…" autocomplete="off" disabled />
      <button type="submit" data-testid="send-button" disabled>보내기</button>
    </form>
  </main>
  <script>${clientScript()}</script>
</body>
</html>
`;
}

/** 브라우저에서 도는 클라이언트 — 세션 시작, SSE 구독, 화면 갱신. */
function clientScript(): string {
  return `
  const byId = (id) => document.querySelector('[data-testid="' + id + '"]');
  const messages = byId('messages');
  const status = byId('session-status');
  const chatInput = byId('chat-input');
  const sendButton = byId('send-button');
  let sessionId = null;

  const post = (url, body) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

  function addMessage(role, text) {
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    el.setAttribute('data-testid', 'message');
    el.textContent = text;
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
  }

  function addActivity(line) {
    const el = document.createElement('div');
    el.className = 'msg activity';
    el.setAttribute('data-testid', 'agent-activity');
    el.textContent = line;
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
  }

  function showDiff(summary) {
    let panel = byId('diff-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'diff-panel';
      panel.setAttribute('data-testid', 'diff-panel');
      panel.innerHTML =
        '<pre data-testid="diff-summary"></pre>' +
        '<button type="button" data-testid="create-pr-button">PR 만들기</button>' +
        '<a class="pr-link" data-testid="pr-link" target="_blank" rel="noopener" hidden></a>';
      messages.appendChild(panel);
      panel.querySelector('[data-testid="create-pr-button"]')
        .addEventListener('click', () => sessionId && post('/api/sessions/' + sessionId + '/pr'));
    }
    panel.querySelector('[data-testid="diff-summary"]').textContent = summary;
    messages.scrollTop = messages.scrollHeight;
  }

  function showPr(url) {
    const link = byId('pr-link');
    if (!link) return;
    link.href = url;
    link.textContent = url;
    link.hidden = false;
  }

  function handle(update) {
    if (update.kind === 'status') {
      status.hidden = false;
      status.textContent = update.label;
      if (update.state === 'ready') { chatInput.disabled = false; sendButton.disabled = false; }
    } else if (update.kind === 'message') {
      addMessage(update.role, update.text);
    } else if (update.kind === 'activity') {
      addActivity(update.line);
    } else if (update.kind === 'diff') {
      showDiff(update.summary);
    } else if (update.kind === 'pr') {
      showPr(update.url);
    }
  }

  byId('session-start').addEventListener('submit', async (e) => {
    e.preventDefault();
    const repo = byId('repo-input').value.trim();
    if (!repo || sessionId) return;
    byId('start-session-button').disabled = true;
    const res = await post('/api/sessions', { repo });
    const data = await res.json();
    sessionId = data.id;
    status.hidden = false;
    const events = new EventSource('/api/sessions/' + sessionId + '/events');
    events.onmessage = (ev) => handle(JSON.parse(ev.data));
  });

  byId('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text || !sessionId) return;
    chatInput.value = '';
    post('/api/sessions/' + sessionId + '/messages', { text });
  });
  `;
}
