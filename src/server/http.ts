import 'server-only';
import { z } from 'zod';
import { decisionSchema, keySchema } from '@/lib/contracts';
import { DomainError } from './store';
import { DemoSessions, type DemoSession } from './sessions';
import { TokenBucket } from './rate-limit';
export { TokenBucket } from './rate-limit';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', ...(status === 429 ? { 'Retry-After': '1' } : {}) },
  });
}
/** Bound both bytes and total elapsed time, including a stalled stream. */
export async function readBody(
  request: Request,
  maxBytes = 4096,
  timeoutMs = 2000,
): Promise<string> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
    throw new HttpError(415, 'Expected JSON.');
  if (Number(request.headers.get('content-length')) > maxBytes)
    throw new HttpError(413, 'Request too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Missing body.');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  const deadline = new Promise<never>((_, reject) => {
    const stop = (error: HttpError) => {
      reject(error);
      // Cancellation is best-effort: a broken source must not hold up the response.
      void reader.cancel(error).catch(() => {});
    };
    abort = () => stop(new HttpError(408, 'Request aborted.'));
    timer = setTimeout(() => stop(new HttpError(408, 'Body read timed out.')), timeoutMs);
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
  });
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new HttpError(413, 'Request too large.');
      }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
export function sameOrigin(request: Request): void {
  const url = new URL(request.url);
  // Next normalizes the internal URL hostname. The HTTP Host is the browser's
  // actual authority; do not trust an arbitrary forwarded-host override.
  const authority = request.headers.get('host') ?? url.host;
  if (request.headers.get('origin') !== `${url.protocol}//${authority}`)
    throw new HttpError(403, 'Origin rejected.');
}
export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return json({ error: 'Invalid request.' }, 400);
  if (error instanceof DomainError)
    return json({ error: error.code }, error.code === 'not_found' ? 404 : 409);
  return json({ error: 'Request could not be completed.' }, 500);
}
export function createDecisionHandlers(
  sessions = new DemoSessions(),
  globalBucket = new TokenBucket(60, 10),
  { bodyTimeoutMs = 2000, maxInFlight = 16 } = {},
) {
  let inFlight = 0;
  const globalLimit = () => {
    if (!globalBucket.take()) throw new HttpError(429, 'Try again shortly.');
  };
  const existingSession = (request: Request): DemoSession => {
    const session = sessions.find(request);
    if (!session) throw new HttpError(409, 'Demo session expired. Reload the queue.');
    return session;
  };
  return {
    GET: async (request: Request) => {
      try {
        globalLimit();
        const { session, cookie } = sessions.resolve(request);
        if (!session.reads.take()) throw new HttpError(429, 'Try again shortly.');
        const response = json(session.store.snapshot());
        if (cookie) {
          response.headers.set('Set-Cookie', cookie);
          response.headers.set('X-Demo-Session', 'new');
        }
        return response;
      } catch (error) {
        return errorResponse(error);
      }
    },
    POST: async (request: Request) => {
      let active: DemoSession | undefined;
      try {
        globalLimit();
        sameOrigin(request);
        const session = existingSession(request);
        const generation = session.generation;
        const key = keySchema.parse(request.headers.get('idempotency-key'));
        if (inFlight >= maxInFlight || session.inFlight >= 2)
          throw new HttpError(429, 'Try again shortly.');
        active = session;
        inFlight++;
        session.inFlight++;
        const body: unknown = JSON.parse(await readBody(request, 4096, bodyTimeoutMs));
        const decision = decisionSchema.parse(body);
        if (sessions.find(request) !== session || session.generation !== generation)
          throw new HttpError(409, 'Demo session changed. Reload the queue.');
        if (!session.decisions.take()) throw new HttpError(429, 'Try again shortly.');
        return json(session.store.decide(decision, key));
      } catch (error) {
        return errorResponse(error);
      } finally {
        if (active) {
          active.inFlight--;
          inFlight--;
        }
      }
    },
    RESET: async (request: Request) => {
      try {
        globalLimit();
        sameOrigin(request);
        const session = existingSession(request);
        if (!session.decisions.take()) throw new HttpError(429, 'Try again shortly.');
        session.generation++;
        return json(session.store.reset());
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
