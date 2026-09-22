import 'server-only';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from './store';
import { TokenBucket } from './rate-limit';

export const sessionCookie = 'demo_session';
export type DemoSession = {
  store: MemoryStore;
  reads: TokenBucket;
  decisions: TokenBucket;
  generation: number;
  inFlight: number;
};

/** Cookies select existing random IDs only; the map evicts by creation order. */
export class DemoSessions {
  private readonly entries = new Map<string, DemoSession>();
  constructor(
    private readonly createStore = () => new MemoryStore(),
    private readonly capacity = 100,
    private readonly now = Date.now,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid session limit');
  }
  get size() {
    return this.entries.size;
  }
  find(request: Request): DemoSession | undefined {
    const id = request.headers
      .get('cookie')
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${sessionCookie}=`))
      ?.slice(sessionCookie.length + 1);
    return id ? this.entries.get(id) : undefined;
  }
  resolve(request: Request): { session: DemoSession; cookie?: string } {
    const existing = this.find(request);
    if (existing) return { session: existing };
    if (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value!);
    const id = randomUUID();
    const session: DemoSession = {
      store: this.createStore(),
      reads: new TokenBucket(20, 2, this.now),
      decisions: new TokenBucket(10, 1, this.now),
      generation: 0,
      inFlight: 0,
    };
    this.entries.set(id, session);
    return {
      session,
      cookie: `${sessionCookie}=${id}; Path=/; HttpOnly; SameSite=Strict${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`,
    };
  }
}
