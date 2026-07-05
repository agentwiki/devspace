/**
 * child_process를 감싼 작은 실행 헬퍼. 어댑터들이 공유한다.
 * 조용한 실패 금지: 0이 아닌 종료코드는 stderr를 담은 예외로 던지거나
 * 호출자가 code로 판단하도록 그대로 돌려준다(옵션).
 */
import { spawn } from 'node:child_process';
import type { ExecResult } from '@devspace/core';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 표준출력을 줄 단위로 흘려보낼 콜백 (스트리밍) */
  onLine?: (line: string) => void;
}

/** 명령을 실행하고 출력을 모아 돌려준다. 종료코드는 그대로 전달한다. */
export function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let lineBuffer = '';

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      if (!options.onLine) return;
      lineBuffer += text;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) options.onLine(line);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (options.onLine && lineBuffer.trim()) options.onLine(lineBuffer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

/** run과 같으나 0이 아닌 종료코드를 예외로 던진다. */
export async function runOrThrow(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<ExecResult> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      `명령 실패 (code ${result.code}): ${command} ${args.join(' ')}\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}
