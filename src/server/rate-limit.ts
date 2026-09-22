import 'server-only';

/** Fixed-size token bucket; callers bound the number of bucket instances. */
export class TokenBucket {
  private tokens: number;
  private updated: number;
  constructor(
    private readonly capacity = 30,
    private readonly perSecond = 2,
    private readonly now = Date.now,
  ) {
    if (capacity <= 0 || perSecond <= 0) throw new Error('Invalid bucket');
    this.tokens = capacity;
    this.updated = now();
  }
  take(): boolean {
    const time = this.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (Math.max(0, time - this.updated) / 1000) * this.perSecond,
    );
    this.updated = Math.max(time, this.updated);
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }
}
