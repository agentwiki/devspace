import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  mapPullRequestWebhook,
  processWebhookDelivery,
  sameRepo,
  verifyWebhookSignature,
} from './webhooks.js';

const SECRET = 'wh-secret';

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('verifyWebhookSignature', () => {
  const body = '{"a":1}';

  it('accepts the correct HMAC over the raw body', () => {
    expect(verifyWebhookSignature(SECRET, body, sign(body))).toBe(true);
    expect(verifyWebhookSignature(SECRET, Buffer.from(body), sign(body))).toBe(true);
  });

  it('rejects a wrong secret, tampered body, or malformed header — never throws', () => {
    expect(verifyWebhookSignature(SECRET, body, sign(body, 'other'))).toBe(false);
    expect(verifyWebhookSignature(SECRET, '{"a":2}', sign(body))).toBe(false);
    expect(verifyWebhookSignature(SECRET, body, 'sha1=deadbeef')).toBe(false);
    expect(verifyWebhookSignature(SECRET, body, 'sha256=short')).toBe(false); // length mismatch
    expect(verifyWebhookSignature(SECRET, body, undefined)).toBe(false);
    expect(verifyWebhookSignature('', body, sign(body, ''))).toBe(false); // no secret = disabled
  });
});

describe('mapPullRequestWebhook', () => {
  const closedPayload = (merged: boolean) => ({
    action: 'closed',
    pull_request: { number: 42, merged, merged_at: merged ? '2026-01-01T00:00:00Z' : null },
    repository: {
      clone_url: 'https://github.com/acme/widgets.git',
      html_url: 'https://github.com/acme/widgets',
    },
  });

  it('maps closed+merged and closed-unmerged', () => {
    expect(mapPullRequestWebhook('pull_request', closedPayload(true))).toEqual({
      repoUrl: 'https://github.com/acme/widgets.git',
      prNumber: 42,
      outcome: 'merged',
    });
    expect(mapPullRequestWebhook('pull_request', closedPayload(false))).toMatchObject({
      outcome: 'closed',
    });
  });

  it('treats merged_at as authoritative when the merged flag is absent', () => {
    const payload = {
      action: 'closed',
      pull_request: { number: 7, merged_at: '2026-01-01T00:00:00Z' },
      repository: { html_url: 'https://github.com/a/b' },
    };
    expect(mapPullRequestWebhook('pull_request', payload)).toMatchObject({
      outcome: 'merged',
      repoUrl: 'https://github.com/a/b',
    });
  });

  it('maps everything else to null, never throwing', () => {
    expect(mapPullRequestWebhook('push', closedPayload(true))).toBeNull();
    expect(mapPullRequestWebhook('pull_request', { action: 'opened' })).toBeNull();
    expect(mapPullRequestWebhook('pull_request', { action: 'closed' })).toBeNull(); // no pr/repo
    expect(mapPullRequestWebhook('pull_request', 'junk')).toBeNull();
    expect(mapPullRequestWebhook(undefined, closedPayload(true))).toBeNull();
  });
});

describe('sameRepo', () => {
  it('matches across clone/html/ssh forms, case-insensitively', () => {
    expect(sameRepo('https://github.com/Acme/Widgets.git', 'https://github.com/acme/widgets')).toBe(
      true,
    );
    expect(sameRepo('git@github.com:acme/widgets.git', 'https://github.com/acme/widgets')).toBe(
      true,
    );
    expect(sameRepo('https://github.com/acme/widgets', 'https://github.com/acme/other')).toBe(
      false,
    );
    expect(sameRepo('not a url', 'https://github.com/a/b')).toBe(false);
  });
});

describe('processWebhookDelivery', () => {
  it('202s a signed pull_request delivery with the mapped result', () => {
    const body = JSON.stringify({
      action: 'closed',
      pull_request: { number: 9, merged: true },
      repository: { clone_url: 'https://github.com/a/b.git' },
    });
    const result = processWebhookDelivery({
      secret: SECRET,
      signatureHeader: sign(body),
      eventName: 'pull_request',
      rawBody: body,
    });
    expect(result.status).toBe(202);
    expect(result.mapped).toEqual({
      repoUrl: 'https://github.com/a/b.git',
      prNumber: 9,
      outcome: 'merged',
    });
  });

  it('202s a signed but un-actionable delivery with mapped: null', () => {
    const body = JSON.stringify({ zen: 'Design for failure.' });
    const result = processWebhookDelivery({
      secret: SECRET,
      signatureHeader: sign(body),
      eventName: 'ping',
      rawBody: body,
    });
    expect(result).toMatchObject({ status: 202, mapped: null });
  });

  it('401s a bad signature and 400s unparseable JSON', () => {
    const body = '{"a":1}';
    expect(
      processWebhookDelivery({
        secret: SECRET,
        signatureHeader: sign(body, 'wrong'),
        eventName: 'pull_request',
        rawBody: body,
      }),
    ).toMatchObject({ status: 401, mapped: null });

    const junk = 'not json';
    expect(
      processWebhookDelivery({
        secret: SECRET,
        signatureHeader: sign(junk),
        eventName: 'pull_request',
        rawBody: junk,
      }),
    ).toMatchObject({ status: 400, mapped: null });
  });
});
