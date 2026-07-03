/**
 * The container runtime: the narrow set of operations sandbox-core performs on
 * an already-provisioned container. Provisioning itself (clone + `devcontainer
 * up`) lives in provision.ts; everything post-`up` — exec, teardown, liveness —
 * goes through `docker` here.
 *
 * The docker argv builders are pure functions and are unit-tested directly, so
 * the (untestable-without-a-daemon) part is reduced to "hand this argv to
 * spawn", which the CommandRunner seam covers.
 */
import type { ExecRequest } from '@devspace/contracts';
import type { CommandRunner } from './cli.js';
import { runOrThrow } from './cli.js';
import type { ExecStream } from './exec.js';
import { dockerNetworkRmArgs } from './hardening.js';

export interface ContainerRuntime {
  /** Full-duplex exec inside the container (the load-bearing primitive). */
  execStream(containerId: string, req: ExecRequest): ExecStream;
  /** Force-remove the container and its anonymous volumes. */
  destroy(containerId: string): Promise<void>;
  /** True if the container still exists (any state). */
  exists(containerId: string): Promise<boolean>;
  /** Remove a per-env network created at provision time (M5 hardening). */
  removeNetwork?(name: string): Promise<void>;
}

/**
 * Build the argv for `docker exec`. Kept pure and total so it can be asserted
 * exactly in tests. `-i` is always present (stdin is half of the duplex); `-t`
 * only when a TTY was requested. Env is passed as repeated `-e K=V`.
 */
export function dockerExecArgs(containerId: string, req: ExecRequest): string[] {
  const args = ['exec', '-i'];
  if (req.tty) args.push('-t');
  if (req.cwd) args.push('-w', req.cwd);
  if (req.user) args.push('-u', req.user);
  for (const [key, value] of Object.entries(req.env ?? {})) {
    args.push('-e', `${key}=${value}`);
  }
  args.push(containerId, ...req.cmd);
  return args;
}

export const dockerRmArgs = (containerId: string): string[] => [
  'rm',
  '--force',
  '--volumes',
  containerId,
];

export const dockerInspectArgs = (containerId: string): string[] => [
  'inspect',
  '--format',
  '{{.Id}}',
  containerId,
];

export interface DockerRuntimeOptions {
  /** Path/name of the docker binary. */
  dockerPath?: string;
}

/** Talks to a local Docker daemon via the `docker` CLI. */
export class DockerRuntime implements ContainerRuntime {
  private readonly docker: string;

  constructor(
    private readonly runner: CommandRunner,
    options: DockerRuntimeOptions = {},
  ) {
    this.docker = options.dockerPath ?? 'docker';
  }

  execStream(containerId: string, req: ExecRequest): ExecStream {
    return this.runner.stream(this.docker, dockerExecArgs(containerId, req));
  }

  async destroy(containerId: string): Promise<void> {
    await runOrThrow(this.runner, this.docker, dockerRmArgs(containerId));
  }

  async exists(containerId: string): Promise<boolean> {
    const result = await this.runner.run(this.docker, dockerInspectArgs(containerId));
    return result.code === 0;
  }

  async removeNetwork(name: string): Promise<void> {
    await runOrThrow(this.runner, this.docker, dockerNetworkRmArgs(name));
  }
}
