import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeadManSwitch, TickScheduler } from '@/server/scheduler';
import { MemoryStore } from '@/server/store';
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
});
afterEach(() => vi.useRealTimers());
describe('tick scheduler and independent monitor', () => {
  it('runs due work once across overlapping ticks and respects the interval', async () => {
    const store = new MemoryStore();
    const run = vi.fn(async () => {});
    const monitor = new DeadManSwitch(5000, vi.fn());
    const jobs = [{ name: 'sample', everyMs: 1000, run }];
    const a = new TickScheduler(store, 'a', jobs, monitor);
    const b = new TickScheduler(store, 'b', jobs, monitor);
    await Promise.all([a.tick(), b.tick()]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await b.tick()).toEqual(['busy']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await b.tick()).toEqual(['done']);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('renews a lease while a long job is running', async () => {
    const store = new MemoryStore();
    const monitor = new DeadManSwitch(5000, vi.fn());
    const run = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 800)));
    const a = new TickScheduler(store, 'a', [{ name: 'slow', everyMs: 1000, run }], monitor, 300);
    const result = a.tick();
    await vi.advanceTimersByTimeAsync(600);
    expect(store.claim('job:slow', 'b', 300)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(await result).toEqual(['done']);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects stale completion after takeover', async () => {
    const store = new MemoryStore();
    const monitor = new DeadManSwitch(5000, vi.fn());
    let finish: (() => void) | undefined;
    const scheduler = new TickScheduler(
      store,
      'a',
      [
        {
          name: 'slow',
          everyMs: 1000,
          run: () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            }),
        },
      ],
      monitor,
      300,
    );
    const result = scheduler.tick();
    vi.setSystemTime(100_301); // Paused worker: clock moves, its heartbeat does not execute.
    const newer = store.claim('job:slow', 'b', 300)!;
    finish!();
    expect(await result).toEqual(['failed']);
    expect(() => store.completeJob('slow', newer)).not.toThrow();
  });
  it('retries failed work without waiting the success interval', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue(undefined);
    const scheduler = new TickScheduler(
      new MemoryStore(),
      'a',
      [{ name: 'retry', everyMs: 1000, run }],
      new DeadManSwitch(5000, vi.fn()),
    );
    expect(await scheduler.tick()).toEqual(['failed']);
    expect(await scheduler.tick()).toEqual(['done']);
  });
  it('aborts hung jobs and clears heartbeat timers', async () => {
    let signal: AbortSignal | undefined;
    const scheduler = new TickScheduler(
      new MemoryStore(),
      'a',
      [
        {
          name: 'hung',
          everyMs: 1000,
          run: (value) => {
            signal = value;
            return new Promise(() => {});
          },
        },
      ],
      new DeadManSwitch(5000, vi.fn()),
      300,
      600,
    );
    const result = scheduler.tick();
    await vi.advanceTimersByTimeAsync(600);
    expect(await result).toEqual(['failed']);
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('alerts once per outage even if no tick ever arrives, then rearms', () => {
    const alert = vi.fn();
    const monitor = new DeadManSwitch(1000, alert);
    vi.advanceTimersByTime(999);
    expect(monitor.check()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(monitor.check()).toBe(true);
    monitor.check();
    expect(alert).toHaveBeenCalledTimes(1);
    monitor.beat();
    expect(monitor.check()).toBe(false);
    vi.advanceTimersByTime(1000);
    monitor.check();
    expect(alert).toHaveBeenCalledTimes(2);
  });
});
