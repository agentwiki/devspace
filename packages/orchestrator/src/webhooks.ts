/**
 * GitHub webhook ingress (M5) — the PR source of truth; the poll reconciler
 * is demoted to a drift backstop (top-risk #7: "webhooks as source of truth;
 * gh poll reconciliation").
 *
 * Everything here is pure and total: HMAC signature verification over the RAW
 * request body (constant-time, length-safe) and a defensive `pull_request`
 * payload mapping that returns null for anything it does not understand —
 * a malformed or novel webhook can never crash the endpoint. The svc glue
 * calls `processWebhookDelivery` and maps the result onto HTTP; the matched
 * work-unit publish lives on the Orchestrator (`handleGitHubWebhook`), reusing
 * the SAME idempotent bus topics as the reconciler, so webhook↔poll
 * double-delivery is a no-op by construction.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseOwnerRepo } from './git.js';

/** Verify GitHub's `X-Hub-Signature-256` over the raw body. Never throws. */
export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
): boolean {
  if (!secret || !signatureHeader?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = signatureHeader.slice('sha256='.length).toLowerCase();
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface MappedPrWebhook {
  repoUrl: string;
  prNumber: number;
  outcome: 'merged' | 'closed';
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Map a delivery onto the one transition webhooks drive: a `pull_request`
 * `closed` action (merged or not). Everything else — opens, syncs, reviews,
 * pings, junk — maps to null, never throws.
 */
export function mapPullRequestWebhook(
  eventName: string | undefined,
  payload: unknown,
): MappedPrWebhook | null {
  if (eventName !== 'pull_request') return null;
  const body = asRecord(payload);
  if (body.action !== 'closed') return null;

  const pr = asRecord(body.pull_request);
  const prNumber = typeof pr.number === 'number' ? pr.number : null;
  const repo = asRecord(body.repository);
  const repoUrl =
    typeof repo.clone_url === 'string'
      ? repo.clone_url
      : typeof repo.html_url === 'string'
        ? repo.html_url
        : null;
  if (prNumber === null || repoUrl === null) return null;

  const merged = pr.merged === true || (pr.merged_at !== null && pr.merged_at !== undefined);
  return { repoUrl, prNumber, outcome: merged ? 'merged' : 'closed' };
}

/**
 * Same repository? Compared by owner/repo (case-insensitive, `.git`-agnostic)
 * so a work unit's clone URL matches the webhook's html/clone URL.
 */
export function sameRepo(a: string, b: string): boolean {
  try {
    const ra = parseOwnerRepo(a);
    const rb = parseOwnerRepo(b);
    return (
      ra.owner.toLowerCase() === rb.owner.toLowerCase() &&
      ra.repo.toLowerCase() === rb.repo.toLowerCase()
    );
  } catch {
    return false;
  }
}

export interface WebhookDeliveryResult {
  status: 202 | 400 | 401;
  reason: string;
  /** Present on 202 when the delivery is one we act on. */
  mapped: MappedPrWebhook | null;
}

/**
 * The whole HTTP decision for one delivery, pure: verify → parse → map. The
 * svc glue turns this into a response and, when `mapped` is set, hands it to
 * `Orchestrator.handleGitHubWebhook`.
 */
export function processWebhookDelivery(input: {
  secret: string;
  signatureHeader: string | undefined;
  eventName: string | undefined;
  rawBody: Buffer | string;
}): WebhookDeliveryResult {
  if (!verifyWebhookSignature(input.secret, input.rawBody, input.signatureHeader)) {
    return { status: 401, reason: 'invalid signature', mapped: null };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody.toString());
  } catch {
    return { status: 400, reason: 'invalid JSON body', mapped: null };
  }
  return {
    status: 202,
    reason: 'accepted',
    mapped: mapPullRequestWebhook(input.eventName, payload),
  };
}
