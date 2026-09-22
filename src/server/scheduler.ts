import 'server-only';
import { MemoryStore, type Lease } from './store';

export type Job = {
  name: string;
  everyMs: number;
  run: (signal: AbortSignal, lease: Lease) => Promise<void>;
};
export class DeadManSwitch {
  private last: number;
  private reported = false;
  constructor(
    private readonly maxGapMs: number,
    private readonly alert: () => void,
    private readonly now = Date.now,
  ) {
    if (maxGapMs <= 0) throw new Error('Invalid threshold');
    this.last = now();
  }
  beat(): void {
    this.last = this.now();
    this.reported = false;
  }
  check(): boolean {
    const stale = this.now() - this.last >= this.maxGapMs;
    if (stale && !this.reported) {
      this.reported = true;
      this.alert();
    }
    return stale;
  }
}
export class TickScheduler {
  constructor(
    private readonly store: MemoryStore,
    private readonly owner: string,
    private readonly jobs: readonly Job[],
    private readonly monitor: DeadManSwitch,
    private readonly ttlMs = 3000,
    private readonly maxRunMs = 30_000,
  ) {
    if (
      !owner ||
      ttlMs < 3 ||
      maxRunMs <= 0 ||
      jobs.some((job) => !job.name || job.everyMs <= 0) ||
      new Set(jobs.map((job) => job.name)).size !== jobs.length
    )
      throw new Error('Invalid scheduler');
  }
  async tick(): Promise<('done' | 'busy' | 'failed')[]> {
    this.monitor.beat();
    return Promise.all(
      this.jobs.map(async (job) => {
        const lease = this.store.claimJob(job.name, this.owner, job.everyMs, this.ttlMs);
        if (!lease) return 'busy' as const;
        const controller = new AbortController();
        let lost = false;
        const heartbeat = setInterval(
          () => {
            try {
              this.store.heartbeat(lease, this.ttlMs);
            } catch {
              lost = true;
              controller.abort();
            }
          },
          Math.floor(this.ttlMs / 3),
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const deadline = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error('Job timed out'));
            }, this.maxRunMs);
          });
          await Promise.race([job.run(controller.signal, lease), deadline]);
          if (lost) throw new Error('Lease lost');
          this.store.completeJob(job.name, lease);
          return 'done' as const;
        } catch {
          try {
            this.store.release(lease);
          } catch {
            /* A newer owner holds the fence. */
          }
          return 'failed' as const;
        } finally {
          clearTimeout(timer);
          clearInterval(heartbeat);
          controller.abort();
        }
      }),
    );
  }
}
