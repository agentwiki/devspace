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
  .msg.notice { align-self: center; max-width: 100%; text-align: center; font-size: 13px;
    background: color-mix(in srgb, AccentColor 12%, Canvas);
    border: 1px solid color-mix(in srgb, AccentColor 40%, transparent); }
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

/** 브라우저에서 도는 클라이언트 — 세션 시작, SSE 구독/재구독, 화면 갱신. */
function clientScript(): string {
  return `
  const byId = (id) => document.querySelector('[data-testid="' + id + '"]');
  const messages = byId('messages');
  const status = byId('session-status');
  const chatInput = byId('chat-input');
  const sendButton = byId('send-button');
  const repoInput = byId('repo-input');
  const startButton = byId('start-session-button');
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

  // 지금 할 수 없는 동작에 대한 안내 — 조용히 사라지지 않고 눈에 띄게 알린다.
  function addNotice(text) {
    const el = document.createElement('div');
    el.className = 'msg notice';
    el.setAttribute('data-testid', 'notice');
    el.setAttribute('role', 'status');
    el.textContent = text;
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
  }

  function disableCreatePr() {
    const btn = byId('create-pr-button');
    if (btn) btn.disabled = true;
  }

  // 상태에 맞춰 컨트롤을 잠근다: 종료(pr-opened/failed)나 진행 중엔 입력창을 닫아
  // 사라질 메시지를 애초에 못 보내게 하고, PR 버튼도 중복 클릭을 막는다.
  // 추가 지시로 다시 작업 중(agent-working)일 때도 이전 라운드의 PR 버튼을 잠가,
  // 아직 갱신되지 않은 옛 요약으로 PR을 여는 무효 전이(→notice)를 애초에 막는다(이슈 B).
  function applyComposerState(state) {
    const canChat = state === 'ready' || state === 'awaiting-approval';
    const terminal = state === 'pr-opened' || state === 'failed';
    chatInput.disabled = !canChat;
    sendButton.disabled = !canChat;
    chatInput.placeholder = terminal
      ? '이 세션은 끝났습니다 — 새 세션을 시작하세요.'
      : '메시지를 입력하세요…';
    if (terminal || state === 'opening-pr' || state === 'agent-working') disableCreatePr();
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
      panel.querySelector('[data-testid="create-pr-button"]')
        .addEventListener('click', (e) => {
          // 즉시 비활성화 — 두 번째 클릭이 opening-pr에서 무효 전이로 조용히 삼켜지지 않게.
          e.currentTarget.disabled = true;
          if (sessionId) post('/api/sessions/' + sessionId + '/pr');
        });
    }
    // 반복 지시(이슈 B): 라운드마다 같은 패널을 재사용하되 최신 진행 아래로 옮기고,
    // 작업 중 잠갔던 PR 버튼을 다시 열어 갱신된 요약으로 PR을 만들 수 있게 한다.
    messages.appendChild(panel);
    panel.querySelector('[data-testid="create-pr-button"]').disabled = false;
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
      applyComposerState(update.state);
    } else if (update.kind === 'message') {
      addMessage(update.role, update.text);
    } else if (update.kind === 'activity') {
      addActivity(update.line);
    } else if (update.kind === 'diff') {
      showDiff(update.summary);
    } else if (update.kind === 'pr') {
      showPr(update.url);
    } else if (update.kind === 'notice') {
      addNotice(update.text);
    }
  }

  // SSE 구독. 서버가 세션별 버퍼를 재생하므로 재접속(새로고침) 시 지나간 진행이 되살아난다.
  function subscribe(id) {
    const events = new EventSource('/api/sessions/' + id + '/events');
    events.onmessage = (ev) => handle(JSON.parse(ev.data));
    // 없는 세션이면 서버가 404로 스트림을 열지 않는다 → EventSource가 CLOSED가 되고
    // 재시도하지 않는다. (일시적 네트워크 끊김은 CONNECTING 상태로 자동 재구독되니 건드리지 않는다.)
    events.onerror = () => {
      if (events.readyState === EventSource.CLOSED) {
        events.close();
        sessionLost();
      }
    };
  }

  // 세션 화면으로 들어간다: 시작 바를 잠그고, id를 URL 해시에 남겨 새로고침·북마크에도 살아남게 한다.
  function enterSession(id) {
    sessionId = id;
    if (location.hash.slice(1) !== id) location.hash = id;
    repoInput.disabled = true;
    startButton.disabled = true;
    status.hidden = false;
    subscribe(id);
  }

  // 재접속했는데 세션이 서버에 없다(프로세스 재시작 등). 조용히 멈추지 않고 명확히 안내한다.
  function sessionLost() {
    sessionId = null;
    location.hash = '';
    status.hidden = false;
    status.textContent = '이전 세션을 찾을 수 없습니다 — 새 세션을 시작하세요.';
    chatInput.disabled = true;
    sendButton.disabled = true;
    repoInput.disabled = false;
    startButton.disabled = false;
  }

  byId('session-start').addEventListener('submit', async (e) => {
    e.preventDefault();
    const repo = repoInput.value.trim();
    if (!repo || sessionId) return;
    startButton.disabled = true;
    const res = await post('/api/sessions', { repo });
    const data = await res.json();
    enterSession(data.id);
  });

  byId('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text || !sessionId) return;
    chatInput.value = '';
    post('/api/sessions/' + sessionId + '/messages', { text });
  });

  // 로드 시 URL 해시에 세션 id가 있으면 곧바로 재구독한다 — 새로고침·북마크로 이어가기.
  const resumeId = location.hash.slice(1);
  if (resumeId) enterSession(resumeId);
  `;
}
