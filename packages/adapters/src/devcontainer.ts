/**
 * SandboxPort 구현 — @devcontainers/cli 로 레포를 클론한 devcontainer를 띄운다.
 * (README 구성요소: 샌드박스 = @devcontainers/cli)
 *
 * 실제 Docker가 필요하다 — 이 어댑터의 진짜 검증은 CI의 골든패스 E2E다.
 * 로직 배치: '도구 호출 방법'이므로 adapters (CLAUDE.md 판별표).
 *
 * 설계 메모(docs/decisions.md §9):
 *  - sandboxId = 호스트의 워크스페이스 폴더 경로. devcontainer 서브커맨드가
 *    --workspace-folder 로 컨테이너를 식별하므로 이것을 그대로 핸들로 쓴다.
 *  - 레포에 .devcontainer가 없으면 기본 설정(node 이미지)을 얹는다. 있으면 존중.
 *  - codex를 샌드박스 안에서 돌리기 위해 호스트의 ~/.codex(구독 인증)를
 *    컨테이너에 바인드 마운트하고, up 이후 codex CLI를 설치한다.
 */
import { mkdtemp, rm, writeFile, mkdir, access, appendFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type { ExecResult, SandboxPort } from '@devspace/core';
import { run, runOrThrow } from './exec';

/**
 * @devcontainers/cli 의 bin 경로를 해석한다. PATH에 의존하지 않고 node로 직접
 * 실행하려는 것 — pnpm은 이 bin을 워크스페이스 패키지의 .bin에만 링크하므로
 * 서버 PATH에는 없을 수 있다.
 */
function resolveDevcontainerBin(): string {
  const require = createRequire(import.meta.url);
  const pkgJson = require.resolve('@devcontainers/cli/package.json');
  return join(dirname(pkgJson), 'devcontainer.js');
}

export interface DevcontainerOptions {
  /** 프라이빗 레포 클론/푸시에 쓸 GitHub 토큰 (공개 레포면 생략 가능) */
  token?: string;
  /** 호스트의 codex 인증 디렉토리 (기본 ~/.codex) */
  codexAuthDir?: string;
}

const DEFAULT_DEVCONTAINER = {
  image: 'mcr.microsoft.com/devcontainers/javascript-node:22',
  remoteUser: 'node',
};

interface UpResult {
  outcome: string;
  containerId?: string;
}

function cloneUrl(repo: string, token: string | undefined): string {
  return token
    ? `https://x-access-token:${token}@github.com/${repo}.git`
    : `https://github.com/${repo}.git`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function createDevcontainerSandbox(options: DevcontainerOptions = {}): SandboxPort {
  const codexAuthDir = options.codexAuthDir ?? join(homedir(), '.codex');
  const bin = resolveDevcontainerBin();
  // sandboxId(경로) → 정리에 필요한 컨테이너 id
  const containers = new Map<string, string>();

  async function ensureConfig(workspace: string): Promise<void> {
    const configPath = join(workspace, '.devcontainer', 'devcontainer.json');
    if (await exists(configPath)) return;
    if (await exists(join(workspace, '.devcontainer.json'))) return;
    await mkdir(join(workspace, '.devcontainer'), { recursive: true });
    await writeFile(configPath, JSON.stringify(DEFAULT_DEVCONTAINER, null, 2), 'utf8');
    // 우리가 넣은 설정은 레포의 것이 아니다 — git이 무시하게 해 diff/PR을 오염시키지 않는다.
    await appendFile(join(workspace, '.git', 'info', 'exclude'), '\n/.devcontainer/devcontainer.json\n');
  }

  const dc = (args: readonly string[], onLine?: (l: string) => void): Promise<ExecResult> =>
    run(process.execPath, [bin, ...args], onLine ? { onLine } : {});
  const dcOrThrow = (args: readonly string[]): Promise<ExecResult> =>
    runOrThrow(process.execPath, [bin, ...args]);

  return {
    async create(repo) {
      const workspace = await mkdtemp(join(tmpdir(), 'devspace-'));
      await runOrThrow('git', ['clone', '--depth', '1', cloneUrl(repo, options.token), workspace]);
      await ensureConfig(workspace);

      const up = await dcOrThrow([
        'up',
        '--workspace-folder',
        workspace,
        '--mount',
        `type=bind,source=${codexAuthDir},target=/home/node/.codex`,
        '--log-format',
        'json',
      ]);
      const result = parseUpResult(up.stdout);
      if (result.containerId) containers.set(workspace, result.containerId);

      // codex CLI를 샌드박스 안에 설치 (구독 인증은 마운트된 ~/.codex 사용).
      await dcOrThrow([
        'exec',
        '--workspace-folder',
        workspace,
        '--',
        'npm',
        'install',
        '-g',
        '@openai/codex',
      ]);

      return { sandboxId: workspace };
    },

    exec(sandboxId, command) {
      return dc(['exec', '--workspace-folder', sandboxId, '--', ...command]);
    },

    execStream(sandboxId, command, onLine) {
      return dc(['exec', '--workspace-folder', sandboxId, '--', ...command], onLine);
    },

    async destroy(sandboxId) {
      const containerId = containers.get(sandboxId);
      if (containerId) await run('docker', ['rm', '-f', containerId]);
      containers.delete(sandboxId);
      await rm(sandboxId, { recursive: true, force: true });
    },
  };
}

/** devcontainer up --log-format json 은 마지막 줄에 결과 JSON을 낸다. */
export function parseUpResult(stdout: string): UpResult {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines.reverse()) {
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as UpResult;
      if (parsed.outcome) return parsed;
    } catch {
      // JSON이 아닌 로그 줄 — 다음 후보로.
      continue;
    }
  }
  throw new Error(`devcontainer up 결과를 해석할 수 없습니다:\n${stdout}`);
}
