import { describe, expect, it, vi } from 'vitest';
import { Session, type SessionPorts, type SessionUpdate } from './session';
import type { AgentPort, ExecResult, GitHostPort, SandboxPort } from '../ports';

const okExec: ExecResult = { stdout: '', stderr: '', code: 0 };

function inMemoryPorts(overrides: Partial<SessionPorts> = {}): SessionPorts {
  const sandbox: SandboxPort = {
    create: async () => ({ sandboxId: 'sbx-1' }),
    exec: async () => okExec,
    execStream: async () => okExec,
    destroy: async () => {},
  };
  const agent: AgentPort = {
    run: async (_id, _instruction, onActivity) => {
      onActivity('파일을 읽는 중…');
      onActivity('README.md 수정 중…');
    },
  };
  const gitHost: GitHostPort = {
    diffSummary: async () => ' README.md | 1 +\n+Hello from devspace',
    openPullRequest: async () => ({ url: 'https://github.com/o/r/pull/7' }),
  };
  return { sandbox, agent, gitHost, ...overrides };
}

function collect(): { emit: (u: SessionUpdate) => void; updates: SessionUpdate[] } {
  const updates: SessionUpdate[] = [];
  return { emit: (u) => updates.push(u), updates };
}

describe('세션 유스케이스 (골든패스 오케스트레이션)', () => {
  it('provision→sendMessage→openPr 전체 흐름이 시나리오 순서대로 갱신을 낸다', async () => {
    const { emit, updates } = collect();
    const session = new Session('s1', 'o/r', 'devspace/x', inMemoryPorts(), emit);

    await session.provision();
    await session.sendMessage('README.md 맨 아래에 "Hello from devspace" 한 줄을 추가해줘.');
    await session.openPr('README.md 맨 아래에 "Hello from devspace" 한 줄을 추가해줘.');

    expect(session.state).toBe('pr-opened');
    // 준비 중 상태가 흐른다 (시나리오 3단계: '준비 중')
    expect(updates).toContainEqual({ kind: 'status', state: 'provisioning', label: '샌드박스 준비 중' });
    // 샌드박스 준비 완료 메시지 (3단계)
    expect(updates).toContainEqual({ kind: 'message', role: 'system', text: '샌드박스가 준비되었습니다.' });
    // 에이전트 진행 (5단계)
    expect(updates.filter((u) => u.kind === 'activity')).toHaveLength(2);
    // 변경 요약에 README.md (6단계)
    const diff = updates.find((u) => u.kind === 'diff');
    expect(diff).toBeDefined();
    expect(diff && diff.kind === 'diff' && diff.summary).toContain('README.md');
    // PR 링크 (7단계)
    expect(updates).toContainEqual({ kind: 'pr', url: 'https://github.com/o/r/pull/7' });
  });

  it('승인 대기 중 추가 지시를 보내면 다시 에이전트 작업으로 돌아간다', async () => {
    const { emit } = collect();
    const session = new Session('s1', 'o/r', 'b', inMemoryPorts(), emit);
    await session.provision();
    await session.sendMessage('첫 지시');
    expect(session.state).toBe('awaiting-approval');
    await session.sendMessage('주석도 달아줘');
    expect(session.state).toBe('awaiting-approval');
  });

  it('샌드박스 준비가 실패하면 조용히 넘어가지 않고 failed로 전이 후 다시 던진다', async () => {
    const { emit, updates } = collect();
    const boom = new Error('docker 없음');
    const session = new Session(
      's1',
      'o/r',
      'b',
      inMemoryPorts({
        sandbox: {
          create: async () => {
            throw boom;
          },
          exec: async () => okExec,
          execStream: async () => okExec,
          destroy: async () => {},
        },
      }),
      emit,
    );

    await expect(session.provision()).rejects.toThrow('docker 없음');
    expect(session.state).toBe('failed');
    expect(updates).toContainEqual({ kind: 'status', state: 'failed', label: '실패' });
  });

  it('에이전트 진행을 실시간으로(요약 이전에) 흘려보낸다', async () => {
    const seen: string[] = [];
    const emit = (u: SessionUpdate): void => {
      if (u.kind === 'activity') seen.push(u.line);
      if (u.kind === 'diff') seen.push('DIFF');
    };
    const agent: AgentPort = {
      run: async (_id, _instruction, onActivity) => {
        onActivity('a');
        onActivity('b');
      },
    };
    const gitHost: GitHostPort = {
      diffSummary: vi.fn(async () => 'README.md'),
      openPullRequest: async () => ({ url: 'u' }),
    };
    const session = new Session('s1', 'o/r', 'b', inMemoryPorts({ agent, gitHost }), emit);
    await session.provision();
    await session.sendMessage('x');
    expect(seen).toEqual(['a', 'b', 'DIFF']);
  });
});
