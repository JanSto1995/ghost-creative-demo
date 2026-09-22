import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fixtures } from '@/lib/contracts';
import { MemoryStore } from '@/server/store';
const key = '00000000-0000-4000-8000-000000000011';
const otherKey = '00000000-0000-4000-8000-000000000012';
const id = fixtures[0]!.id;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
});
afterEach(() => vi.useRealTimers());
describe('atomic credits and fenced outbox', () => {
  it('commits a decision, one debit and one event together', () => {
    const store = new MemoryStore();
    expect(store.decide({ id, action: 'approve' }, key).snapshot.balance).toBe(11);
    expect(store.outbox()).toEqual([{ id: 1, amount: 1, balance: 11, delivered: false }]);
    expect(store.snapshot().items[0]?.status).toBe('approved');
  });
  it('rolls back status, receipt and event when funds are insufficient', () => {
    const store = new MemoryStore(0);
    expect(() => store.decide({ id, action: 'approve' }, key)).toThrow('insufficient');
    expect(store.snapshot()).toMatchObject({ balance: 0, revision: 0 });
    expect(store.snapshot().items[0]?.status).toBe('pending');
    expect(store.outbox()).toHaveLength(0);
    expect(store.decide({ id, action: 'reject' }, key).replayed).toBe(false);
  });
  it('replays a key but rejects reuse for a different payload', () => {
    const store = new MemoryStore();
    store.decide({ id, action: 'approve' }, key);
    expect(store.decide({ id, action: 'approve' }, key).replayed).toBe(true);
    expect(() => store.decide({ id, action: 'reject' }, key)).toThrow('conflict');
    expect(() => store.decide({ id, action: 'approve' }, otherKey)).toThrow('conflict');
    expect(store.outbox()).toHaveLength(1);
  });
  it('does not spend credits for rejection', () => {
    const store = new MemoryStore();
    store.decide({ id, action: 'reject' }, key);
    expect(store.snapshot().balance).toBe(12);
    expect(store.outbox()).toHaveLength(0);
  });
  it('canonicalizes UUID casing like PostgreSQL uuid columns', () => {
    const store = new MemoryStore();
    const lease = store.claim('credits', 'a', 100)!;
    const mixed = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
    expect(store.book(mixed, 1, lease)).toBe(true);
    expect(store.book(mixed.toUpperCase(), 1, lease)).toBe(false);
    expect(store.outbox()).toHaveLength(1);
  });
  it('protects internal state from caller mutation', () => {
    const store = new MemoryStore();
    store.snapshot().items[0]!.status = 'approved';
    expect(store.snapshot().items[0]?.status).toBe('pending');
  });
  it('fences expired debit workers and handles retries under the current lease', () => {
    const store = new MemoryStore();
    const first = store.claim('credits', 'worker-a', 100)!;
    expect(store.claim('credits', 'worker-b', 100)).toBeUndefined();
    store.book(key, 2, first);
    expect(store.book(key, 2, first)).toBe(false);
    expect(() => store.book(key, 3, first)).toThrow('conflict');
    vi.advanceTimersByTime(100);
    const second = store.claim('credits', 'worker-b', 100)!;
    expect(second.token).toBeGreaterThan(first.token);
    expect(() => store.book(otherKey, 1, first)).toThrow('stale');
    expect(() => store.heartbeat(first, 100)).toThrow('stale');
    expect(store.book(otherKey, 1, second)).toBe(true);
    expect(store.snapshot().balance).toBe(9);
  });
  it('does not accept a lease for the wrong resource or owner', () => {
    const store = new MemoryStore();
    const lease = store.claim('credits', 'a', 100)!;
    expect(() => store.book(key, 1, { ...lease, owner: 'b' })).toThrow('stale');
    expect(() => store.book(key, 1, { ...lease, resource: 'another' })).toThrow('stale');
    expect(store.snapshot().balance).toBe(12);
  });
  it('rejects invalid debits without creating an event', () => {
    const store = new MemoryStore();
    const lease = store.claim('credits', 'a', 100)!;
    for (const amount of [-1, 0, 1.5, NaN, Infinity, 13])
      expect(() => store.book(key, amount, lease)).toThrow();
    expect(store.outbox()).toHaveLength(0);
    expect(store.snapshot().balance).toBe(12);
  });
  it('redelivers after lease expiry and rejects stale acknowledgement', () => {
    const store = new MemoryStore();
    store.decide({ id, action: 'approve' }, key);
    const first = store.claimEvent('a', 100)!;
    expect(store.claimEvent('b', 100)).toBeUndefined();
    vi.advanceTimersByTime(100);
    const second = store.claimEvent('b', 100)!;
    expect(second.event.id).toBe(first.event.id);
    expect(second.lease.token).toBeGreaterThan(first.lease.token);
    expect(() => store.acknowledge(first.event.id, first.lease)).toThrow('stale');
    store.acknowledge(second.event.id, second.lease);
    expect(store.claimEvent('c', 100)).toBeUndefined();
  });
});
