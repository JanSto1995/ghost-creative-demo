import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createWebhookHandler, signatureFor, WebhookVerifier } from '@/server/webhook';
const key = randomBytes(32); // Ephemeral test material, never a service credential.
const id = '00000000-0000-4000-8000-000000000021';
const body = JSON.stringify({ id, type: 'demo.ping' });
const timestamp = '1800000000';
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Number(timestamp) * 1000);
});
afterEach(() => vi.useRealTimers());
describe('HMAC webhook verification', () => {
  it('accepts an authenticated body once', () => {
    const verifier = new WebhookVerifier(key);
    const signature = signatureFor(key, timestamp, body);
    expect(verifier.verify(body, timestamp, signature).id).toBe(id);
    expect(() => verifier.verify(body, timestamp, signature)).toThrow('Replay');
  });
  it('rejects body tampering, wrong keys and malformed signature lengths', () => {
    const verifier = new WebhookVerifier(key);
    expect(() =>
      verifier.verify(body + ' ', timestamp, signatureFor(key, timestamp, body)),
    ).toThrow('Invalid signature');
    expect(() =>
      verifier.verify(body, timestamp, signatureFor(randomBytes(32), timestamp, body)),
    ).toThrow('Invalid signature');
    for (const signature of ['', 'abc', 'g'.repeat(64), null])
      expect(() => verifier.verify(body, timestamp, signature)).toThrow('Invalid signature');
  });
  it.each([-301, 301])('rejects timestamps outside the window: %s seconds', (offset) => {
    const time = String(Number(timestamp) + offset);
    expect(() =>
      new WebhookVerifier(key).verify(body, time, signatureFor(key, time, body)),
    ).toThrow('Invalid signature');
  });
  it('keeps future-dated events reserved until the entire signature window expires', () => {
    const verifier = new WebhookVerifier(key);
    const future = String(Number(timestamp) + 300);
    const signature = signatureFor(key, future, body);
    verifier.verify(body, future, signature);
    vi.advanceTimersByTime(300_001);
    expect(() => verifier.verify(body, future, signature)).toThrow('Replay');
    vi.advanceTimersByTime(299_999);
    expect(() => verifier.verify(body, future, signature)).toThrow('Replay');
  });
  it('rejects a re-signed event id within the replay window', () => {
    const verifier = new WebhookVerifier(key);
    verifier.verify(body, timestamp, signatureFor(key, timestamp, body));
    vi.advanceTimersByTime(1000);
    const time = String(Number(timestamp) + 1);
    expect(() => verifier.verify(body, time, signatureFor(key, time, body))).toThrow('Replay');
  });
  it('canonicalizes signed event IDs before replay detection', () => {
    const verifier = new WebhookVerifier(key);
    const event = { id: 'abcdefab-cdef-4abc-8def-abcdefabcdef', type: 'demo.ping' };
    const first = JSON.stringify(event);
    verifier.verify(first, timestamp, signatureFor(key, timestamp, first));
    const repeated = JSON.stringify({ ...event, id: event.id.toUpperCase() });
    expect(() =>
      verifier.verify(repeated, timestamp, signatureFor(key, timestamp, repeated)),
    ).toThrow('Replay');
  });
  it('fails closed on replay capacity exhaustion', () => {
    const verifier = new WebhookVerifier(key, Date.now, 300_000, 1);
    verifier.verify(body, timestamp, signatureFor(key, timestamp, body));
    const next = JSON.stringify({ id: '00000000-0000-4000-8000-000000000022', type: 'demo.ping' });
    expect(() => verifier.verify(next, timestamp, signatureFor(key, timestamp, next))).toThrow(
      'Replay store full',
    );
  });
  it('validates signed payloads and only accepts the synthetic event type', async () => {
    const handler = createWebhookHandler(new WebhookVerifier(key));
    const invalid = JSON.stringify({ id, type: 'unknown' });
    const response = await handler(
      new Request('http://localhost/api/webhooks', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-demo-timestamp': timestamp,
          'x-demo-signature': signatureFor(key, timestamp, invalid),
        },
        body: invalid,
      }),
    );
    expect(response.status).toBe(400);
  });
  it('exercises the HTTP boundary including successful authentication', async () => {
    const handler = createWebhookHandler(new WebhookVerifier(key));
    const request = () =>
      new Request('http://localhost/api/webhooks', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-demo-timestamp': timestamp,
          'x-demo-signature': signatureFor(key, timestamp, body),
        },
        body,
      });
    expect((await handler(request())).status).toBe(200);
    expect((await handler(request())).status).toBe(409);
  });
});
