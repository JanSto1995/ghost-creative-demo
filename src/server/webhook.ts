import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { errorResponse, HttpError, json, readBody, TokenBucket } from './http';

const envelopeSchema = z
  .object({ id: z.string().uuid().toLowerCase(), type: z.literal('demo.ping') })
  .strict();
const timestampSchema = z.string().regex(/^\d{10}$/);
const signatureSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const signatureFor = (key: Uint8Array, timestamp: string, body: string) =>
  createHmac('sha256', key).update(`${timestamp}.${body}`).digest('hex');

export class WebhookVerifier {
  private readonly seen = new Map<string, number>();
  constructor(
    private readonly key: Uint8Array,
    private readonly now = Date.now,
    private readonly toleranceMs = 300_000,
    private readonly capacity = 1000,
  ) {
    if (key.byteLength < 32 || toleranceMs <= 0 || capacity < 1)
      throw new Error('Invalid verifier configuration');
  }
  verify(
    body: string,
    timestamp: string | null,
    signature: string | null,
  ): { id: string; type: 'demo.ping' } {
    const time = timestampSchema.safeParse(timestamp);
    const sig = signatureSchema.safeParse(signature);
    if (
      !time.success ||
      !sig.success ||
      Math.abs(this.now() - Number(time.data) * 1000) > this.toleranceMs
    )
      throw new HttpError(401, 'Invalid signature.');
    const expected = Buffer.from(signatureFor(this.key, time.data, body), 'hex');
    if (!timingSafeEqual(expected, Buffer.from(sig.data, 'hex')))
      throw new HttpError(401, 'Invalid signature.');
    const event = envelopeSchema.parse(JSON.parse(body) as unknown);
    for (const [id, expiry] of this.seen) if (expiry < this.now()) this.seen.delete(id);
    if (this.seen.has(event.id)) throw new HttpError(409, 'Replay rejected.');
    if (this.seen.size >= this.capacity) throw new HttpError(503, 'Replay store full.');
    // Future timestamps stay reserved through their entire acceptance window.
    this.seen.set(event.id, Number(time.data) * 1000 + this.toleranceMs);
    return event;
  }
}
export function createWebhookHandler(verifier: WebhookVerifier, bucket = new TokenBucket(10, 1)) {
  return async (request: Request) => {
    try {
      if (!bucket.take()) throw new HttpError(429, 'Try again shortly.');
      verifier.verify(
        await readBody(request),
        request.headers.get('x-demo-timestamp'),
        request.headers.get('x-demo-signature'),
      );
      return json({ accepted: true });
    } catch (error) {
      return errorResponse(error);
    }
  };
}
