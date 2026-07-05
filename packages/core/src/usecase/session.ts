/**
 * 세션 유스케이스 — 골든패스(scenarios/golden-path.md)의 오케스트레이션.
 * 도메인 상태 머신(domain/session)으로 전이를 지키면서 포트(ports)를 순서대로
 * 엮는다. 포트 구현은 주입받고, UI로 흘려보낼 갱신은 emit 콜백으로 낸다.
 *
 * 대응하는 시나리오 단계:
 *   provision()    → 2~3 (레포 지정 → 샌드박스 준비)
 *   sendMessage()  → 4~6 (지시 → 에이전트 작업 → 변경 요약)
 *   openPr()       → 7   (PR 만들기 → PR 링크)
 */
import { transition, type SessionEvent, type SessionState } from '../domain/session';
import type { AgentPort, GitHostPort, SandboxPort } from '../ports';

export interface SessionPorts {
  sandbox: SandboxPort;
  agent: AgentPort;
  gitHost: GitHostPort;
}

/** UI로 흘려보내는 세션 갱신 — 서버가 SSE로 중계한다 */
export type SessionUpdate =
  | { kind: 'status'; state: SessionState; label: string }
  | { kind: 'message'; role: 'user' | 'system'; text: string }
  | { kind: 'activity'; line: string }
  | { kind: 'diff'; summary: string }
  | { kind: 'pr'; url: string };

export type Emit = (update: SessionUpdate) => void;

const STATUS_LABEL: Record<SessionState, string> = {
  provisioning: '샌드박스 준비 중',
  ready: '준비됨 — 무엇을 할까요?',
  'agent-working': '에이전트 작업 중',
  'awaiting-approval': '검토 대기',
  'opening-pr': 'PR 만드는 중',
  'pr-opened': 'PR 열림',
  failed: '실패',
};

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Session {
  private currentState: SessionState = 'provisioning';
  private sandboxId: string | null = null;

  constructor(
    readonly id: string,
    readonly repo: string,
    readonly branch: string,
    private readonly ports: SessionPorts,
    private readonly emit: Emit,
  ) {}

  get state(): SessionState {
    return this.currentState;
  }

  /** 상태 전이의 유일한 지점. 전이 후 새 상태를 status 갱신으로 낸다. */
  private go(event: SessionEvent): void {
    this.currentState = transition(this.currentState, event);
    this.emit({ kind: 'status', state: this.currentState, label: STATUS_LABEL[this.currentState] });
  }

  /**
   * 실패는 삼키지 않는다: failed로 전이해 UI에 알리고, 원래 예외를 다시 던져
   * 호출자(서버)가 로깅/정리하게 한다. (CLAUDE.md: 조용한 실패 금지)
   */
  private fail(error: unknown, context: string): never {
    if (this.currentState !== 'failed') this.go({ type: 'failure', reason: errMessage(error) });
    this.emit({ kind: 'message', role: 'system', text: `${context}: ${errMessage(error)}` });
    throw error;
  }

  private requireSandbox(): string {
    if (!this.sandboxId) throw new Error('샌드박스가 아직 준비되지 않았습니다');
    return this.sandboxId;
  }

  /** 2~3단계: 레포를 클론한 샌드박스를 준비한다 */
  async provision(): Promise<void> {
    this.emit({ kind: 'status', state: 'provisioning', label: STATUS_LABEL.provisioning });
    try {
      const { sandboxId } = await this.ports.sandbox.create(this.repo);
      this.sandboxId = sandboxId;
      this.go({ type: 'sandbox-ready' });
      this.emit({ kind: 'message', role: 'system', text: '샌드박스가 준비되었습니다.' });
    } catch (error) {
      this.fail(error, '샌드박스 준비 실패');
    }
  }

  /** 4~6단계: 지시를 에이전트에 넘기고, 진행을 흘리고, 끝나면 변경 요약을 낸다 */
  async sendMessage(text: string): Promise<void> {
    this.go({ type: 'user-message', text });
    this.emit({ kind: 'message', role: 'user', text });
    const sandboxId = this.requireSandbox();
    try {
      await this.ports.agent.run(sandboxId, text, (line) => this.emit({ kind: 'activity', line }));
      const summary = await this.ports.gitHost.diffSummary(sandboxId);
      this.go({ type: 'agent-finished' });
      this.emit({ kind: 'diff', summary });
    } catch (error) {
      this.fail(error, '에이전트 작업 실패');
    }
  }

  /** 7단계: 변경을 브랜치로 올리고 PR을 연다 */
  async openPr(title: string): Promise<void> {
    this.go({ type: 'approve-pr' });
    const sandboxId = this.requireSandbox();
    try {
      const { url } = await this.ports.gitHost.openPullRequest(sandboxId, {
        repo: this.repo,
        branch: this.branch,
        title,
      });
      this.go({ type: 'pr-created', url });
      this.emit({ kind: 'pr', url });
    } catch (error) {
      this.fail(error, 'PR 생성 실패');
    }
  }
}
