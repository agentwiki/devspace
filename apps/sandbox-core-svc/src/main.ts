/**
 * Deployable entrypoint for sandbox-core.
 *
 * The load-bearing full-duplex exec stream is consumed IN-PROCESS by
 * agent-runner (a workspace dependency, per the DAG in docs/architecture.md),
 * so it is not exposed over the network here. This service exposes the JSON
 * control surface — environment lifecycle, fs ops, and a capture-only exec for
 * ops/debugging — so the sandbox can be driven and inspected out-of-band.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CreateEnvironmentRequestSchema,
  ExecRequestSchema,
  FsListRequestSchema,
  FsReadRequestSchema,
  FsWriteRequestSchema,
} from '@devspace/contracts';
import type { ErrorCode } from '@devspace/contracts';
import {
  DEFAULT_EGRESS_ALLOWLIST,
  DevcontainerSandboxCore,
  EgressProxy,
  SandboxError,
  assertRuntimeAvailable,
  captureExec,
  fromBase64,
  hardeningFromEnv,
  nodeCommandRunner,
  toBase64,
} from '@devspace/sandbox-core';
import { z } from 'zod';

const SERVICE = 'sandbox-core';
const PORT = Number(process.env.PORT ?? 4001);

// M5 hardening is boot-time host policy (m5-plan Decision 1). Fail fast when
// the configured runtime class (gVisor/Kata) is absent from the daemon.
const hardening = hardeningFromEnv(process.env);
if (hardening?.runtime) {
  await assertRuntimeAvailable(nodeCommandRunner, hardening.runtime);
  console.log(`[${SERVICE}] container runtime: ${hardening.runtime}`);
}

// The egress allowlist proxy — the only door out of an --internal env network.
// EGRESS_ALLOWLIST extends the sandbox defaults (comma-separated hostnames).
if (hardening?.egressProxyPort) {
  const allowlist = [
    ...DEFAULT_EGRESS_ALLOWLIST,
    ...(process.env.EGRESS_ALLOWLIST ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ];
  const proxy = new EgressProxy({
    allowlist,
    port: hardening.egressProxyPort,
    onLog: (line) => console.log(`[${SERVICE}] egress: ${line}`),
  });
  await proxy.start();
  console.log(`[${SERVICE}] egress proxy on :${hardening.egressProxyPort}`);
}

const core = new DevcontainerSandboxCore({ hardening });

const ERROR_STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PROVISION_FAILED: 500,
  EXEC_FAILED: 500,
  AGENT_FAILED: 500,
  GUARDRAIL_BLOCKED: 403,
  INTERNAL: 500,
};

const server = createServer((req, res) => {
  handle(req, res).catch((err) => sendError(res, err));
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const segments = url.pathname.split('/').filter(Boolean);
  const method = req.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { status: 'ok', service: SERVICE });
  }

  // /environments ...
  if (segments[0] === 'environments') {
    const envId = segments[1];

    if (method === 'POST' && segments.length === 1) {
      const body = CreateEnvironmentRequestSchema.parse(await readJson(req));
      return sendJson(res, 201, await core.createEnvironment(body));
    }

    if (envId) {
      if (method === 'GET' && segments.length === 2) {
        const env = await core.getEnvironment(envId);
        if (!env) throw new SandboxError('NOT_FOUND', `no such environment: ${envId}`);
        return sendJson(res, 200, env);
      }
      if (method === 'DELETE' && segments.length === 2) {
        await core.destroyEnvironment(envId);
        res.writeHead(204).end();
        return;
      }
      if (method === 'POST' && segments[2] === 'exec') {
        const execReq = ExecRequestSchema.parse(await readJson(req));
        const { code, stdout, stderr } = await captureExec(await core.exec(envId, execReq));
        return sendJson(res, 200, { code, stdout: toBase64(stdout), stderr: toBase64(stderr) });
      }
      if (method === 'POST' && segments[2] === 'fs' && segments[3] === 'read') {
        const { path } = FsReadRequestSchema.parse(await readJson(req));
        return sendJson(res, 200, { data: toBase64(await core.fsRead(envId, path)) });
      }
      if (method === 'POST' && segments[2] === 'fs' && segments[3] === 'write') {
        const { path, data, mode } = FsWriteRequestSchema.parse(await readJson(req));
        await core.fsWrite(envId, path, fromBase64(data), mode);
        res.writeHead(204).end();
        return;
      }
      if (method === 'POST' && segments[2] === 'fs' && segments[3] === 'list') {
        const { path } = FsListRequestSchema.parse(await readJson(req));
        return sendJson(res, 200, { entries: await core.fsList(envId, path) });
      }
    }
  }

  throw new SandboxError('NOT_FOUND', `no route for ${method} ${url.pathname}`);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, err: unknown): void {
  let code: ErrorCode = 'INTERNAL';
  let message = 'internal error';
  if (err instanceof SandboxError) {
    code = err.code;
    message = err.message;
  } else if (err instanceof z.ZodError) {
    code = 'BAD_REQUEST';
    message = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  } else if (err instanceof SyntaxError) {
    code = 'BAD_REQUEST';
    message = 'invalid JSON body';
  } else if (err instanceof Error) {
    message = err.message;
  }
  if (res.headersSent) {
    res.end();
    return;
  }
  sendJson(res, ERROR_STATUS[code], { code, message });
}

server.listen(PORT, () => {
  console.log(`[${SERVICE}] listening on :${PORT}`);
});
