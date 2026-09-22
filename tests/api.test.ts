import { describe, expect, it, vi } from 'vitest';
import { fixtures } from '@/lib/contracts';
import { createDecisionHandlers, readBody, TokenBucket } from '@/server/http';
import { DemoSessions } from '@/server/sessions';
import { MemoryStore } from '@/server/store';
const key = '00000000-0000-4000-8000-000000000011';
const body = { id: fixtures[0]!.id, action: 'approve' };
const request = (data: unknown = body, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/decisions', {
    method: 'POST',
    headers: {
      origin: 'http://localhost',
      'content-type': 'application/json',
      'idempotency-key': key,
      ...headers,
    },
    body: JSON.stringify(data),
  });
const getRequest = (cookie = '') =>
  new Request('http://localhost/api/decisions', { headers: { cookie } });
function testHandlers(store = new MemoryStore()) {
  const sessions = new DemoSessions(() => store);
  const cookie = sessions.resolve(getRequest()).cookie!.split(';')[0]!;
  const handlers = createDecisionHandlers(sessions);
  return {
    GET: () => handlers.GET(getRequest(cookie)),
    POST: (req: Request) => {
      req.headers.set('cookie', cookie);
      return handlers.POST(req);
    },
  };
}
describe('review API boundary', () => {
  it('makes simultaneous double taps idempotent', async () => {
    const store = new MemoryStore();
    const api = testHandlers(store);
    const responses = await Promise.all([api.POST(request()), api.POST(request())]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const results = await Promise.all(responses.map((r) => r.json()));
    expect(results.map((r: { replayed: boolean }) => r.replayed).sort()).toEqual([false, true]);
    expect(store.snapshot().balance).toBe(11);
    expect(store.outbox()).toHaveLength(1);
  });
  it('returns authoritative current state on retry after an unrelated decision', async () => {
    const api = testHandlers();
    await api.POST(request());
    await api.POST(
      request(
        { id: fixtures[1]!.id, action: 'approve' },
        { 'idempotency-key': '00000000-0000-4000-8000-000000000012' },
      ),
    );
    expect(await (await api.POST(request())).json()).toMatchObject({
      replayed: true,
      snapshot: { balance: 10, revision: 2 },
    });
  });
  it('treats UUID key casing as the same idempotent operation', async () => {
    const api = testHandlers();
    const mixed = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
    await api.POST(request(body, { 'idempotency-key': mixed }));
    const response = await api.POST(request(body, { 'idempotency-key': mixed.toUpperCase() }));
    expect(await response.json()).toMatchObject({ replayed: true, snapshot: { balance: 11 } });
  });
  it('rejects conflicting key reuse', async () => {
    const api = testHandlers();
    await api.POST(request());
    expect((await api.POST(request({ ...body, action: 'reject' }))).status).toBe(409);
  });
  it.each([
    { id: 'bad', action: 'approve' },
    { ...body, action: 'publish' },
    { ...body, cost: 0 },
  ])('rejects unexpected payloads', async (data) => {
    expect((await testHandlers().POST(request(data))).status).toBe(400);
  });
  it('uses the HTTP Host when Next normalizes the internal request URL', async () => {
    const response = await testHandlers().POST(
      request(body, { host: '127.0.0.1:3100', origin: 'http://127.0.0.1:3100' }),
    );
    expect(response.status).toBe(200);
  });
  it('ignores a spoofed forwarded host', async () => {
    const response = await testHandlers().POST(
      request(body, { origin: 'https://example.com', 'x-forwarded-host': 'example.com' }),
    );
    expect(response.status).toBe(403);
  });
  it('requires a valid idempotency key', async () => {
    expect((await testHandlers().POST(request(body, { 'idempotency-key': '' }))).status).toBe(400);
  });
  it.each(['https://example.com', 'null', ''])(
    'rejects foreign or absent origin: %s',
    async (origin) => {
      expect((await testHandlers().POST(request(body, { origin }))).status).toBe(403);
    },
  );
  it('enforces content type and measured body size', async () => {
    const api = testHandlers();
    expect((await api.POST(request(body, { 'content-type': 'text/plain' }))).status).toBe(415);
    expect(
      (await api.POST(request({ data: 'x'.repeat(5000) }, { 'content-length': '1' }))).status,
    ).toBe(413);
  });
  it('does not cache queue responses', async () => {
    expect((await testHandlers().GET()).headers.get('cache-control')).toBe('no-store');
  });
  it('limits globally across different sessions and refills', async () => {
    let now = 0;
    const api = createDecisionHandlers(new DemoSessions(), new TokenBucket(1, 1, () => now));
    expect((await api.GET(getRequest())).status).toBe(200);
    const denied = await api.GET(getRequest());
    expect(denied.status).toBe(429);
    expect(denied.headers.get('retry-after')).toBe('1');
    now = 1000;
    expect((await api.GET(getRequest())).status).toBe(200);
  });
});

function visitor(api: ReturnType<typeof createDecisionHandlers>, cookie: string) {
  return {
    get: () => api.GET(getRequest(cookie)),
    post: (data: unknown = body, headers: Record<string, string> = {}) =>
      api.POST(request(data, { cookie, ...headers })),
    reset: () =>
      api.RESET(
        new Request('http://localhost/api/decisions/reset', {
          method: 'POST',
          headers: { cookie, origin: 'http://localhost' },
        }),
      ),
  };
}
async function connect(api: ReturnType<typeof createDecisionHandlers>) {
  const response = await api.GET(getRequest());
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  return { ...visitor(api, cookie), cookie, response };
}

describe('bounded visitor sessions', () => {
  it('isolates credits, decisions and idempotency receipts; resets only the caller', async () => {
    const api = createDecisionHandlers();
    const a = await connect(api);
    const b = await connect(api);
    expect(a.cookie).not.toBe(b.cookie);
    expect(a.response.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');
    expect((await a.get()).headers.get('set-cookie')).toBeNull();
    expect(await (await a.post()).json()).toMatchObject({
      snapshot: { balance: 11, revision: 1 },
      replayed: false,
    });
    expect(await (await b.get()).json()).toMatchObject({ balance: 12, revision: 0 });
    expect(await (await b.post()).json()).toMatchObject({ replayed: false });
    const reset = await (await a.reset()).json();
    expect(reset).toMatchObject({ balance: 12, revision: 2 });
    expect(reset.items.every((item: { status: string }) => item.status === 'pending')).toBe(true);
    expect(await (await b.get()).json()).toMatchObject({ balance: 11, revision: 1 });
    expect(await (await a.post()).json()).toMatchObject({
      replayed: false,
      snapshot: { balance: 11, revision: 3 },
    });
  });
  it('caps sessions, evicts the oldest even if read again, and never adopts a supplied ID', async () => {
    const sessions = new DemoSessions(undefined, 2);
    const api = createDecisionHandlers(sessions);
    const a = await connect(api);
    const b = await connect(api);
    await a.get();
    const c = await connect(api);
    expect(sessions.size).toBe(2);
    expect((await a.post()).status).toBe(409);
    expect((await b.post()).status).toBe(200);
    expect((await c.post()).status).toBe(200);
    const replacement = await a.get();
    expect(replacement.headers.get('set-cookie')).not.toContain(a.cookie);
    expect(replacement.headers.get('X-Demo-Session')).toBe('new');
    const supplied = await api.GET(getRequest('demo_session=attacker-selected'));
    expect(supplied.headers.get('set-cookie')).not.toContain('attacker-selected');
    expect(sessions.size).toBe(2);
  });
  it('sets Secure on HTTPS and requires an existing same-origin session for writes and resets', async () => {
    const api = createDecisionHandlers();
    expect(
      (await api.GET(new Request('https://localhost/api/decisions'))).headers.get('set-cookie'),
    ).toContain('; Secure');
    expect((await api.POST(request())).status).toBe(409);
    const a = await connect(api);
    expect(
      (
        await api.RESET(
          new Request('http://localhost/api/decisions/reset', {
            method: 'POST',
            headers: { cookie: a.cookie, origin: 'https://example.com' },
          }),
        )
      ).status,
    ).toBe(403);
  });
  it('keeps read and decision budgets separate per session and does not refill them on reset', async () => {
    let now = 0;
    const api = createDecisionHandlers(
      new DemoSessions(undefined, 100, () => now),
      new TokenBucket(200, 100, () => now),
    );
    const a = await connect(api);
    const b = await connect(api);
    for (let i = 0; i < 19; i++) expect((await a.get()).status).toBe(200);
    expect((await a.get()).status).toBe(429);
    expect((await a.post()).status).toBe(200);
    expect((await b.get()).status).toBe(200);
    for (let i = 0; i < 9; i++) expect((await a.reset()).status).toBe(200);
    expect((await a.reset()).status).toBe(429);
    expect((await b.post()).status).toBe(200);
    now = 1000;
    expect((await a.reset()).status).toBe(200);
    expect((await a.get()).status).toBe(200);
  });
});

function streamedRequest(stream: ReadableStream<Uint8Array>, cookie = '', signal?: AbortSignal) {
  return new Request('http://localhost/api/decisions', {
    method: 'POST',
    body: stream,
    duplex: 'half',
    headers: {
      cookie,
      origin: 'http://localhost',
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    ...(signal ? { signal } : {}),
  } as RequestInit);
}
describe('body deadlines and concurrent requests', () => {
  it('cancels a stalled body without waiting for cancellation to settle', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    await expect(
      readBody(streamedRequest(new ReadableStream({ cancel })), 4096, 20),
    ).rejects.toMatchObject({ status: 408 });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('uses a total deadline even when chunks keep arriving', async () => {
    vi.useFakeTimers();
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    try {
      const result = readBody(
        streamedRequest(
          new ReadableStream({
            start(c) {
              controller = c;
            },
            cancel,
          }),
        ),
        4096,
        100,
      );
      const rejected = expect(result).rejects.toMatchObject({ status: 408 });
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(20);
        controller!.enqueue(new Uint8Array([32]));
      }
      await vi.advanceTimersByTimeAsync(20);
      await rejected;
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it('cancels on client abort', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const result = readBody(streamedRequest(new ReadableStream({ cancel }), '', controller.signal));
    const rejected = expect(result).rejects.toMatchObject({ status: 408 });
    controller.abort();
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('bounds global in-flight reads and releases capacity after a timeout', async () => {
    const api = createDecisionHandlers(undefined, undefined, { maxInFlight: 1, bodyTimeoutMs: 20 });
    const a = await connect(api);
    const b = await connect(api);
    const pending = api.POST(streamedRequest(new ReadableStream(), a.cookie));
    expect((await b.post()).status).toBe(429);
    expect((await pending).status).toBe(408);
    expect((await b.post()).status).toBe(200);
  });
  it('bounds in-flight reads per session while another visitor can decide', async () => {
    const api = createDecisionHandlers(undefined, undefined, { bodyTimeoutMs: 30 });
    const a = await connect(api);
    const b = await connect(api);
    const pending = [1, 2].map(() => api.POST(streamedRequest(new ReadableStream(), a.cookie)));
    expect((await a.post()).status).toBe(429);
    expect((await b.post()).status).toBe(200);
    expect((await Promise.all(pending)).map((response) => response.status)).toEqual([408, 408]);
  });
  it('rejects a body started before its session was reset', async () => {
    const api = createDecisionHandlers();
    const a = await connect(api);
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const pending = api.POST(
      streamedRequest(
        new ReadableStream({
          start(c) {
            controller = c;
          },
        }),
        a.cookie,
      ),
    );
    expect((await a.reset()).status).toBe(200);
    controller!.enqueue(new TextEncoder().encode(JSON.stringify(body)));
    controller!.close();
    expect((await pending).status).toBe(409);
    expect(await (await a.get()).json()).toMatchObject({ balance: 12, revision: 1 });
  });
});
