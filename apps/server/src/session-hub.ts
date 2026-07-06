/**
 * 세션 허브 — 실행 중인 세션들을 보관하고, 유스케이스가 내는 갱신(SessionUpdate)을
 * SSE 구독자들에게 중계한다. 늦게 접속한 구독자도 놓친 갱신을 받도록 버퍼를 재생한다.
 *
 * 조립 루트의 일부다. 오케스트레이션 규칙은 core의 유스케이스에 있고, 여기서는
 * '누가 구독 중인지'와 '지나간 갱신을 어떻게 재생하는지'만 다룬다.
 */
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { Session, type SessionPorts, type SessionUpdate } from '@devspace/core';

interface SessionEntry {
  session: Session;
  buffer: SessionUpdate[];
  clients: Set<ServerResponse>;
  lastInstruction: string;
}

function writeSse(res: ServerResponse, update: SessionUpdate): void {
  res.write(`data: ${JSON.stringify(update)}\n\n`);
}

export class SessionHub {
  private readonly entries = new Map<string, SessionEntry>();

  constructor(private readonly ports: SessionPorts) {}

  /** 세션을 만들고 샌드박스 준비를 곧바로 시작한다. */
  create(repo: string): string {
    const id = randomUUID();
    const branch = `devspace/${id.slice(0, 8)}`;
    const entry: SessionEntry = {
      buffer: [],
      clients: new Set(),
      lastInstruction: '',
      session: undefined as unknown as Session,
    };
    const emit = (update: SessionUpdate): void => {
      entry.buffer.push(update);
      for (const client of entry.clients) writeSse(client, update);
    };
    entry.session = new Session(id, repo, branch, this.ports, emit);
    this.entries.set(id, entry);
    // 준비는 비동기로 진행된다. 실패는 유스케이스가 이미 UI로 냈고, 여기선 로깅.
    void entry.session.provision().catch((error) => console.error('provision 실패:', error));
    return id;
  }

  /** 세션이 살아 있는지 — 재접속 요청이 유효한지 스트림을 열기 전에 확인한다. */
  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** SSE 구독자를 붙인다. 지나간 갱신을 먼저 재생하고, 연결 종료 시 제거한다. */
  subscribe(id: string, res: ServerResponse): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    for (const update of entry.buffer) writeSse(res, update);
    entry.clients.add(res);
    res.on('close', () => entry.clients.delete(res));
    return true;
  }

  sendMessage(id: string, text: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.lastInstruction = text;
    void entry.session.sendMessage(text).catch((error) => console.error('sendMessage 실패:', error));
    return true;
  }

  openPullRequest(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    const title = entry.lastInstruction || 'devspace 변경';
    void entry.session.openPr(title).catch((error) => console.error('openPr 실패:', error));
    return true;
  }
}
